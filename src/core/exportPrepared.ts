import {
  Color,
  Matrix3,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
  Vector2,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { AssetFile, ConvertedFile, ConvertOptions, OutputFormat } from '../shared/options.js';
import { ExportError } from './errors.js';
import { outputFilename } from './formats.js';
import { makeProgress, throwIfAborted } from './progress.js';

const encoder = new TextEncoder();

function exactArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function loadPreparedGltf(data: ArrayBuffer | Uint8Array): Promise<{
  scene: import('three').Group;
  animations: import('three').AnimationClip[];
}> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      exactArrayBuffer(data),
      '',
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      (reason) => reject(reason instanceof Error ? reason : new Error(String(reason))),
    );
  });
}

function exportBinaryGltf(gltf: {
  scene: import('three').Object3D;
  animations: import('three').AnimationClip[];
}): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      gltf.scene,
      (result) => {
        if (!(result instanceof ArrayBuffer)) {
          reject(new ExportError('Self-contained glTF export did not produce a binary GLB.'));
          return;
        }
        resolve(new Uint8Array(result));
      },
      (reason) => reject(reason instanceof Error ? reason : new Error(String(reason))),
      { animations: gltf.animations, binary: true },
    );
  });
}

function safeName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^\w.-]+/g, '_');
  return cleaned || fallback;
}

type ExportMaterial = Material & {
  color?: Color;
  map?: Texture | null;
  normalMap?: Texture | null;
};

function sceneMaterials(scene: Object3D): ExportMaterial[] {
  const materials: ExportMaterial[] = [];
  const seen = new Set<Material>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (seen.has(material)) continue;
      seen.add(material);
      materials.push(material as ExportMaterial);
    }
  });
  materials.forEach((material, index) => {
    material.name = safeName(material.name || `material_${index}`, `material_${index}`);
  });
  return materials;
}

