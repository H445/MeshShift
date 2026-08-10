import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAsset } from '../src/core/index.js';
import { readAssimpScene, type AssimpScene } from '../src/core/exportAsset.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = [
  'cube.glb',
  'animated-cube.glb',
  'skinned-cube.glb',
  'sphere.glb',
  'potion.glb',
  'item-bag.glb',
] as const;

function meshShape(scene: AssimpScene) {
  return (scene.meshes ?? []).map((mesh) => ({
    vertices: mesh.vertices?.length ?? 0,
    normals: mesh.normals?.length ?? 0,
    textureCoordinates: (mesh.texturecoords ?? []).map((channel) => channel.length),
    faces: (mesh.faces ?? []).map((face) => face.length),
  }));
}

function finiteValues(scene: AssimpScene): boolean {
  return (scene.meshes ?? []).every((mesh) =>
    [mesh.vertices ?? [], mesh.normals ?? [], ...(mesh.texturecoords ?? [])].every((values) =>
      values.every(Number.isFinite),
    ),
  );
}

describe('conversion fidelity invariants', () => {
  it.each(fixtures)('preserves topology and attribute cardinality for %s', async (fixture) => {
    const input = new Uint8Array(readFileSync(resolve(fixturesDir, fixture)));
    const source = await readAssimpScene([{ name: fixture, data: input }]);
    const result = await convertAsset(input, { name: fixture, outputFormat: 'fbx' });
    const roundTrip = await readAssimpScene(result.files);

    expect(finiteValues(source)).toBe(true);
    expect(finiteValues(roundTrip)).toBe(true);
    expect(meshShape(roundTrip)).toEqual(meshShape(source));
    expect(roundTrip.materials?.length ?? 0).toBeGreaterThan(0);
    expect(result.stats.triangles).toBe(
      (source.meshes ?? []).reduce((total, mesh) => total + (mesh.faces?.length ?? 0), 0),
    );
  });
});
