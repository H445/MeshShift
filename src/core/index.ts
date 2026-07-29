/**
 * Public core API. Used by both the CLI and the web client.
 *
 *   import { convertGltfToFbx, convertBatch } from '@core';
 *
 * The conversion is a single hop: GLB → assimpjs (vendored repalash fork)
 * → FBX 7.4 binary. No three.js round-trip, no DOM shim, no extra steps.
 *
 *   - Works in Node and the browser
 *   - ~4 MB wasm payload, loaded once and cached
 *   - All material / texture / animation / skin data is preserved (assimp
 *     does the heavy lifting; we don't re-interpret the scene ourselves)
 */

import { exportFbx } from './exportFbx.js';
import { inspectGltf } from './inspect.js';
import { InputTooLargeError } from './errors.js';
import { makeProgress } from './progress.js';
import {
  DEFAULT_OPTIONS,
  type BatchFailure,
  type BatchItem,
  type BatchResult,
  type ConvertOptions,
  type ConvertStats,
  type ConvertWarning,
  type FbxResult,
} from '../shared/options.js';

export * from '../shared/options.js';
export * from './errors.js';
export { getAssimp } from './assimpLoader.js';
export { inspectGltf, inspectScene } from './inspect.js';
export { optimizeGltf, type OptimizeResult, type OptimizeChange } from './optimize.js';

const DEFAULT_MAX_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB

function suggestFilename(name: string): string {
  const base = name.replace(/\.(glb|gltf)$/i, '');
  return `${base}.fbx`;
}

function emptyStats(inputBytes: number): ConvertStats {
  return {
    meshes: 0,
    materials: 0,
    textures: 0,
    animations: 0,
    bones: 0,
    morphTargets: 0,
    triangles: 0,
    vertices: 0,
    textureMaxSize: 0,
    inputBytes,
    outputBytes: 0,
    durationMs: 0,
  };
}

/**
 * Convert a single GLB/GLTF to FBX.
 */
export async function convertGltfToFbx(
  data: ArrayBuffer | Uint8Array,
  options: ConvertOptions & { name?: string } = {},
): Promise<FbxResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const started = performance.now();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const inputBytes = bytes.byteLength;

  // `process` is undefined in the browser; guard the env-var lookup.
  const envMb =
    typeof process !== 'undefined' && process.env ? process.env.G2F_MAX_FILE_MB : undefined;
  const maxBytes = Number(envMb ?? DEFAULT_MAX_INPUT_BYTES / 1024 / 1024) * 1024 * 1024;
  if (inputBytes > maxBytes) {
    throw new InputTooLargeError(inputBytes, maxBytes);
  }

  const progress = makeProgress(opts);
  progress('parse', 0);

  // Inspect the input so we can surface accurate stats in the result.
  // This runs in parallel-ish with the export below; the assimp call is
  // already on its own microtask.
  const inspectPromise = inspectGltf(bytes).catch(() => null);

  // Single hop: bytes → assimpjs → FBX
  const fbxData = await exportFbx(bytes, options.name ?? 'model.glb', opts);
  progress('export', 1);

  const inspectResult = await inspectPromise;
  const stats: ConvertStats = {
    ...emptyStats(inputBytes),
    outputBytes: fbxData.byteLength,
    durationMs: performance.now() - started,
    meshes: inspectResult?.meshes ?? 0,
    materials: inspectResult?.materials ?? 0,
    textures: inspectResult?.textures ?? 0,
    animations: inspectResult?.animations ?? 0,
    bones: inspectResult?.bones ?? 0,
    morphTargets: inspectResult?.morphTargets ?? 0,
    triangles: inspectResult?.triangles ?? 0,
    vertices: inspectResult?.vertices ?? 0,
    textureMaxSize: inspectResult?.textureMaxSize ?? 0,
  };
  progress('inspect', 1);

  const warnings: ConvertWarning[] = [];
  if (fbxData.byteLength < 64) {
    warnings.push({
      phase: 'export',
      message: 'Output is unusually small — input may be empty or invalid.',
    });
  }

  return {
    data: fbxData,
    stats,
    warnings,
    filename: suggestFilename(options.name ?? 'model.glb'),
  };
}

export interface ConvertBatchOptions extends ConvertOptions {
  /** Concurrency cap (default 4). */
  maxConcurrency?: number;
}

/**
 * Bulk convert. Concurrency-capped `Promise.all`-style loop.
 * Works in both Node and the browser.
 */
export async function convertBatch(
  items: BatchItem[],
  options: ConvertBatchOptions = {},
  onItemProgress?: (itemIndex: number, phase: string, pct: number) => void,
): Promise<BatchResult> {
  const concurrency = Math.max(1, Math.min(8, options.maxConcurrency ?? 4));
  const succeeded: FbxResult[] = [];
  const failed: BatchFailure[] = [];
  // Map suggested output filename -> input index. The final sort uses
  // this to restore input order in `succeeded` and `failed` regardless
  // of completion order.
  const orderByOutputName = new Map<string, number>();
  const orderByInputName = new Map<string, number>();
  items.forEach((it, i) => {
    orderByInputName.set(it.name, i);
    const base = it.name.replace(/\.(glb|gltf)$/i, '');
    orderByOutputName.set(`${base}.fbx`, i);
  });

  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      try {
        const wrapped: ConvertOptions = {
          ...options,
          onProgress: (phase, pct) => onItemProgress?.(idx, phase, pct),
        };
        const result = await convertGltfToFbx(item.data, { ...wrapped, name: item.name });
        succeeded.push(result);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        failed.push({
          name: item.name,
          error: { name: e.name ?? 'Error', message: e.message ?? String(err) },
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);

  // Stable order: succeeded/failed in input order
  succeeded.sort((a, b) => {
    const ai = orderByOutputName.get(a.filename) ?? orderByInputName.get(a.filename) ?? 0;
    const bi = orderByOutputName.get(b.filename) ?? orderByInputName.get(b.filename) ?? 0;
    return ai - bi;
  });
  failed.sort((a, b) => {
    const ai = orderByInputName.get(a.name) ?? 0;
    const bi = orderByInputName.get(b.name) ?? 0;
    return ai - bi;
  });
  return { succeeded, failed };
}
