/**
 * Public format-agnostic conversion API shared by the CLI and web client.
 */
import { exportAsset, readAssimpScene, statsFromAssimpScene } from './exportAsset.js';
import { exportGltfToGlb, exportPreparedGlb } from './exportPrepared.js';
import { InputTooLargeError } from './errors.js';
import { inspectGltf } from './inspect.js';
import { makeProgress, throwIfAborted } from './progress.js';
import { requireOutputFormat } from './formats.js';
import {
  DEFAULT_OPTIONS,
  type AssetFile,
  type BatchFailure,
  type BatchItem,
  type BatchResult,
  type ConvertOptions,
  type ConvertResult,
  type ConvertStats,
  type ConvertWarning,
  type OutputFormat,
  MAX_INPUT_FILES,
  validateConvertOptions,
} from '../shared/options.js';

export * from '../shared/options.js';
export * from './errors.js';
export * from './formats.js';
export * from './lodSelection.js';
export { getAssimp } from './assimpLoader.js';
export { exportAsset, readAssimpScene, statsFromAssimpScene } from './exportAsset.js';
export { exportPreparedGlb } from './exportPrepared.js';
export { inspectGltf, inspectScene } from './inspect.js';
export { optimizeGltf, type OptimizeResult, type OptimizeChange } from './optimize.js';

export const DEFAULT_MAX_INPUT_BYTES = 200 * 1024 * 1024;

export function getMaxInputBytes(): number {
  const configuredMb =
    typeof process !== 'undefined' && process.env
      ? (process.env.MESHSHIFT_MAX_FILE_MB ?? process.env.G2F_MAX_FILE_MB)
      : undefined;
  if (configuredMb === undefined) return DEFAULT_MAX_INPUT_BYTES;
  const parsedMb = Number(configuredMb);
  const bytes = parsedMb * 1024 * 1024;
  return Number.isFinite(parsedMb) && Number.isSafeInteger(bytes) && parsedMb >= 0
    ? bytes
    : DEFAULT_MAX_INPUT_BYTES;
}

function validateAssetFiles(files: AssetFile[]): void {
  if (files.length > MAX_INPUT_FILES) {
    throw new RangeError(`An input bundle cannot contain more than ${MAX_INPUT_FILES} files.`);
  }
  for (const [index, file] of files.entries()) {
    if (!file || typeof file.name !== 'string' || file.name.trim().length === 0) {
      throw new TypeError(`Input file ${index + 1} must have a non-empty name.`);
    }
    const normalized = file.name.replace(/\\/g, '/');
    if (normalized.length > 4096) {
      throw new RangeError(`Input file name "${file.name.slice(0, 80)}…" is too long.`);
    }
    const segments = normalized.split('/');
    if (
      normalized.startsWith('/') ||
      /^[a-z]:/i.test(normalized) ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'),
      )
    ) {
      throw new TypeError(`Input file name "${file.name}" must be a safe relative path.`);
    }
    if (!(file.data instanceof ArrayBuffer || file.data instanceof Uint8Array)) {
      throw new TypeError(`Input file "${file.name}" must contain binary data.`);
    }
  }
}

function asAssetFiles(
  input: ArrayBuffer | Uint8Array | AssetFile | AssetFile[],
  fallbackName: string,
): AssetFile[] {
  if (Array.isArray(input)) return input;
  if (typeof input === 'object' && input !== null && 'name' in input && 'data' in input) {
    return [input as AssetFile];
  }
  return [{ name: fallbackName, data: input as ArrayBuffer | Uint8Array }];
}

function byteLength(file: AssetFile): number {
  return file.data.byteLength;
}

function statsFromGltfInspection(
  inspection: Awaited<ReturnType<typeof inspectGltf>>,
  inputBytes: number,
): ConvertStats {
  return {
    meshes: inspection.meshes,
    materials: inspection.materials,
    textures: inspection.textures,
    animations: inspection.animations,
    bones: inspection.bones,
    morphTargets: inspection.morphTargets,
    triangles: inspection.triangles,
    vertices: inspection.vertices,
    textureMaxSize: inspection.textureMaxSize,
    inputBytes,
    outputBytes: 0,
    durationMs: 0,
  };
}

