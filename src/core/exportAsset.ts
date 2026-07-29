import { getAssimp, type AssimpInstance } from './assimpLoader.js';
import { ExportError, ParseError } from './errors.js';
import { outputFilename, requireOutputFormat } from './formats.js';
import type {
  AssetFile,
  ConvertedFile,
  ConvertOptions,
  ConvertStats,
  OutputFormat,
} from '../shared/options.js';
import { makeProgress } from './progress.js';

interface AssimpNode {
  name?: string;
  transformation?: number[];
  meshes?: number[];
  children?: AssimpNode[];
}

interface AssimpMaterialProperty {
  key?: string;
  semantic?: number;
  value?: unknown;
}

interface AssimpMaterial {
  properties?: AssimpMaterialProperty[];
}

interface AssimpMesh {
  name?: string;
  materialindex?: number;
  vertices?: number[];
  normals?: number[];
  texturecoords?: number[][];
  faces?: number[][];
  bones?: unknown[];
  animmeshes?: unknown[];
}

export interface AssimpScene {
  rootnode?: AssimpNode;
  meshes?: AssimpMesh[];
  materials?: AssimpMaterial[];
  textures?: Array<{
    width?: number;
    height?: number;
    formathint?: string;
    data?: string;
  }>;
  animations?: unknown[];
}

type Matrix4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

interface MeshInstance {
  mesh: AssimpMesh;
  name: string;
  matrix: Matrix4;
}

const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(file: AssetFile): Uint8Array {
  return file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
}

function addFiles(assimp: AssimpInstance, files: AssetFile[]) {
  const list = new assimp.FileList();
  for (const file of files) {
    list.AddFile(file.name.replace(/\\/g, '/'), bytesOf(file));
  }
  return list;
}

function convertWithAssimp(assimp: AssimpInstance, files: AssetFile[], target: string) {
  const result = assimp.ConvertFileList(addFiles(assimp, files), target);
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new ExportError(
      `Assimp ${target} conversion failed: ${result.GetErrorCode() || 'unknown error'}`,
    );
  }
  return result;
}

export async function readAssimpScene(files: AssetFile[]): Promise<AssimpScene> {
  const assimp = await getAssimp();
  let result;
  try {
    result = assimp.ConvertFileList(addFiles(assimp, files), 'assjson');
  } catch (error) {
    throw new ParseError((error as Error).message);
  }
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new ParseError(
      `Assimp could not read "${files[0]?.name ?? 'asset'}": ${result.GetErrorCode() || 'unknown error'}`,
    );
  }
  try {
    return JSON.parse(decoder.decode(result.GetFile(0).GetContent())) as AssimpScene;
  } catch (error) {
    throw new ParseError(`Assimp returned invalid scene data: ${(error as Error).message}`);
  }
}

function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const out = new Array<number>(16).fill(0) as Matrix4;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let k = 0; k < 4; k++) out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
    }
  }
  return out;
}

function asMatrix(values?: number[]): Matrix4 {
  return values?.length === 16 ? (values.slice() as Matrix4) : IDENTITY;
}

function transformPoint(
  matrix: Matrix4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
    matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
    matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
  ];
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function transformNormal(
  matrix: Matrix4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  // Assimp scenes usually contain rigid or uniform-scale node transforms.
  // The inverse-transpose below also handles non-uniform scale.
  const a = matrix[0],
    b = matrix[1],
    c = matrix[2];
  const d = matrix[4],
    e = matrix[5],
    f = matrix[6];
  const g = matrix[8],
    h = matrix[9],
    i = matrix[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return normalize(x, y, z);
  const inv = 1 / det;
  return normalize(
    ((e * i - f * h) * x + (f * g - d * i) * y + (d * h - e * g) * z) * inv,
    ((c * h - b * i) * x + (a * i - c * g) * y + (b * g - a * h) * z) * inv,
    ((b * f - c * e) * x + (c * d - a * f) * y + (a * e - b * d) * z) * inv,
  );
}

function safeName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^\w.-]+/g, '_');
  return cleaned || fallback;
}

