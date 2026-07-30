import type { AssetFile } from '../shared/options.js';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
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
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
}

export interface LodSelectionResult {
  /** The same prepared GLB buffer, with unselected node mesh references removed in place. */
  data: Uint8Array;
  /** LOD levels present in the prepared scene. */
  availableLods: number[];
  /** Requested levels that were present and retained. */
  selectedLods: number[];
  changed: boolean;
  meshes: number;
  materials: number;
  triangles: number;
  vertices: number;
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
      return {
        document: JSON.parse(text) as GltfDocument,
        jsonLength: chunkLength,
        jsonOffset: chunkOffset,
      };
    }
    offset = chunkOffset + chunkLength;
  }
  throw new Error('Prepared GLB does not contain a JSON chunk.');
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

/**
 * Retain selected LOD node meshes in a prepared GLB.
 *
 * This edits only the JSON chunk and deliberately leaves the binary chunk in
 * place. Downstream exporters see only retained scene nodes and rewrite their
 * output without the unreachable geometry. Callers must pass an owned buffer.
 */
export function selectGlbLods(file: AssetFile, requestedLevels: number[]): LodSelectionResult {
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  const { document, jsonLength, jsonOffset } = parseGlbJson(data);
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const accessors = document.accessors ?? [];
  const meshNodes = nodes.filter((node) => node.mesh !== undefined);
  if (meshNodes.length === 0) throw new Error('Prepared GLB does not contain mesh nodes.');

  const availableLods = normalizeLevels(meshNodes.map((node) => lodLevel(node.name)));
  const availableSet = new Set(availableLods);
  const selectedLods = normalizeLevels(requestedLevels).filter((level) => availableSet.has(level));
  if (selectedLods.length === 0) {
    throw new Error('Select at least one available LOD before exporting.');
  }
  const selectedSet = new Set(selectedLods);
  const materialSet = new Set<number>();
  let selectedMeshes = 0;
  let triangles = 0;
  let vertices = 0;
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

    const mesh = meshes[node.mesh!];
    if (!mesh) continue;
    selectedMeshes++;
    for (const primitive of mesh.primitives ?? []) {
      triangles += primitiveTriangles(primitive, accessors);
      const positionAccessor = primitive.attributes?.POSITION;
      if (positionAccessor !== undefined) {
        vertices += Math.max(0, accessors[positionAccessor]?.count ?? 0);
      }
      if (primitive.material !== undefined) materialSet.add(primitive.material);
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
    availableLods,
    selectedLods,
    changed,
    meshes: selectedMeshes,
    materials: materialSet.size,
    triangles,
    vertices,
  };
}
