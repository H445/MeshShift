import type { AssetFile } from '../shared/options.js';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BINARY_CHUNK = 0x004e4942;
const LOD_SUFFIX = /_LOD(\d+)$/i;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface GltfAccessor {
  count?: number;
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfMesh {
  primitives?: GltfPrimitive[];
}

interface GltfNode {
  mesh?: number;
  name?: string;
  skin?: number;
  weights?: number[];
}

interface GltfDocument {
  accessors?: GltfAccessor[];
  bufferViews?: { byteLength?: number; byteOffset?: number }[];
  images?: { bufferView?: number; uri?: string }[];
  materials?: unknown[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  textures?: {
    source?: number;
    extensions?: Record<string, { source?: number }>;
  }[];
}

export interface GlbLodLevelStats {
  level: number;
  meshes: number;
  /** Material indices used by this level, retained so multi-level totals can be de-duplicated. */
  materialIndices: number[];
  /** Texture indices used by this level's materials. */
  textureIndices: number[];
  triangles: number;
  vertices: number;
}

export interface GlbLodCatalog {
  /** LOD levels present in the prepared scene. */
  availableLods: number[];
  levels: GlbLodLevelStats[];
  textureSizes: { index: number; width: number; height: number }[];
}

export interface GlbLodSelectionStats {
  availableLods: number[];
  /** Requested levels that were present and retained. */
  selectedLods: number[];
  meshes: number;
  materials: number;
  textures: number;
  textureMaxSize: number;
  triangles: number;
  vertices: number;
}

export interface LodSelectionResult extends GlbLodSelectionStats {
  /** The same prepared GLB buffer, with unselected node mesh references removed in place. */
  data: Uint8Array;
  changed: boolean;
}

function normalizeLevels(levels: number[]): number[] {
  return Array.from(
    new Set(
      levels
        .filter((level) => Number.isInteger(level) && level >= 0)
        .map((level) => Math.floor(level)),
    ),
  ).sort((a, b) => a - b);
}

function lodLevel(name: string | undefined): number {
  const match = name ? LOD_SUFFIX.exec(name) : null;
  return match ? Number(match[1]) : 0;
}

function parseGlbJson(data: Uint8Array): {
  document: GltfDocument;
  binaryLength: number;
  binaryOffset: number;
  jsonLength: number;
  jsonOffset: number;
} {
  if (data.byteLength < 20) throw new Error('Prepared GLB is too small.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error('LOD selection requires a binary glTF 2.0 asset.');
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength > data.byteLength) throw new Error('Prepared GLB is truncated.');

  let offset = 12;
  let document: GltfDocument | undefined;
  let jsonLength = 0;
  let jsonOffset = 0;
  let binaryLength = 0;
  let binaryOffset = 0;
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkOffset = offset + 8;
    if (chunkOffset + chunkLength > declaredLength) {
      throw new Error('Prepared GLB contains a truncated chunk.');
    }
    if (chunkType === GLB_JSON_CHUNK) {
      let text = decoder.decode(data.subarray(chunkOffset, chunkOffset + chunkLength));
      while (text.endsWith('\u0000')) text = text.slice(0, -1);
      document = JSON.parse(text) as GltfDocument;
      jsonLength = chunkLength;
      jsonOffset = chunkOffset;
    } else if (chunkType === GLB_BINARY_CHUNK) {
      binaryLength = chunkLength;
      binaryOffset = chunkOffset;
    }
    offset = chunkOffset + chunkLength;
  }
  if (!document) throw new Error('Prepared GLB does not contain a JSON chunk.');
  return { document, binaryLength, binaryOffset, jsonLength, jsonOffset };
}

function primitiveElementCount(primitive: GltfPrimitive, accessors: GltfAccessor[]): number {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  return accessorIndex === undefined ? 0 : Math.max(0, accessors[accessorIndex]?.count ?? 0);
}

function primitiveTriangles(primitive: GltfPrimitive, accessors: GltfAccessor[]): number {
  const count = primitiveElementCount(primitive, accessors);
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function materialTextureIndices(material: unknown): number[] {
  const indices = new Set<number>();
  function visit(value: unknown, propertyName = ''): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, propertyName);
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      propertyName.toLowerCase().includes('texture') &&
      Number.isInteger(object.index) &&
      Number(object.index) >= 0
    ) {
      indices.add(Number(object.index));
    }
    for (const [key, child] of Object.entries(object)) visit(child, key);
  }
  visit(material);
  return [...indices].sort((a, b) => a - b);
}

