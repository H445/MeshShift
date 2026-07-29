/**
 * Inspect a glTF / GLB file and extract lightweight metadata
 * (triangle/vertex counts, materials, textures, animations, bounding box).
 *
 * This is used by the web UI to show file stats in the queue rows and
 * to give the user a sense of what they're about to convert. It does
 * NOT do the full conversion — that path is convertGltfToFbx.
 *
 * Works in both browser and Node. In Node we polyfill `Image` because
 * three.js's GLTFLoader calls `new Image()` for texture loading — but
 * for inspection we don't care about pixel data, so the polyfill
 * resolves the load with 0×0 dimensions.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { InspectResult } from '../shared/options.js';

declare const __IS_BROWSER__: boolean;

// --- Node polyfill (only when running under Node) ---
//
// three.js's GLTFLoader uses `new Image()` and `new FileReader()` to
// load textures and parse blobs. In Node neither is defined, so we
// provide minimal stubs that resolve empty results. This is enough
// for metadata extraction and the optimize pass — we never read pixel
// data here (texture resize in the browser does the real work).
if (typeof __IS_BROWSER__ !== 'undefined' && !__IS_BROWSER__) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  if (typeof g.Image === 'undefined') {
    class NodeImage {
      width = 0;
      height = 0;
      onload: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      private _src = '';
      get src(): string {
        return this._src;
      }
      set src(v: string) {
        this._src = v;
        // Resolve as a successful empty image. Use queueMicrotask so
        // listeners attached right after the src= assignment still fire.
        queueMicrotask(() => this.onload?.());
      }
    }
    g.Image = NodeImage;
  }
  if (typeof g.FileReader === 'undefined') {
    class NodeFileReader {
      result: ArrayBuffer | string | null = null;
      error: unknown = null;
      onload: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onloadend: ((ev: unknown) => void) | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readAsArrayBuffer(blob: any) {
        queueMicrotask(async () => {
          try {
            // Node 18+ Blob has arrayBuffer()
            if (typeof blob.arrayBuffer === 'function') {
              this.result = asArrayBuffer(await blob.arrayBuffer());
            } else if (blob instanceof Uint8Array) {
              this.result = asArrayBuffer(
                blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
              );
            } else if (blob instanceof ArrayBuffer) {
              this.result = blob;
            } else {
              this.result = new ArrayBuffer(0);
            }
            this.onload?.({ target: this });
            this.onloadend?.({ target: this });
          } catch (e) {
            this.error = e;
            this.onerror?.(e);
            this.onloadend?.(e);
          }
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readAsDataURL(blob: any) {
        queueMicrotask(async () => {
          try {
            let buf: ArrayBuffer;
            if (typeof blob.arrayBuffer === 'function')
              buf = asArrayBuffer(await blob.arrayBuffer());
            else if (blob instanceof Uint8Array)
              buf = asArrayBuffer(
                blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
              );
            else buf = blob;
            const u8 = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
            this.result = `data:application/octet-stream;base64,${btoa(bin)}`;
            this.onload?.({ target: this });
            this.onloadend?.({ target: this });
          } catch (e) {
            this.error = e;
            this.onerror?.(e);
            this.onloadend?.(e);
          }
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readAsText(blob: any, _enc?: string) {
        queueMicrotask(async () => {
          try {
            let buf: ArrayBuffer;
            if (typeof blob.arrayBuffer === 'function')
              buf = asArrayBuffer(await blob.arrayBuffer());
            else if (blob instanceof Uint8Array)
              buf = asArrayBuffer(
                blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
              );
            else buf = blob;
            this.result = new TextDecoder().decode(buf);
            this.onload?.({ target: this });
            this.onloadend?.({ target: this });
          } catch (e) {
            this.error = e;
            this.onerror?.(e);
            this.onloadend?.(e);
          }
        });
      }
    }
    g.FileReader = NodeFileReader;
  }
  if (typeof g.Blob === 'undefined') {
    // Node 18+ has a global Blob, but in case the runtime is older:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    g.Blob = class NodeBlob {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(
        public parts: any[],
        public opts: any = {},
      ) {}
      get size() {
        return this.parts.reduce(
          (s: number, p: any) => s + (p?.byteLength ?? p?.size ?? p?.length ?? 0),
          0,
        );
      }
      get type() {
        return this.opts.type ?? '';
      }
      async arrayBuffer(): Promise<ArrayBuffer> {
        const out = new Uint8Array(this.size);
        let off = 0;
        for (const p of this.parts) {
          let u8: Uint8Array;
          if (p instanceof Uint8Array) u8 = p;
          else if (p instanceof ArrayBuffer) u8 = new Uint8Array(p);
          else if (typeof p === 'string') u8 = new TextEncoder().encode(p);
          else continue;
          out.set(u8, off);
          off += u8.byteLength;
        }
        return out.buffer;
      }
    };
  }
}

// Tiny helper to assert we have a real (non-shared) ArrayBuffer. Used
// to make the TS compiler happy with the `Uint8Array.buffer` access
// patterns below — three.js's GLTFLoader accepts `ArrayBuffer` but
// rejects `SharedArrayBuffer` in its `parse` signature.
function asArrayBuffer(ab: ArrayBuffer | SharedArrayBuffer): ArrayBuffer {
  if (ab instanceof ArrayBuffer) return ab;
  const out = new ArrayBuffer(ab.byteLength);
  new Uint8Array(out).set(new Uint8Array(ab));
  return out;
}

function geomTriangleCount(geo: {
  index: { count: number } | null;
  attributes: Record<string, { count: number }>;
}): number {
  if (geo.index) return geo.index.count / 3;
  const pos = geo.attributes.position;
  return pos ? pos.count / 3 : 0;
}

function geomVertexCount(geo: { attributes: Record<string, { count: number }> }): number {
  return geo.attributes.position?.count ?? 0;
}

/** Compute axis-aligned bounding box of a buffer geometry. */
function computeBBox(geo: {
  attributes: {
    position?: {
      count: number;
      getX: (index: number) => number;
      getY: (index: number) => number;
      getZ: (index: number) => number;
    };
  };
}): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const pos = geo.attributes.position;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  if (!pos) return { min: [0, 0, 0], max: [0, 0, 0] };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

