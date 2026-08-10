/**
 * Shared conversion options used by CLI, web, and core.
 * Keep this file framework-free so it can be imported anywhere.
 */

export type OutputFormat = 'fbx' | 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'dae';

/** A user-selected mesh point that must survive LOD simplification. */
export interface DetailPin {
  /** Stable UI identifier used for removal and marker rendering. */
  id: string;
  /** Stable optimizer mesh identifier embedded in generated previews. */
  meshKey: string;
  /** Human-readable mesh name shown in the pin list. */
  meshName: string;
  /** First LOD that must retain this point; every deeper level inherits it. */
  lodLevel: number;
  /** Point in the source mesh's local coordinate system. */
  position: [number, number, number];
}

export interface ConvertOptions {
  /** Output container/format. Default 'fbx' for backwards compatibility. */
  outputFormat?: OutputFormat;
  /** Resize textures above this size (px, longest edge). Default 2048. */
  maxTextureSize?: number;

  // --- Optimization (game-engine friendly) ---

  /** Hard cap on triangle count per mesh. Meshes above this are decimated.
   *  0 / undefined = no decimation. Default 0. */
  maxTriangles?: number;
  /** Merge meshes that share the same material into a single draw call.
   *  Default false. */
  mergeByMaterial?: boolean;
  /** Generate N LOD levels (LOD1..LODn) with progressively reduced triangles
   *  (quality-focused defaults keep deeper levels less aggressive). LOD0 is
   *  the original. 0 / undefined = no LODs.
   *  Default 0. */
  generateLODs?: number;
  /** Optional per-LOD triangle targets, one absolute target per mesh.
   *  Missing/zero entries use the quality-focused automatic targets. */
  lodTriangleTargets?: number[];
  /** Detail points locked from their selected LOD through every deeper level. */
  detailPins?: DetailPin[];

  /** Optional progress callback. */
  onProgress?: (phase: ConvertPhase, pct: number) => void;
  /** Abort signal checked between conversion phases and cooperative yields. */
  signal?: AbortSignal;
}

export const DEFAULT_OPTIONS: Required<Omit<ConvertOptions, 'onProgress' | 'signal'>> & {
  onProgress?: ConvertOptions['onProgress'];
  signal?: ConvertOptions['signal'];
} = {
  outputFormat: 'fbx',
  maxTextureSize: 2048,
  maxTriangles: 0,
  mergeByMaterial: false,
  generateLODs: 0,
  lodTriangleTargets: [],
  detailPins: [],
};

/** Quality-focused automatic targets as a fraction of source triangles. */
export const DEFAULT_LOD_TRIANGLE_RATIOS = [0.5, 0.3, 0.2, 0.12] as const;

/** Hard limits shared by every public conversion entry point. */
export const MAX_GENERATED_LODS = 8;
export const MAX_LOD_TARGETS = MAX_GENERATED_LODS;
export const MAX_DETAIL_PINS = 256;
export const MAX_TRIANGLE_BUDGET = 1_000_000_000;
export const MAX_TEXTURE_SIZE = 8_192;
export const MAX_INPUT_FILES = 4_096;

/**
 * Validate options at the public API boundary. Browser controls and the CLI
 * validate their own input, but the reusable API must not trust either caller.
 */
