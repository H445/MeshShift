/**
 * Shared conversion options used by CLI, web, and core.
 * Keep this file framework-free so it can be imported anywhere.
 */

export type AxisUp = 'y-up' | 'z-up';

export type AnimationFilter = 'all' | 'skeletal' | 'none';

/** Target game engine preset. Drives defaults for axis, texture size, etc. */
export type TargetEngine = 'auto' | 'unity' | 'unreal' | 'godot';

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
  /** Embed textures where the selected output supports it. Default true. */
  embedTextures?: boolean;
  /** Uniform scale applied to the root. Default 1. */
  scale?: number;
  /** Output axis convention. Default 'y-up' (three.js native). */
  axis?: AxisUp;
  /** Which animations to export. Default 'all'. */
  animationFilter?: AnimationFilter;
  /** Export morph targets (blend shapes). Default true. */
  morphTargets?: boolean;
  /** Resize textures above this size (px, longest edge). Default 2048. */
  maxTextureSize?: number;

  // --- Optimization (game-engine friendly) ---

  /** Target engine preset. Adjusts defaults for axis/texture size when other
   *  fields are left at their defaults. Default 'auto' (no preset applied). */
  targetEngine?: TargetEngine;
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
}

export const DEFAULT_OPTIONS: Required<Omit<ConvertOptions, 'onProgress' | 'targetEngine'>> & {
  onProgress?: ConvertOptions['onProgress'];
  targetEngine?: ConvertOptions['targetEngine'];
} = {
  outputFormat: 'fbx',
  embedTextures: true,
  scale: 1,
  axis: 'y-up',
  animationFilter: 'all',
  morphTargets: true,
  maxTextureSize: 2048,
  targetEngine: 'auto',
  maxTriangles: 0,
  mergeByMaterial: false,
  generateLODs: 0,
  lodTriangleTargets: [],
  detailPins: [],
};

/** Quality-focused automatic targets as a fraction of source triangles. */
export const DEFAULT_LOD_TRIANGLE_RATIOS = [0.5, 0.3, 0.2, 0.12] as const;

/**
 * Keep the deepest automatic LOD useful for both small props and very dense
 * scans.  A ratio-only target plateaus on UV-seamed meshes long before it
 * reaches a genuinely low-poly representation (a 1.8M-triangle scan would
 * otherwise still target roughly 226K triangles at LOD4).  Explicit profile
 * targets continue to take precedence over this cap.
 */
export const DEFAULT_DEEPEST_LOD_TRIANGLE_CAP = 450;

/**
 * Engine-specific preset defaults. Applied when targetEngine is set and
 * the user hasn't explicitly overridden the field. We treat undefined /
 * equal-to-default as "not set".
 */
export interface EnginePreset {
  axis: AxisUp;
  maxTextureSize: number;
  scale: number;
}

export const ENGINE_PRESETS: Record<Exclude<TargetEngine, 'auto'>, EnginePreset> = {
  unity: { axis: 'y-up', maxTextureSize: 2048, scale: 1 },
  unreal: { axis: 'z-up', maxTextureSize: 2048, scale: 1 },
  godot: { axis: 'y-up', maxTextureSize: 1024, scale: 1 },
};

/**
 * Apply the engine preset to a ConvertOptions object. Only fills in fields
 * that are at their default value, so explicit user choices win.
 */
export function applyEnginePreset(opts: ConvertOptions): ConvertOptions {
  if (!opts.targetEngine || opts.targetEngine === 'auto') return opts;
  const preset = ENGINE_PRESETS[opts.targetEngine];
  const defaults = DEFAULT_OPTIONS;
  const out = { ...opts };
  if (opts.axis === undefined || opts.axis === defaults.axis) out.axis = preset.axis;
  if (opts.maxTextureSize === undefined || opts.maxTextureSize === defaults.maxTextureSize) {
    out.maxTextureSize = preset.maxTextureSize;
  }
  if (opts.scale === undefined || opts.scale === defaults.scale) out.scale = preset.scale;
  return out;
}

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