async function texturePng(texture: Texture): Promise<Uint8Array | null> {
  const image = texture.image as
    (CanvasImageSource & { width?: number; height?: number }) | undefined;
  const width = Math.floor(Number(image?.width) || 0);
  const height = Math.floor(Number(image?.height) || 0);
  if (!image || width <= 0 || height <= 0) return null;

  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);

  let blob: Blob | null;
  if ('convertToBlob' in canvas) {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function exportObjScene(scene: Object3D, primaryName: string): Promise<ConvertedFile[]> {
  const objName = outputFilename(primaryName, 'obj');
  const stem = objName.replace(/\.[^.]+$/, '');
  const mtlName = `${stem}.mtl`;
  const materials = sceneMaterials(scene);
  scene.updateMatrixWorld(true);
  const objText = `mtllib ${mtlName}\n${new OBJExporter().parse(scene)}`;
  const mtl: string[] = ['# MeshShift materials'];
  const textures: ConvertedFile[] = [];
  const textureNames = new Map<Texture, string>();

  const addTexture = async (
    material: ExportMaterial,
    texture: Texture | null | undefined,
    suffix: string,
  ): Promise<string | undefined> => {
    if (!texture) return undefined;
    const cached = textureNames.get(texture);
    if (cached) return cached;
    const data = await texturePng(texture);
    if (!data) return undefined;
    const name = `${stem}_${safeName(material.name, 'material')}_${suffix}.png`;
    textureNames.set(texture, name);
    textures.push({ name, data, mimeType: 'image/png' });
    return name;
  };

  for (const material of materials) {
    const color = material.color ?? new Color(0.8, 0.8, 0.8);
    const opacity = Number.isFinite(material.opacity) ? material.opacity! : 1;
    mtl.push(
      '',
      `newmtl ${material.name}`,
      `Kd ${color.r} ${color.g} ${color.b}`,
      `d ${opacity}`,
      'illum 2',
    );
    const colorMap = await addTexture(material, material.map, 'basecolor');
    const normalMap = await addTexture(material, material.normalMap, 'normal');
    if (colorMap) mtl.push(`map_Kd ${colorMap}`);
    if (normalMap) mtl.push(`map_Bump ${normalMap}`);
  }

  return [
    { name: objName, data: encoder.encode(objText), mimeType: 'model/obj' },
    { name: mtlName, data: encoder.encode(`${mtl.join('\n')}\n`), mimeType: 'text/plain' },
    ...textures,
  ];
}

function exportStlScene(scene: Object3D, primaryName: string): ConvertedFile[] {
  scene.updateMatrixWorld(true);
  const view = new STLExporter().parse(scene, { binary: true }) as DataView;
  const data = new Uint8Array(view.byteLength);
  data.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return [{ name: outputFilename(primaryName, 'stl'), data, mimeType: 'model/stl' }];
}

function exportPlyScene(scene: Object3D, primaryName: string): ConvertedFile[] {
  scene.updateMatrixWorld(true);
  const exporter = new PLYExporter() as unknown as {
    parse(
      object: Object3D,
      onDone: undefined,
      options: { binary: boolean; littleEndian: boolean },
    ): ArrayBuffer;
  };
  const result = exporter.parse(scene, undefined, { binary: true, littleEndian: true });
  return [
    {
      name: outputFilename(primaryName, 'ply'),
      data: new Uint8Array(result),
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

function joinedValues(count: number, values: (index: number) => number[]): string {
  const chunks: string[] = [];
  let current: string[] = [];
  for (let index = 0; index < count; index++) {
    current.push(values(index).join(' '));
    if (current.length >= 2048) {
      chunks.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks.join(' ');
}

function exportDaeScene(scene: Object3D, primaryName: string): ConvertedFile[] {
  scene.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position) meshes.push(mesh);
  });
  const materials = sceneMaterials(scene);
  const materialIndex = new Map<Material, number>(
    materials.map((material, index) => [material, index]),
  );
  const effects = materials
    .map((material, index) => {
      const color = material.color ?? new Color(0.8, 0.8, 0.8);
      const opacity = Number.isFinite(material.opacity) ? material.opacity! : 1;
      return `<effect id="effect_${index}"><profile_COMMON><technique sid="common"><phong><diffuse><color>${color.r} ${color.g} ${color.b} ${opacity}</color></diffuse></phong></technique></profile_COMMON></effect>`;
    })
    .join('');
  const materialLibrary = materials
    .map(
      (_, index) =>
        `<material id="material_${index}" name="material_${index}"><instance_effect url="#effect_${index}"/></material>`,
    )
    .join('');
  const point = new Vector3();
  const normal = new Vector3();
  const uv = new Vector2();
  const normalMatrix = new Matrix3();

  const geometries = meshes
    .map((mesh, meshIndex) => {
      const id = `geometry_${meshIndex}`;
      const position = mesh.geometry.attributes.position;
      const sourceNormal = mesh.geometry.attributes.normal;
      const sourceUv = mesh.geometry.attributes.uv;
      const index = mesh.geometry.index;
      normalMatrix.getNormalMatrix(mesh.matrixWorld);
      const positions = joinedValues(position.count, (vertex) => {
        point
          .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
          .applyMatrix4(mesh.matrixWorld);
        return [point.x, point.y, point.z];
      });
      const normals = sourceNormal
        ? joinedValues(sourceNormal.count, (vertex) => {
            normal
              .set(sourceNormal.getX(vertex), sourceNormal.getY(vertex), sourceNormal.getZ(vertex))
              .applyMatrix3(normalMatrix)
              .normalize();
            return [normal.x, normal.y, normal.z];
          })
        : '';
      const uvs = sourceUv
        ? joinedValues(sourceUv.count, (vertex) => {
            uv.set(sourceUv.getX(vertex), sourceUv.getY(vertex));
            return [uv.x, uv.y];
          })
        : '';
      const triangleCount = index ? index.count / 3 : position.count / 3;
      const packed = joinedValues(triangleCount, (triangle) => {
        const a = index ? index.getX(triangle * 3) : triangle * 3;
        const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
        const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
        const stride = 1 + Number(!!sourceNormal) + Number(!!sourceUv);
        return [a, b, c].flatMap((value) => Array.from({ length: stride }, () => value));
      });
      const normalSource = sourceNormal
        ? `<source id="${id}_normals"><float_array id="${id}_normals_array" count="${sourceNormal.count * 3}">${normals}</float_array><technique_common><accessor source="#${id}_normals_array" count="${sourceNormal.count}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`
        : '';
      const uvSource = sourceUv
        ? `<source id="${id}_uv"><float_array id="${id}_uv_array" count="${sourceUv.count * 2}">${uvs}</float_array><technique_common><accessor source="#${id}_uv_array" count="${sourceUv.count}" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>`
        : '';
      let offset = 1;
      const normalInput = sourceNormal
        ? `<input semantic="NORMAL" source="#${id}_normals" offset="${offset++}"/>`
        : '';
      const uvInput = sourceUv
        ? `<input semantic="TEXCOORD" source="#${id}_uv" offset="${offset}" set="0"/>`
        : '';
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const selectedMaterial = materialIndex.get(material) ?? 0;
      return `<geometry id="${id}" name="${escapeXml(mesh.name || `mesh_${meshIndex}`)}"><mesh><source id="${id}_positions"><float_array id="${id}_positions_array" count="${position.count * 3}">${positions}</float_array><technique_common><accessor source="#${id}_positions_array" count="${position.count}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>${normalSource}${uvSource}<vertices id="${id}_vertices"><input semantic="POSITION" source="#${id}_positions"/></vertices><triangles material="material_${selectedMaterial}" count="${triangleCount}"><input semantic="VERTEX" source="#${id}_vertices" offset="0"/>${normalInput}${uvInput}<p>${packed}</p></triangles></mesh></geometry>`;
    })
    .join('');
  const nodes = meshes
    .map((mesh, index) => {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const selectedMaterial = materialIndex.get(material) ?? 0;
      return `<node id="node_${index}" name="${escapeXml(mesh.name || `mesh_${index}`)}"><instance_geometry url="#geometry_${index}"><bind_material><technique_common><instance_material symbol="material_${selectedMaterial}" target="#material_${selectedMaterial}"/></technique_common></bind_material></instance_geometry></node>`;
    })
    .join('');
  const document =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">' +
    '<asset><contributor><authoring_tool>MeshShift</authoring_tool></contributor><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>' +
    `<library_effects>${effects}</library_effects><library_materials>${materialLibrary}</library_materials>` +
    `<library_geometries>${geometries}</library_geometries>` +
    `<library_visual_scenes><visual_scene id="Scene" name="Scene">${nodes}</visual_scene></library_visual_scenes>` +
    '<scene><instance_visual_scene url="#Scene"/></scene></COLLADA>';
  return [
    {
      name: outputFilename(primaryName, 'dae'),
      data: encoder.encode(document),
      mimeType: 'model/vnd.collada+xml',
    },
  ];
}

function disposeScene(scene: Object3D): void {
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose();
    if (!mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      materials.add(material);
      const record = material as unknown as Record<string, unknown>;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
        const texture = record[key];
        if (texture && typeof texture === 'object' && 'dispose' in texture) {
          textures.add(texture as Texture);
        }
      }
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
}

/**
 * Export a trusted prepared GLB without expanding it through Assimp's assjson
 * bridge. That JSON bridge can exceed the WebAssembly heap for multi-million
 * triangle LOD sets even though the GLB itself is valid.
 */
export async function exportPreparedGlb(
  file: AssetFile,
  primaryName: string,
  format: Extract<OutputFormat, 'obj' | 'stl' | 'ply' | 'dae'>,
  options?: ConvertOptions,
): Promise<ConvertedFile[]> {
  const progress = makeProgress(options);
  progress('parse', 0);
  const gltf = await loadPreparedGltf(file.data);
  progress('parse', 1);
  progress('export', 0);
  try {
    let files: ConvertedFile[];
    if (format === 'obj') files = await exportObjScene(gltf.scene, primaryName);
    else if (format === 'stl') files = exportStlScene(gltf.scene, primaryName);
    else if (format === 'ply') files = exportPlyScene(gltf.scene, primaryName);
    else files = exportDaeScene(gltf.scene, primaryName);
    progress('export', 1);
    return files;
  } finally {
    disposeScene(gltf.scene);
  }
}

/**
 * Export a self-contained glTF input through the three.js exporter so
 * attributes and scene semantics that Assimp's native GLB writer does not
 * round-trip (for example tangents and hierarchy transforms) remain intact.
 */
export async function exportGltfToGlb(
  file: AssetFile,
  primaryName: string,
  options?: ConvertOptions,
): Promise<ConvertedFile[]> {
  const progress = makeProgress(options);
  progress('parse', 0);
  const gltf = await loadPreparedGltf(file.data);
  throwIfAborted(options?.signal);
  progress('parse', 1);
  progress('export', 0);
  try {
    const data = await exportBinaryGltf(gltf);
    throwIfAborted(options?.signal);
    progress('export', 1);
    return [
      {
        name: outputFilename(primaryName, 'glb'),
        data,
        mimeType: 'model/gltf-binary',
      },
    ];
  } finally {
    disposeScene(gltf.scene);
  }
}
