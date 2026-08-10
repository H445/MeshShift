import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAsset } from '../src/core/index.js';

const cubePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cube.glb');

function nextRandom(state: { value: number }): number {
  state.value = (state.value * 1664525 + 1013904223) >>> 0;
  return state.value;
}

function mutateSeed(source: Uint8Array, iteration: number): Uint8Array {
  const state = { value: (0x13579bdf ^ iteration) >>> 0 };
  const output = source.slice();
  const mutations = 1 + (nextRandom(state) % 8);
  for (let index = 0; index < mutations; index++) {
    const offset = nextRandom(state) % output.length;
    output[offset] ^= 1 + (nextRandom(state) % 255);
  }
  return output;
}

describe('deterministic parser mutation corpus', () => {
  it('rejects or safely converts 64 mutated GLB inputs', async () => {
    const source = new Uint8Array(readFileSync(cubePath));

    for (let iteration = 0; iteration < 64; iteration++) {
      const candidate = mutateSeed(source, iteration);
      try {
        const result = await convertAsset(candidate, {
          name: `mutated-${iteration}.glb`,
          outputFormat: 'fbx',
        });
        expect(result.data.byteLength).toBeGreaterThan(64);
        for (const value of Object.values(result.stats)) expect(Number.isFinite(value)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  }, 30000);
});
