import type { ConvertOptions } from '../../shared/options.js';

/**
 * Identify the settings that change the optimized GLB. Export-only settings
 * are intentionally excluded so one generated preview can feed many formats.
 */
export function optimizationOptionsKey(options: ConvertOptions): string {
  return JSON.stringify({
    targetEngine: options.targetEngine ?? 'auto',
    maxTextureSize: options.maxTextureSize ?? 2048,
    maxTriangles: options.maxTriangles ?? 0,
    mergeByMaterial: options.mergeByMaterial ?? false,
    generateLODs: options.generateLODs ?? 0,
    lodTriangleTargets: options.lodTriangleTargets ?? [],
  });
}

export function usesOptimization(options: ConvertOptions): boolean {
  return (
    (options.maxTriangles ?? 0) > 0 ||
    options.mergeByMaterial === true ||
    (options.generateLODs ?? 0) > 0 ||
    (options.maxTextureSize ?? 2048) < 8192
  );
}
