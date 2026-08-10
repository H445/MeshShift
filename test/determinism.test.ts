import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAsset } from '../src/core/index.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixtures, name)));
}

function expectIdenticalFiles(
  left: Awaited<ReturnType<typeof convertAsset>>,
  right: Awaited<ReturnType<typeof convertAsset>>,
): void {
  expect(right.filename).toBe(left.filename);
  expect(right.files.map((file) => file.name)).toEqual(left.files.map((file) => file.name));
  expect({ ...right.stats, durationMs: 0 }).toEqual({ ...left.stats, durationMs: 0 });
  for (const [index, file] of left.files.entries()) {
    expect(Array.from(right.files[index].data)).toEqual(Array.from(file.data));
  }
}

describe('deterministic conversion output', () => {
  it('produces byte-identical FBX output for repeated identical inputs', async () => {
    const input = load('cube.glb');
    const options = { name: 'cube.glb', outputFormat: 'fbx' as const };
    const first = await convertAsset(input, options);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await convertAsset(input, options);

    expectIdenticalFiles(first, second);
  });

  it('produces byte-identical multi-file glTF output', async () => {
    const input = load('cube.glb');
    const options = { name: 'cube.glb', outputFormat: 'gltf' as const };
    const first = await convertAsset(input, options);
    const second = await convertAsset(input, options);

    expectIdenticalFiles(first, second);
  });

  it('keeps optimized output deterministic for identical options', async () => {
    const input = load('potion.glb');
    const options = {
      name: 'potion.glb',
      outputFormat: 'glb' as const,
      generateLODs: 2,
      maxTriangles: 400,
      maxTextureSize: 2048,
    };
    const first = await convertAsset(input, options);
    const second = await convertAsset(input, options);

    expectIdenticalFiles(first, second);
  });
});
