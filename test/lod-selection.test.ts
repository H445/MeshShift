import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  convertPreparedAsset,
  inspectGltf,
  optimizeGltf,
  readAssimpScene,
  selectGlbLods,
} from '../src/core/index.js';
import {
  lodLevelsThrough,
  reconcileLodLevels,
  sameLodLevels,
} from '../src/client/lib/lod-selection.js';

let prepared: Uint8Array;

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