export function validateConvertOptions(options: ConvertOptions): void {
  if (options.outputFormat !== undefined && typeof options.outputFormat !== 'string') {
    throw new TypeError('outputFormat must be a string.');
  }
  if (options.maxTextureSize !== undefined) {
    if (
      !Number.isSafeInteger(options.maxTextureSize) ||
      options.maxTextureSize < 1 ||
      options.maxTextureSize > MAX_TEXTURE_SIZE
    ) {
      throw new RangeError(`maxTextureSize must be an integer from 1 to ${MAX_TEXTURE_SIZE}.`);
    }
  }
  if (options.maxTriangles !== undefined) {
    if (
      !Number.isSafeInteger(options.maxTriangles) ||
      options.maxTriangles < 0 ||
      options.maxTriangles > MAX_TRIANGLE_BUDGET
    ) {
      throw new RangeError(
        `maxTriangles must be an integer from 0 to ${MAX_TRIANGLE_BUDGET.toLocaleString()}.`,
      );
    }
  }
  if (options.generateLODs !== undefined) {
    if (
      !Number.isSafeInteger(options.generateLODs) ||
      options.generateLODs < 0 ||
      options.generateLODs > MAX_GENERATED_LODS
    ) {
      throw new RangeError(`generateLODs must be an integer from 0 to ${MAX_GENERATED_LODS}.`);
    }
  }
  if (options.lodTriangleTargets !== undefined) {
    if (options.lodTriangleTargets.length > MAX_LOD_TARGETS) {
      throw new RangeError(
        `lodTriangleTargets cannot contain more than ${MAX_LOD_TARGETS} entries.`,
      );
    }
    options.lodTriangleTargets.forEach((target, index) => {
      if (!Number.isSafeInteger(target) || target < 0 || target > MAX_TRIANGLE_BUDGET) {
        throw new RangeError(
          `lodTriangleTargets[${index}] must be an integer from 0 to ${MAX_TRIANGLE_BUDGET.toLocaleString()}.`,
        );
      }
    });
  }
  if (options.detailPins !== undefined) {
    if (options.detailPins.length > MAX_DETAIL_PINS) {
      throw new RangeError(`detailPins cannot contain more than ${MAX_DETAIL_PINS} entries.`);
    }
    for (const [index, pin] of options.detailPins.entries()) {
      if (
        !pin ||
        typeof pin.id !== 'string' ||
        typeof pin.meshKey !== 'string' ||
        typeof pin.meshName !== 'string' ||
        pin.id.length === 0 ||
        pin.meshKey.length === 0 ||
        pin.meshName.length === 0
      ) {
        throw new TypeError(`detailPins[${index}] must contain non-empty identifiers and names.`);
      }
      if (
        !Number.isSafeInteger(pin.lodLevel) ||
        pin.lodLevel < 0 ||
        pin.lodLevel > MAX_GENERATED_LODS ||
        pin.position.length !== 3 ||
        pin.position.some((value) => !Number.isFinite(value))
      ) {
        throw new RangeError(`detailPins[${index}] contains an invalid LOD level or position.`);
      }
    }
  }
}

/**
 * Keep the deepest automatic LOD useful for both small props and very dense
 * scans.  A ratio-only target plateaus on UV-seamed meshes long before it
 * reaches a genuinely low-poly representation (a 1.8M-triangle scan would
 * otherwise still target roughly 226K triangles at LOD4).  Explicit profile
 * targets continue to take precedence over this cap.
 */
export const DEFAULT_DEEPEST_LOD_TRIANGLE_CAP = 450;

export type ConvertPhase =
  | 'parse'
  | 'inspect'
  | 'optimize'
  | 'textures'
  | 'materials'
  | 'skeleton'
  | 'animation'
  | 'export'
  | 'post';

export interface ConvertStats {
  meshes: number;
  materials: number;
  textures: number;
  animations: number;
  bones: number;
  morphTargets: number;
  /** Sum of triangle indices across all meshes (count of /3 indexed). */
  triangles: number;
  /** Sum of vertex count across all meshes (after any decimation). */
  vertices: number;
  /** Largest texture dimension found in the source. */
  textureMaxSize: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
}

export interface ConvertWarning {
  phase: ConvertPhase;
  message: string;
}

export interface AssetFile {
  /** Relative path presented to the importer. Extensions select the importer. */
  name: string;
  data: ArrayBuffer | Uint8Array;
}

export interface ConvertedFile {
  name: string;
  data: Uint8Array;
  mimeType: string;
}

export interface ConvertResult {
  /** Primary output file. Retained as a convenience for single-file formats. */
  data: Uint8Array;
  /** Every generated file, including glTF/OBJ companion resources. */
  files: ConvertedFile[];
  format: OutputFormat;
  stats: ConvertStats;
  warnings: ConvertWarning[];
  filename: string;
  /** LOD levels retained when a prepared browser export is filtered. */
  lodLevels?: number[];
}

/** @deprecated Use ConvertResult. */
export type FbxResult = ConvertResult;

export interface BatchItem {
  name: string; // original filename, used to derive output name
  data: ArrayBuffer | Uint8Array;
  /** Optional sidecars (for example .bin, .mtl, and texture files). */
  files?: AssetFile[];
}

export interface BatchFailure {
  name: string;
  error: { name: string; message: string };
}

export interface BatchResult {
  succeeded: ConvertResult[];
  failed: BatchFailure[];
}

/**
 * Lightweight scene metadata extracted by inspectGltf() without going
 * through the full conversion. Used by the queue row to show file stats.
 */
export interface InspectResult {
  meshes: number;
  materials: number;
  textures: number;
  /** Largest texture dimension (longest edge, px). */
  textureMaxSize: number;
  /** Per-texture info for the detail view. */
  textureList: { name: string; width: number; height: number }[];
  animations: number;
  bones: number;
  morphTargets: number;
  triangles: number;
  vertices: number;
  hasSkin: boolean;
  hasMorph: boolean;
  /** Bounding box minimum in local space. */
  bboxMin: [number, number, number];
  /** Bounding box maximum in local space. */
  bboxMax: [number, number, number];
  /** Bounding box size (max - min). */
  bboxSize: [number, number, number];
}
