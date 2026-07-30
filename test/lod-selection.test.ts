import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  convertPreparedAsset,
  inspectGlbLodCatalog,
  inspectGltf,
  optimizeGltf,
  readAssimpScene,
  selectGlbLods,
  summarizeGlbLodSelection,
} from '../src/core/index.js';
import {
  lodLevelsThrough,
  reconcileLodLevels,
  sameLodLevels,
} from '../src/client/lib/lod-selection.js';

let prepared: Uint8Array;

function makePngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function makeTexturedLodGlb(): Uint8Array {
  const binary = new Uint8Array(48);
  binary.set(makePngHeader(256, 128), 0);
  binary.set(makePngHeader(64, 64), 24);
  const document = {
    asset: { version: '2.0' },
    accessors: [{ count: 300 }, { count: 100 }, { count: 30 }, { count: 10 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 24 },
      { buffer: 0, byteOffset: 24, byteLength: 24 },
    ],
    buffers: [{ byteLength: binary.byteLength }],
    images: [
      { bufferView: 0, mimeType: 'image/png' },
      { bufferView: 1, mimeType: 'image/png' },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      { normalTexture: { index: 1 } },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 1 }, indices: 0, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 3 }, indices: 2, material: 1 }] },
    ],
    nodes: [
      { mesh: 0, name: 'model' },
      { mesh: 1, name: 'model_LOD1' },
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
    textures: [{ source: 0 }, { source: 1 }],
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binary.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binary.byteLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

beforeAll(async () => {
  const cube = new Uint8Array(await readFile(resolve('test/fixtures/cube.glb')));
  prepared = (
    await optimizeGltf(cube, {
      generateLODs: 2,
      maxTextureSize: 8192,
    })
  ).data;
});

describe('prepared GLB LOD selection', () => {
  it('retains a non-contiguous set of requested levels', async () => {
    const selection = selectGlbLods({ name: 'cube.glb', data: prepared.slice() }, [0, 2]);

    expect(selection.availableLods).toEqual([0, 1, 2]);
    expect(selection.selectedLods).toEqual([0, 2]);
    expect(selection.changed).toBe(true);
    expect(selection.meshes).toBe(2);
    await expect(inspectGltf(selection.data)).resolves.toMatchObject({ meshes: 2 });
  });

  it('recomputes report totals from the selected LOD levels', () => {
    const catalog = inspectGlbLodCatalog({ name: 'cube.glb', data: prepared });
    const lod0 = summarizeGlbLodSelection(catalog, [0]);
    const lod2 = summarizeGlbLodSelection(catalog, [2]);
    const combined = summarizeGlbLodSelection(catalog, [0, 2]);

    expect(catalog.availableLods).toEqual([0, 1, 2]);
    expect(combined.selectedLods).toEqual([0, 2]);
    expect(combined.meshes).toBe(lod0.meshes + lod2.meshes);
    expect(combined.triangles).toBe(lod0.triangles + lod2.triangles);
    expect(combined.vertices).toBe(lod0.vertices + lod2.vertices);
    expect(combined.materials).toBeLessThanOrEqual(lod0.materials + lod2.materials);
  });

  it('recomputes texture count and maximum size from the selected LOD levels', () => {
    const catalog = inspectGlbLodCatalog({
      name: 'textured-lods.glb',
      data: makeTexturedLodGlb(),
    });

    expect(summarizeGlbLodSelection(catalog, [0])).toMatchObject({
      textures: 1,
      textureMaxSize: 256,
    });
    expect(summarizeGlbLodSelection(catalog, [1])).toMatchObject({
      textures: 1,
      textureMaxSize: 64,
    });
    expect(summarizeGlbLodSelection(catalog, [0, 1])).toMatchObject({
      textures: 2,
      textureMaxSize: 256,
    });
  });

  it('exports only the selected level through the prepared FBX path', async () => {
    const selection = selectGlbLods({ name: 'cube.glb', data: prepared.slice() }, [1]);
    const result = await convertPreparedAsset(
      { name: 'cube.glb', data: selection.data },
      {
        name: 'cube.glb',
        outputFormat: 'fbx',
        knownStats: {
          meshes: selection.meshes,
          materials: selection.materials,
          textures: 0,
          animations: 0,
          bones: 0,
          morphTargets: 0,
          triangles: selection.triangles,
          vertices: selection.vertices,
          textureMaxSize: 0,
        },
      },
    );

    const scene = await readAssimpScene(result.files);
    expect(scene.meshes).toHaveLength(1);
    expect(result.filename).toBe('cube.fbx');
  });

  it('rejects an empty LOD selection', () => {
    expect(() => selectGlbLods({ name: 'cube.glb', data: prepared.slice() }, [])).toThrow(
      'Select at least one available LOD',
    );
  });
});

describe('queue LOD selection state', () => {
  it('adds newly generated levels without losing existing per-file choices', () => {
    expect(reconcileLodLevels([0, 1], [1], lodLevelsThrough(3))).toEqual([1, 2, 3]);
  });

  it('compares normalized LOD sets', () => {
    expect(sameLodLevels([2, 0, 2], [0, 2])).toBe(true);
    expect(sameLodLevels([0, 1], [0, 2])).toBe(false);
  });
});