export interface ConvertAssetOptions extends ConvertOptions {
  /** Name used for the output basename. For byte-only input it also selects the importer. */
  name?: string;
  /** Allow a trusted MeshShift-generated intermediate to exceed the external input limit. */
  allowOversizedInput?: boolean;
  /** Metadata already collected while producing a trusted intermediate. */
  knownStats?: Pick<
    ConvertStats,
    | 'meshes'
    | 'materials'
    | 'textures'
    | 'animations'
    | 'bones'
    | 'morphTargets'
    | 'triangles'
    | 'vertices'
    | 'textureMaxSize'
  >;
}

/**
 * Convert one 3D asset. Pass an AssetFile[] when the source has companion
 * resources such as .gltf + .bin or .obj + .mtl + textures.
 */
export async function convertAsset(
  input: ArrayBuffer | Uint8Array | AssetFile | AssetFile[],
  options: ConvertAssetOptions = {},
): Promise<ConvertResult> {
  validateConvertOptions(options);
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const format = opts.outputFormat as OutputFormat;
  const definition = requireOutputFormat(format);
  const fallbackName = options.name ?? 'model.glb';
  const files = asAssetFiles(input, fallbackName);
  if (files.length === 0) throw new TypeError('At least one input file is required.');
  validateAssetFiles(files);

  const primaryName = options.name ?? files[0].name;
  const inputBytes = files.reduce((sum, file) => sum + byteLength(file), 0);
  const maxBytes = getMaxInputBytes();
  if (!options.allowOversizedInput && inputBytes > maxBytes) {
    throw new InputTooLargeError(inputBytes, maxBytes);
  }

  const started = performance.now();
  const progress = makeProgress(opts);
  progress('parse', 0);
  const canInspectGltfDirectly =
    !options.knownStats &&
    definition.assimpId !== null &&
    files.length === 1 &&
    /\.(?:glb|gltf)$/i.test(files[0].name);
  let scene;
  let sourceStats: ConvertStats;
  if (options.knownStats) {
    sourceStats = {
      ...options.knownStats,
      inputBytes,
      outputBytes: 0,
      durationMs: 0,
    };
  } else if (canInspectGltfDirectly) {
    sourceStats = statsFromGltfInspection(await inspectGltf(files[0].data), inputBytes);
  } else {
    scene = await readAssimpScene(files);
    sourceStats = statsFromAssimpScene(scene, inputBytes);
  }
  progress('parse', 1);
  progress('inspect', 0.5);

  const selfContainedGltfToGlb =
    format === 'glb' && files.length === 1 && /\.(?:glb|gltf)$/i.test(files[0].name);
  const outputFiles = selfContainedGltfToGlb
    ? await exportGltfToGlb(files[0], primaryName, opts)
    : await exportAsset(files, primaryName, format, opts, scene);
  throwIfAborted(opts.signal);
  const primary =
    outputFiles.find((file) => file.name.toLowerCase().endsWith(`.${definition.extension}`)) ??
    outputFiles[0];
  const outputBytes = outputFiles.reduce((sum, file) => sum + file.data.byteLength, 0);
  const stats = {
    ...sourceStats,
    inputBytes,
    outputBytes,
    durationMs: performance.now() - started,
  };
  progress('inspect', 1);

  const warnings: ConvertWarning[] = [];
  if (primary.data.byteLength < 64) {
    warnings.push({
      phase: 'export',
      message: 'Primary output is unusually small — verify the source contains geometry.',
    });
  }
  if (format === 'obj' || format === 'stl' || format === 'ply' || format === 'dae') {
    if ((options.knownStats?.animations ?? scene?.animations?.length ?? 0) > 0) {
      warnings.push({
        phase: 'export',
        message: `${format.toUpperCase()} is a static mesh format; animation is not included.`,
      });
    }
  }

  return {
    data: primary.data,
    files: outputFiles,
    format,
    stats,
    warnings,
    filename: primary.name,
  };
}

