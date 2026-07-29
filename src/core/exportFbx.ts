/**
 * Backwards-compatible FBX-only wrapper. New code should use exportAsset().
 */
import { exportAsset } from './exportAsset.js';
import type { ConvertOptions } from '../shared/options.js';

export async function exportFbx(
  sourceBytes: Uint8Array,
  sourceName: string,
  options?: ConvertOptions,
): Promise<Uint8Array> {
  const files = await exportAsset(
    [{ name: sourceName, data: sourceBytes }],
    sourceName,
    'fbx',
    options,
  );
  return files[0].data;
}
