import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAsset, getAssimp } from '../src/core/index.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = [
  'cube.glb',
  'animated-cube.glb',
  'skinned-cube.glb',
  'sphere.glb',
  'potion.glb',
  'item-bag.glb',
] as const;

async function expectAssimpParseable(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<void> {
  const assimp = await getAssimp();
  const list = new assimp.FileList();
  for (const file of files) list.AddFile(file.name, file.data);
  const parsed = assimp.ConvertFileList(list, 'assjson');
  expect(parsed.IsSuccess(), parsed.GetErrorCode()).toBe(true);
  const scene = JSON.parse(new TextDecoder().decode(parsed.GetFile(0).GetContent())) as {
    meshes?: unknown[];
  };
  expect(scene.meshes?.length ?? 0).toBeGreaterThan(0);
}

describe('committed fixture conversion corpus', () => {
  it.each(fixtures)('keeps %s structurally valid through FBX export', async (fixture) => {
    const input = new Uint8Array(readFileSync(resolve(fixturesDir, fixture)));
    const result = await convertAsset(input, { name: fixture, outputFormat: 'fbx' });

    expect(result.stats.meshes).toBeGreaterThan(0);
    expect(result.stats.triangles).toBeGreaterThan(0);
    expect(result.data.byteLength).toBeGreaterThan(64);
    await expectAssimpParseable(result.files);
  });

  it.each(fixtures)('keeps %s structurally valid through GLB export', async (fixture) => {
    const input = new Uint8Array(readFileSync(resolve(fixturesDir, fixture)));
    const result = await convertAsset(input, { name: fixture, outputFormat: 'glb' });

    expect(result.stats.meshes).toBeGreaterThan(0);
    expect(result.stats.triangles).toBeGreaterThan(0);
    expect(result.data.byteLength).toBeGreaterThan(64);
    await expectAssimpParseable(result.files);
  });
});