/**
 * Parse a glTF / GLB ArrayBuffer and return scene metadata.
 * Throws on parse failure.
 */
export function inspectGltf(buf: ArrayBuffer | Uint8Array): Promise<InspectResult> {
  const ab =
    buf instanceof Uint8Array
      ? // Copy into a fresh ArrayBuffer in case the input buffer is shared.
        (() => {
          const a = new ArrayBuffer(buf.byteLength);
          new Uint8Array(a).set(buf);
          return a;
        })()
      : asArrayBuffer(buf);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      ab,
      '',
      (gltf) => {
        try {
          const result = walkScene(gltf);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/**
 * Inspect an already-loaded three.js scene without serializing and parsing it
 * again. The optimizer uses this before export to avoid a second 50–70 MB GLB
 * copy plus another complete GLTFLoader scene at peak memory.
 */
export function inspectScene(scene: unknown, animations: readonly unknown[] = []): InspectResult {
  return walkScene({
    scene,
    scenes: [scene],
    animations: [...animations],
  });
}

function walkScene(gltf: {
  scene: unknown;
  scenes: unknown[];
  animations: unknown[];
}): InspectResult {
  // Walk the scene graph. We use the `gltf.scene` root.
  // Cast through unknown — three.js's `Object3D` is the actual type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = gltf.scene as any;

  // De-dupe materials and textures by reference.
  const materials = new Set<unknown>();
  const textures = new Set<{ image: { width: number; height: number }; name?: string }>();
  const textureList: { name: string; width: number; height: number }[] = [];
  const seenTextureImages = new WeakSet<object>();
  let triangles = 0;
  let vertices = 0;
  const meshes: unknown[] = [];
  let bones = 0;
  let hasSkin = false;
  let hasMorph = false;
  // Bounding box
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  root.traverse(
    (obj: {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      geometry?: unknown;
      material?: unknown;
      materials?: unknown[];
      skeleton?: { bones?: unknown[] };
      morphTargetInfluences?: unknown;
    }) => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        meshes.push(obj);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const geo = obj.geometry as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const morph = (geo as any).morphAttributes;
        if (morph && (morph.position || morph.normal || morph.color)) hasMorph = true;

        triangles += geomTriangleCount(geo);
        vertices += geomVertexCount(geo);

        const bb = computeBBox(geo);
        if (bb.min[0] < min[0]) min[0] = bb.min[0];
        if (bb.min[1] < min[1]) min[1] = bb.min[1];
        if (bb.min[2] < min[2]) min[2] = bb.min[2];
        if (bb.max[0] > max[0]) max[0] = bb.max[0];
        if (bb.max[1] > max[1]) max[1] = bb.max[1];
        if (bb.max[2] > max[2]) max[2] = bb.max[2];

        // Material(s) — Mesh can have an array of materials (multi-material mesh).
        const mats =
          (obj.materials as unknown[] | undefined) ?? (obj.material ? [obj.material] : []);
        for (const m of mats) {
          if (m) materials.add(m);
          // Collect texture refs from the material (three.js standard / physical).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mAny = m as any;
          const texProps = [
            'map',
            'normalMap',
            'roughnessMap',
            'metalnessMap',
            'aoMap',
            'emissiveMap',
            'bumpMap',
            'displacementMap',
            'alphaMap',
            'clearcoatMap',
            'clearcoatNormalMap',
            'clearcoatRoughnessMap',
            'sheenColorMap',
            'sheenRoughnessMap',
            'specularIntensityMap',
            'specularColorMap',
            'transmissionMap',
            'thicknessMap',
            'iridescenceMap',
            'iridescenceThicknessMap',
          ];
          for (const k of texProps) {
            const t = mAny?.[k];
            if (t && t.image) {
              textures.add(t);
              const img = t.image;
              if (!seenTextureImages.has(img)) {
                seenTextureImages.add(img);
                textureList.push({
                  name: t.name || k,
                  width: img.width || 0,
                  height: img.height || 0,
                });
              }
            }
          }
        }

        if (obj.isSkinnedMesh) {
          hasSkin = true;
          if (obj.skeleton?.bones) bones += obj.skeleton.bones.length;
        }
      }
    },
  );

  // Some skins live on the gltf object even if not under a SkinnedMesh
  // we visited. Add a safety net.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gltfAny = gltf as any;
  if (gltfAny.skins?.length) {
    for (const skin of gltfAny.skins) {
      if (skin.joints?.length) {
        // Joints are indices into the nodes array. We can't easily
        // resolve to bone count without walking, but the per-mesh
        // skeleton.bones count above already covers most cases.
      }
    }
  }

  const animations = (gltf.animations as unknown[] | undefined)?.length ?? 0;
  const textureMaxSize = textureList.reduce((m, t) => Math.max(m, t.width, t.height), 0);

  // If we never found a position attribute, return a zero bbox.
  const finalMin: [number, number, number] = min[0] === Infinity ? [0, 0, 0] : min;
  const finalMax: [number, number, number] = max[0] === -Infinity ? [0, 0, 0] : max;

  return {
    meshes: meshes.length,
    materials: materials.size,
    textures: textures.size,
    textureMaxSize,
    textureList,
    animations,
    bones,
    morphTargets: hasMorph ? 1 : 0, // we only know "has at least one" without counting slots
    triangles: Math.round(triangles),
    vertices: Math.round(vertices),
    hasSkin,
    hasMorph,
    bboxMin: finalMin,
    bboxMax: finalMax,
    bboxSize: [
      +(finalMax[0] - finalMin[0]).toFixed(3),
      +(finalMax[1] - finalMin[1]).toFixed(3),
      +(finalMax[2] - finalMin[2]).toFixed(3),
    ],
  };
}