/**
 * Export a GLB produced by MeshShift's own normalization/optimization pass.
 * Native formats go directly through Assimp, while static formats are written
 * from the glTF scene without creating a multi-gigabyte assjson intermediate.
 */
export async function convertPreparedAsset(
  file: AssetFile,
  options: ConvertAssetOptions & {
    knownStats: NonNullable<ConvertAssetOptions['knownStats']>;
  },
): Promise<ConvertResult> {
  validateConvertOptions(options);
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const format = opts.outputFormat as OutputFormat;
  if (format === 'fbx' || format === 'glb' || format === 'gltf') {
    return convertAsset(file, {
      ...options,
      allowOversizedInput: true,
      knownStats: options.knownStats,
    });
  }

  const definition = requireOutputFormat(format);
  const primaryName = options.name ?? file.name;
  const started = performance.now();
  throwIfAborted(opts.signal);
  const files = await exportPreparedGlb(file, primaryName, format, opts);
  const primary =
    files.find((output) => output.name.toLowerCase().endsWith(`.${definition.extension}`)) ??
    files[0];
  if (!primary) throw new Error('Prepared export produced no files.');
  const outputBytes = files.reduce((sum, output) => sum + output.data.byteLength, 0);
  const progress = makeProgress(opts);
  progress('inspect', 1);
  const warnings: ConvertWarning[] = [];
  if (options.knownStats.animations > 0) {
    warnings.push({
      phase: 'export',
      message: `${format.toUpperCase()} is a static mesh format; animation is not included.`,
    });
  }
  return {
    data: primary.data,
    files,
    format,
    stats: {
      ...options.knownStats,
      inputBytes: file.data.byteLength,
      outputBytes,
      durationMs: performance.now() - started,
    },
    warnings,
    filename: primary.name,
  };
}

/**
 * Backwards-compatible GLB/GLTF → FBX wrapper.
 */
export async function convertGltfToFbx(
  data: ArrayBuffer | Uint8Array,
  options: ConvertOptions & { name?: string } = {},
): Promise<ConvertResult> {
  return convertAsset(data, { ...options, outputFormat: 'fbx' });
}

export interface ConvertBatchOptions extends ConvertOptions {
  maxConcurrency?: number;
}

type IndexedBatchResult =
  { ok: true; result: ConvertResult } | { ok: false; failure: BatchFailure };

export async function convertBatch(
  items: BatchItem[],
  options: ConvertBatchOptions = {},
  onItemProgress?: (itemIndex: number, phase: string, pct: number) => void,
): Promise<BatchResult> {
  const requestedConcurrency = options.maxConcurrency ?? 4;
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(8, Math.floor(requestedConcurrency)))
    : 4;
  const results: Array<IndexedBatchResult | undefined> = new Array(items.length);

  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      try {
        const companionFiles = item.files ?? [];
        const files = companionFiles.some((file) => file.name === item.name)
          ? companionFiles
          : [{ name: item.name, data: item.data }, ...companionFiles];
        const result = await convertAsset(files, {
          ...options,
          name: item.name,
          onProgress: (phase, pct) => onItemProgress?.(index, phase, pct),
        });
        results[index] = { ok: true, result };
      } catch (error) {
        const detail = error as { name?: string; message?: string };
        results[index] = {
          ok: false,
          failure: {
            name: item.name,
            error: {
              name: detail.name ?? 'Error',
              message: detail.message ?? String(error),
            },
          },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  const succeeded: ConvertResult[] = [];
  const failed: BatchFailure[] = [];
  for (const result of results) {
    if (!result) continue;
    if (result.ok) succeeded.push(result.result);
    else failed.push(result.failure);
  }
  return { succeeded, failed };
}
