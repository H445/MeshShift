import { describe, expect, it } from 'vitest';
import { optimizationOptionsKey, usesOptimization } from '../src/client/lib/optimization-cache.js';
import type { ConvertOptions } from '../src/shared/options.js';

describe('optimized preview cache', () => {
  const optimized: ConvertOptions = {
    outputFormat: 'fbx',
    maxTextureSize: 2048,
    maxTriangles: 50_000,
    mergeByMaterial: true,
    generateLODs: 3,
    lodTriangleTargets: [20_000, 8_000, 2_000],
  };

  it('reuses an optimized model when only the output format changes', () => {
    const anotherExport: ConvertOptions = {
      ...optimized,
      outputFormat: 'obj',
    };

    expect(optimizationOptionsKey(anotherExport)).toBe(optimizationOptionsKey(optimized));
  });

  it.each([
    ['texture limit', { maxTextureSize: 1024 }],
    ['triangle limit', { maxTriangles: 25_000 }],
    ['material merging', { mergeByMaterial: false }],
    ['LOD count', { generateLODs: 2 }],
    ['LOD targets', { lodTriangleTargets: [18_000, 6_000, 1_000] }],
  ])('invalidates the optimized model when %s changes', (_label, change) => {
    expect(optimizationOptionsKey({ ...optimized, ...change })).not.toBe(
      optimizationOptionsKey(optimized),
    );
  });

  it('detects whether an optimization pass is needed', () => {
    expect(
      usesOptimization({
        maxTextureSize: 8192,
        maxTriangles: 0,
        mergeByMaterial: false,
        generateLODs: 0,
      }),
    ).toBe(false);
    expect(usesOptimization({ maxTextureSize: 2048 }, 2048)).toBe(false);
    expect(usesOptimization({ maxTextureSize: 2048 }, 4096)).toBe(true);
    expect(usesOptimization({ maxTextureSize: 8192, generateLODs: 1 })).toBe(true);
  });

  it('invalidates the optimized model when detail pins change', () => {
    const pin = {
      id: 'pin-a',
      meshKey: 'mesh-0',
      meshName: 'mesh',
      lodLevel: 1,
      position: [0, 1, 0] as [number, number, number],
    };
    expect(optimizationOptionsKey({ ...optimized, detailPins: [pin] })).not.toBe(
      optimizationOptionsKey(optimized),
    );
    expect(
      optimizationOptionsKey({
        ...optimized,
        detailPins: [pin, { ...pin, id: 'pin-b', position: [1, 0, 0] }],
      }),
    ).toBe(
      optimizationOptionsKey({
        ...optimized,
        detailPins: [{ ...pin, id: 'pin-b', position: [1, 0, 0] }, pin],
      }),
    );
  });
});