function instances(scene: AssimpScene): MeshInstance[] {
  const meshes = scene.meshes ?? [];
  const result: MeshInstance[] = [];
  const visit = (node: AssimpNode, parent: Matrix4) => {
    const matrix = multiply(parent, asMatrix(node.transformation));
    for (const index of node.meshes ?? []) {
      const mesh = meshes[index];
      if (mesh) {
        result.push({
          mesh,
          matrix,
          name: safeName(mesh.name || node.name || `mesh_${index}`, `mesh_${index}`),
        });
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  if (scene.rootnode) visit(scene.rootnode, IDENTITY);
  if (result.length === 0) {
    meshes.forEach((mesh, index) =>
      result.push({
        mesh,
        matrix: IDENTITY,
        name: safeName(mesh.name || `mesh_${index}`, `mesh_${index}`),
      }),
    );
  }
  return result;
}

function materialColor(material?: AssimpMaterial): [number, number, number, number] {
  const property = material?.properties?.find(
    (item) => item.key === '$clr.base' || item.key === '$clr.diffuse',
  );
  const value = property?.value;
  return Array.isArray(value) && value.length >= 3
    ? [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3] ?? 1)]
    : [0.8, 0.8, 0.8, 1];
}

function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/\s+/g, '').replace(/=+$/, '');
  const output = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of clean) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return output.subarray(0, offset);
}