function textureImageIndex(
  texture: GltfDocument['textures'] extends (infer T)[] | undefined ? T : never,
): number | undefined {
  if (!texture) return undefined;
  if (Number.isInteger(texture.source) && Number(texture.source) >= 0) {
    return Number(texture.source);
  }
  for (const extension of Object.values(texture.extensions ?? {})) {
    if (Number.isInteger(extension.source) && Number(extension.source) >= 0) {
      return Number(extension.source);
    }
  }
  return undefined;
}

function embeddedImageBytes(
  data: Uint8Array,
  document: GltfDocument,
  binaryOffset: number,
  binaryLength: number,
  imageIndex: number,
): Uint8Array | undefined {
  const image = document.images?.[imageIndex];
  if (!image) return undefined;
  if (image.bufferView !== undefined && binaryLength > 0) {
    const view = document.bufferViews?.[image.bufferView];
    if (!view) return undefined;
    const offset = binaryOffset + Math.max(0, view.byteOffset ?? 0);
    const length = Math.max(0, view.byteLength ?? 0);
    if (offset + length <= binaryOffset + binaryLength && offset + length <= data.byteLength) {
      return data.subarray(offset, offset + length);
    }
  }
  if (image.uri?.startsWith('data:')) {
    const comma = image.uri.indexOf(',');
    if (comma < 0) return undefined;
    const metadata = image.uri.slice(0, comma);
    const payload = image.uri.slice(comma + 1);
    if (metadata.endsWith(';base64')) {
      const decoded = atob(payload);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      return bytes;
    }
  }
  return undefined;
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (
    bytes.length >= 28 &&
    bytes[0] === 0xab &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x58 &&
    bytes[5] === 0x32 &&
    bytes[6] === 0x30
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(20, true), height: view.getUint32(24, true) };
  }
  if (
    bytes.length >= 44 &&
    bytes[0] === 0xab &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x58 &&
    bytes[5] === 0x31 &&
    bytes[6] === 0x31
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const littleEndian = view.getUint32(12, true) === 0x04030201;
    return {
      width: view.getUint32(36, littleEndian),
      height: view.getUint32(40, littleEndian),
    };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        };
      }
      offset += length + 2;
    }
  }
  if (
    bytes.length >= 30 &&
    decoder.decode(bytes.subarray(0, 4)) === 'RIFF' &&
    decoder.decode(bytes.subarray(8, 12)) === 'WEBP'
  ) {
    const kind = decoder.decode(bytes.subarray(12, 16));
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
    if (kind === 'VP8 ' && bytes.length >= 30) {
      return {
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
    if (kind === 'VP8L' && bytes.length >= 25) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
  }
  return undefined;
}

function createGlbLodCatalog(
  data: Uint8Array,
  document: GltfDocument,
  binaryOffset: number,
  binaryLength: number,
): GlbLodCatalog {
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const accessors = document.accessors ?? [];
  const meshNodes = nodes.filter((node) => node.mesh !== undefined);
  if (meshNodes.length === 0) throw new Error('Prepared GLB does not contain mesh nodes.');

  const byLevel = new Map<
    number,
    {
      meshes: number;
      materialIndices: Set<number>;
      textureIndices: Set<number>;
      triangles: number;
      vertices: number;
    }
  >();
  for (const node of meshNodes) {
    const level = lodLevel(node.name);
    const stats = byLevel.get(level) ?? {
      meshes: 0,
      materialIndices: new Set<number>(),
      textureIndices: new Set<number>(),
      triangles: 0,
      vertices: 0,
    };
    const mesh = meshes[node.mesh!];
    if (mesh) {
      stats.meshes++;
      for (const primitive of mesh.primitives ?? []) {
        stats.triangles += primitiveTriangles(primitive, accessors);
        const positionAccessor = primitive.attributes?.POSITION;
        if (positionAccessor !== undefined) {
          stats.vertices += Math.max(0, accessors[positionAccessor]?.count ?? 0);
        }
        if (primitive.material !== undefined) {
          stats.materialIndices.add(primitive.material);
          for (const texture of materialTextureIndices(document.materials?.[primitive.material])) {
            stats.textureIndices.add(texture);
          }
        }
      }
    }
    byLevel.set(level, stats);
  }

  const availableLods = normalizeLevels([...byLevel.keys()]);
  return {
    availableLods,
    levels: availableLods.map((level) => {
      const stats = byLevel.get(level)!;
      return {
        level,
        meshes: stats.meshes,
        materialIndices: [...stats.materialIndices].sort((a, b) => a - b),
        textureIndices: [...stats.textureIndices].sort((a, b) => a - b),
        triangles: stats.triangles,
        vertices: stats.vertices,
      };
    }),
    textureSizes: (document.textures ?? []).map((texture, index) => {
      const imageIndex = textureImageIndex(texture);
      const dimensions =
        imageIndex === undefined
          ? undefined
          : imageDimensions(
              embeddedImageBytes(data, document, binaryOffset, binaryLength, imageIndex) ??
                new Uint8Array(),
            );
      return {
        index,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
      };
    }),
  };
}

/** Read per-level export metrics without copying or modifying the prepared GLB. */
export function inspectGlbLodCatalog(file: AssetFile): GlbLodCatalog {
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  const { document, binaryLength, binaryOffset } = parseGlbJson(data);
  return createGlbLodCatalog(data, document, binaryOffset, binaryLength);
}

/** Combine cached per-level metrics for the exact LOD set selected for export. */
export function summarizeGlbLodSelection(
  catalog: GlbLodCatalog,
  requestedLevels: number[],
): GlbLodSelectionStats {
  const availableSet = new Set(catalog.availableLods);
  const selectedLods = normalizeLevels(requestedLevels).filter((level) => availableSet.has(level));
  if (selectedLods.length === 0) {
    throw new Error('Select at least one available LOD before exporting.');
  }

  const selectedSet = new Set(selectedLods);
  const materialSet = new Set<number>();
  const textureSet = new Set<number>();
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  for (const level of catalog.levels) {
    if (!selectedSet.has(level.level)) continue;
    meshes += level.meshes;
    triangles += level.triangles;
    vertices += level.vertices;
    for (const material of level.materialIndices) materialSet.add(material);
    for (const texture of level.textureIndices) textureSet.add(texture);
  }
  const textureSizeByIndex = new Map(
    catalog.textureSizes.map((texture) => [texture.index, Math.max(texture.width, texture.height)]),
  );
  return {
    availableLods: [...catalog.availableLods],
    selectedLods,
    meshes,
    materials: materialSet.size,
    textures: textureSet.size,
    textureMaxSize: Math.max(
      0,
      ...[...textureSet].map((texture) => textureSizeByIndex.get(texture) ?? 0),
    ),
    triangles,
    vertices,
  };
}

/**
 * Retain selected LOD node meshes in a prepared GLB.
 *
 * This edits only the JSON chunk and deliberately leaves the binary chunk in
 * place. Downstream exporters see only retained scene nodes and rewrite their
 * output without the unreachable geometry. Callers must pass an owned buffer.
 */
export function selectGlbLods(file: AssetFile, requestedLevels: number[]): LodSelectionResult {
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  const { document, binaryLength, binaryOffset, jsonLength, jsonOffset } = parseGlbJson(data);
  const nodes = document.nodes ?? [];
  const meshNodes = nodes.filter((node) => node.mesh !== undefined);
  const selection = summarizeGlbLodSelection(
    createGlbLodCatalog(data, document, binaryOffset, binaryLength),
    requestedLevels,
  );
  const selectedSet = new Set(selection.selectedLods);
  let changed = false;

  for (const node of meshNodes) {
    const level = lodLevel(node.name);
    if (!selectedSet.has(level)) {
      delete node.mesh;
      delete node.skin;
      delete node.weights;
      changed = true;
      continue;
    }
  }

  if (changed) {
    const encoded = encoder.encode(JSON.stringify(document));
    if (encoded.byteLength > jsonLength) {
      throw new Error('Filtered LOD metadata no longer fits in the prepared GLB.');
    }
    const jsonChunk = data.subarray(jsonOffset, jsonOffset + jsonLength);
    jsonChunk.fill(0x20);
    jsonChunk.set(encoded);
  }

  return {
    data,
    ...selection,
    changed,
  };
}
