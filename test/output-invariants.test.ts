import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAsset } from '../src/core/index.js';
import { OUTPUT_FORMATS } from '../src/core/formats.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixtures, name)));
}

describe('release output invariants', () => {
  it.each(OUTPUT_FORMATS)('emits safe, finite statistics for %s', async (format) => {
    const result = await convertAsset(load('cube.glb'), {
      name: 'cube.glb',
      outputFormat: format.id,
    });

    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.every((file) => file.name.length > 0 && !file.name.includes('\\'))).toBe(
      true,
    );
    expect(result.files.every((file) => file.data.byteLength > 0)).toBe(true);
    expect(result.stats.inputBytes).toBeGreaterThan(0);
    expect(result.stats.outputBytes).toBeGreaterThan(0);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(result.stats)) expect(Number.isFinite(value)).toBe(true);
  });

  it('reports static-format animation loss explicitly', async () => {
    const result = await convertAsset(load('animated-cube.glb'), {
      name: 'animated-cube.glb',
      outputFormat: 'obj',
    });

    expect(result.warnings.some((warning) => warning.message.includes('static mesh format'))).toBe(
      true,
    );
  });
});