function textureReference(
  material: AssimpMaterial,
  semantics: number[],
  embeddedNames: string[],
): string | undefined {
  const property = material.properties?.find(
    (item) =>
      item.key === '$tex.file' &&
      semantics.includes(item.semantic ?? -1) &&
      typeof item.value === 'string',
  );
  const value = property?.value as string | undefined;
  if (!value) return undefined;
  const embedded = /^\*(\d+)$/.exec(value);
  if (embedded) return embeddedNames[Number(embedded[1])];
  const normalized = value.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

function exportObj(
  scene: AssimpScene,
  primaryName: string,
  sourceFiles: AssetFile[],
): ConvertedFile[] {
  const objName = outputFilename(primaryName, 'obj');
  const base = objName.slice(0, -4);
  const mtlName = `${base}.mtl`;
  const obj: string[] = ['# ModelShift OBJ', `mtllib ${mtlName}`];
  let offset = 1;

  instances(scene).forEach(({ mesh, matrix, name }, meshIndex) => {
    const vertices = mesh.vertices ?? [];
    const normals = mesh.normals ?? [];
    const texcoords = mesh.texturecoords?.[0] ?? [];
    const vertexCount = Math.floor(vertices.length / 3);
    obj.push('', `o ${name}`);
    for (let i = 0; i < vertexCount; i++) {
      const point = transformPoint(
        matrix,
        vertices[i * 3],
        vertices[i * 3 + 1],
        vertices[i * 3 + 2],
      );
      obj.push(`v ${point[0]} ${point[1]} ${point[2]}`);
    }
    for (let i = 0; i < vertexCount && i * 2 + 1 < texcoords.length; i++) {
      obj.push(`vt ${texcoords[i * 2]} ${texcoords[i * 2 + 1]}`);
    }
    for (let i = 0; i < vertexCount && i * 3 + 2 < normals.length; i++) {
      const normal = transformNormal(
        matrix,
        normals[i * 3],
        normals[i * 3 + 1],
        normals[i * 3 + 2],
      );
      obj.push(`vn ${normal[0]} ${normal[1]} ${normal[2]}`);
    }
    obj.push(`usemtl material_${mesh.materialindex ?? meshIndex}`);
    const hasUv = texcoords.length >= vertexCount * 2;
    const hasNormals = normals.length >= vertexCount * 3;
    for (const face of mesh.faces ?? []) {
      const indices = face.map((index) => {
        const value = offset + index;
        if (hasUv && hasNormals) return `${value}/${value}/${value}`;
        if (hasUv) return `${value}/${value}`;
        if (hasNormals) return `${value}//${value}`;
        return `${value}`;
      });
      if (indices.length >= 3) obj.push(`f ${indices.join(' ')}`);
    }
    offset += vertexCount;
  });

  const textureFiles: ConvertedFile[] = [];
  const embeddedNames = (scene.textures ?? []).map((texture, index) => {
    const extension = safeName(texture.formathint || 'bin', 'bin').toLowerCase();
    const name = `${base}_texture_${index}.${extension}`;
    if (texture.data) {
      textureFiles.push({ name, data: decodeBase64(texture.data), mimeType: mimeForName(name) });
    }
    return name;
  });
  const copied = new Set(textureFiles.map((file) => file.name.toLowerCase()));
  for (const source of sourceFiles) {
    if (!/\.(png|jpe?g|webp|bmp|tga|dds)$/i.test(source.name)) continue;
    const name = source.name.replace(/\\/g, '/').split('/').pop() ?? source.name;
    if (copied.has(name.toLowerCase())) continue;
    copied.add(name.toLowerCase());
    textureFiles.push({ name, data: bytesOf(source), mimeType: mimeForName(name) });
  }

  const mtl: string[] = ['# ModelShift materials'];
  (scene.materials ?? [{}]).forEach((material, index) => {
    const [r, g, b, a] = materialColor(material);
    mtl.push('', `newmtl material_${index}`, `Kd ${r} ${g} ${b}`, `d ${a}`, 'illum 2');
    const colorTexture = textureReference(material, [1, 12], embeddedNames);
    const normalTexture = textureReference(material, [5, 6, 13], embeddedNames);
    if (colorTexture) mtl.push(`map_Kd ${colorTexture}`);
    if (normalTexture) mtl.push(`map_Bump ${normalTexture}`);
  });
  return [
    { name: objName, data: encoder.encode(`${obj.join('\n')}\n`), mimeType: 'model/obj' },
    { name: mtlName, data: encoder.encode(`${mtl.join('\n')}\n`), mimeType: 'text/plain' },
    ...textureFiles,
  ];
}

function triangles(scene: AssimpScene) {
  const output: Array<
    [[number, number, number], [number, number, number], [number, number, number]]
  > = [];
  for (const { mesh, matrix } of instances(scene)) {
    const vertices = mesh.vertices ?? [];
    for (const face of mesh.faces ?? []) {
      for (let i = 1; i + 1 < face.length; i++) {
        const indices = [face[0], face[i], face[i + 1]];
        output.push(
          indices.map((index) =>
            transformPoint(
              matrix,
              vertices[index * 3],
              vertices[index * 3 + 1],
              vertices[index * 3 + 2],
            ),
          ) as [[number, number, number], [number, number, number], [number, number, number]],
        );
      }
    }
  }
  return output;
}

function exportStl(scene: AssimpScene, primaryName: string): ConvertedFile[] {
  const tris = triangles(scene);
  const data = new Uint8Array(84 + tris.length * 50);
  data.set(encoder.encode('ModelShift binary STL').slice(0, 80));
  const view = new DataView(data.buffer);
  view.setUint32(80, tris.length, true);
  let offset = 84;
  for (const [a, b, c] of tris) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = normalize(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    );
    for (const value of [...normal, ...a, ...b, ...c]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return [{ name: outputFilename(primaryName, 'stl'), data, mimeType: 'model/stl' }];
}

function exportPly(scene: AssimpScene, primaryName: string): ConvertedFile[] {
  const vertices: Array<[number, number, number]> = [];
  const faces: number[][] = [];
  for (const { mesh, matrix } of instances(scene)) {
    const source = mesh.vertices ?? [];
    const start = vertices.length;
    for (let index = 0; index + 2 < source.length; index += 3) {
      vertices.push(transformPoint(matrix, source[index], source[index + 1], source[index + 2]));
    }
    for (const face of mesh.faces ?? []) {
      if (face.length >= 3) faces.push(face.map((index) => start + index));
    }
  }
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment ModelShift',
    `element vertex ${vertices.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
    ...vertices.map((vertex) => vertex.join(' ')),
    ...faces.map((face) => `${face.length} ${face.join(' ')}`),
  ];
  return [
    {
      name: outputFilename(primaryName, 'ply'),
      data: encoder.encode(`${lines.join('\n')}\n`),
      mimeType: 'application/octet-stream',
    },
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function exportDae(scene: AssimpScene, primaryName: string): ConvertedFile[] {
  const meshInstances = instances(scene);
  const materials = scene.materials?.length ? scene.materials : [{}];
  const effects = materials
    .map((material, index) => {
      const [r, g, b, a] = materialColor(material);
      return `<effect id="effect_${index}"><profile_COMMON><technique sid="common"><phong><diffuse><color>${r} ${g} ${b} ${a}</color></diffuse></phong></technique></profile_COMMON></effect>`;
    })
    .join('');
  const materialLibrary = materials
    .map(
      (_, index) =>
        `<material id="material_${index}" name="material_${index}"><instance_effect url="#effect_${index}"/></material>`,
    )
    .join('');

  const geometryLibrary = meshInstances
    .map(({ mesh, matrix, name }, meshIndex) => {
      const id = `geometry_${meshIndex}`;
      const source = mesh.vertices ?? [];
      const sourceNormals = mesh.normals ?? [];
      const sourceUvs = mesh.texturecoords?.[0] ?? [];
      const vertexCount = Math.floor(source.length / 3);
      const positions: number[] = [];
      const normals: number[] = [];
      for (let index = 0; index < vertexCount; index++) {
        positions.push(
          ...transformPoint(
            matrix,
            source[index * 3],
            source[index * 3 + 1],
            source[index * 3 + 2],
          ),
        );
        if (sourceNormals.length >= vertexCount * 3) {
          normals.push(
            ...transformNormal(
              matrix,
              sourceNormals[index * 3],
              sourceNormals[index * 3 + 1],
              sourceNormals[index * 3 + 2],
            ),
          );
        }
      }
      const hasNormals = normals.length === vertexCount * 3;
      const hasUvs = sourceUvs.length >= vertexCount * 2;
      const triangleIndices: number[][] = [];
      for (const face of mesh.faces ?? []) {
        for (let index = 1; index + 1 < face.length; index++) {
          triangleIndices.push([face[0], face[index], face[index + 1]]);
        }
      }
      const stride = 1 + Number(hasNormals) + Number(hasUvs);
      const packed = triangleIndices
        .flatMap((triangle) =>
          triangle.flatMap((index) => Array.from({ length: stride }, () => index)),
        )
        .join(' ');
      const normalSource = hasNormals
        ? `<source id="${id}_normals"><float_array id="${id}_normals_array" count="${normals.length}">${normals.join(' ')}</float_array><technique_common><accessor source="#${id}_normals_array" count="${vertexCount}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`
        : '';
      const uvSource = hasUvs
        ? `<source id="${id}_uv"><float_array id="${id}_uv_array" count="${vertexCount * 2}">${sourceUvs.slice(0, vertexCount * 2).join(' ')}</float_array><technique_common><accessor source="#${id}_uv_array" count="${vertexCount}" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>`
        : '';
      let offset = 1;
      const normalInput = hasNormals
        ? `<input semantic="NORMAL" source="#${id}_normals" offset="${offset++}"/>`
        : '';
      const uvInput = hasUvs
        ? `<input semantic="TEXCOORD" source="#${id}_uv" offset="${offset}" set="0"/>`
        : '';
      const materialIndex = Math.min(mesh.materialindex ?? 0, materials.length - 1);
      return `<geometry id="${id}" name="${escapeXml(name)}"><mesh><source id="${id}_positions"><float_array id="${id}_positions_array" count="${positions.length}">${positions.join(' ')}</float_array><technique_common><accessor source="#${id}_positions_array" count="${vertexCount}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>${normalSource}${uvSource}<vertices id="${id}_vertices"><input semantic="POSITION" source="#${id}_positions"/></vertices><triangles material="material_${materialIndex}" count="${triangleIndices.length}"><input semantic="VERTEX" source="#${id}_vertices" offset="0"/>${normalInput}${uvInput}<p>${packed}</p></triangles></mesh></geometry>`;
    })
    .join('');

  const visualNodes = meshInstances
    .map(({ mesh, name }, index) => {
      const materialIndex = Math.min(mesh.materialindex ?? 0, materials.length - 1);
      return `<node id="node_${index}" name="${escapeXml(name)}"><instance_geometry url="#geometry_${index}"><bind_material><technique_common><instance_material symbol="material_${materialIndex}" target="#material_${materialIndex}"/></technique_common></bind_material></instance_geometry></node>`;
    })
    .join('');
  const document =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">' +
    '<asset><contributor><authoring_tool>ModelShift</authoring_tool></contributor><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>' +
    `<library_effects>${effects}</library_effects>` +
    `<library_materials>${materialLibrary}</library_materials>` +
    `<library_geometries>${geometryLibrary}</library_geometries>` +
    `<library_visual_scenes><visual_scene id="Scene" name="Scene">${visualNodes}</visual_scene></library_visual_scenes>` +
    '<scene><instance_visual_scene url="#Scene"/></scene></COLLADA>';
  return [
    {
      name: outputFilename(primaryName, 'dae'),
      data: encoder.encode(document),
      mimeType: 'model/vnd.collada+xml',
    },
  ];
}

function mimeForName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'gltf') return 'model/gltf+json';
  if (extension === 'glb') return 'model/gltf-binary';
  if (extension === 'bin') return 'application/octet-stream';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'dae') return 'model/vnd.collada+xml';
  return 'application/octet-stream';
}

function renameNativeOutputs(
  raw: Array<{ path: string; data: Uint8Array }>,
  primaryName: string,
  format: OutputFormat,
): ConvertedFile[] {
  const desiredPrimary = outputFilename(primaryName, format);
  const primaryExtension = `.${requireOutputFormat(format).extension}`;
  const primaryIndex = Math.max(
    0,
    raw.findIndex((file) => file.path.toLowerCase().endsWith(primaryExtension)),
  );
  const sourceBase =
    raw[primaryIndex].path.replace(/\\/g, '/').split('/').pop() ?? raw[primaryIndex].path;
  const sourceStem = sourceBase.replace(/\.[^.]+$/, '');
  const desiredStem = desiredPrimary.replace(/\.[^.]+$/, '');
  const rename = new Map<string, string>();
  raw.forEach((file, index) => {
    const leaf = file.path.replace(/\\/g, '/').split('/').pop() || `resource-${index}`;
    rename.set(
      leaf,
      index === primaryIndex ? desiredPrimary : leaf.replace(sourceStem, desiredStem),
    );
  });

  return raw.map((file, index) => {
    const oldLeaf = file.path.replace(/\\/g, '/').split('/').pop() || `resource-${index}`;
    const name = rename.get(oldLeaf) ?? oldLeaf;
    let data = file.data;
    if (index === primaryIndex && format === 'gltf') {
      try {
        const document = JSON.parse(decoder.decode(data)) as unknown;
        const replaceUris = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) {
            value.forEach(replaceUris);
            return;
          }
          const record = value as Record<string, unknown>;
          if (typeof record.uri === 'string' && rename.has(record.uri)) {
            record.uri = rename.get(record.uri);
          }
          Object.values(record).forEach(replaceUris);
        };
        replaceUris(document);
        data = encoder.encode(JSON.stringify(document));
      } catch {
        // Preserve Assimp's output if an exporter ever emits non-JSON content.
      }
    }
    return { name, data, mimeType: mimeForName(name) };
  });
}

export function statsFromAssimpScene(scene: AssimpScene, inputBytes: number): ConvertStats {
  const meshes = scene.meshes ?? [];
  return {
    meshes: meshes.length,
    materials: scene.materials?.length ?? 0,
    textures: scene.textures?.length ?? 0,
    animations: scene.animations?.length ?? 0,
    bones: meshes.reduce((sum, mesh) => sum + (mesh.bones?.length ?? 0), 0),
    morphTargets: meshes.reduce((sum, mesh) => sum + (mesh.animmeshes?.length ?? 0), 0),
    triangles: meshes.reduce(
      (sum, mesh) =>
        sum +
        (mesh.faces ?? []).reduce((faceSum, face) => faceSum + Math.max(0, face.length - 2), 0),
      0,
    ),
    vertices: meshes.reduce((sum, mesh) => sum + Math.floor((mesh.vertices?.length ?? 0) / 3), 0),
    textureMaxSize: 0,
    inputBytes,
    outputBytes: 0,
    durationMs: 0,
  };
}

export async function exportAsset(
  files: AssetFile[],
  primaryName: string,
  format: OutputFormat,
  options?: ConvertOptions,
  scene?: AssimpScene,
): Promise<ConvertedFile[]> {
  const progress = makeProgress(options);
  progress('export', 0);
  const definition = requireOutputFormat(format);
  let outputs: ConvertedFile[];

  if (definition.assimpId) {
    const assimp = await getAssimp();
    progress('export', 0.4);
    const result = convertWithAssimp(assimp, files, definition.assimpId);
    const raw = Array.from({ length: result.FileCount() }, (_, index) => {
      const file = result.GetFile(index);
      return { path: file.GetPath(), data: file.GetContent() };
    });
    outputs = renameNativeOutputs(raw, primaryName, format);
  } else {
    const normalized = scene ?? (await readAssimpScene(files));
    progress('export', 0.5);
    if (format === 'obj') outputs = exportObj(normalized, primaryName, files);
    else if (format === 'stl') outputs = exportStl(normalized, primaryName);
    else if (format === 'ply') outputs = exportPly(normalized, primaryName);
    else if (format === 'dae') outputs = exportDae(normalized, primaryName);
    else throw new ExportError(`No exporter is configured for ${format}.`);
  }

  progress('export', 1);
  return outputs;
}
