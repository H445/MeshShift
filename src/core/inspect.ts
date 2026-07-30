/**
 * Inspect a glTF / GLB file and extract lightweight metadata
 * (triangle/vertex counts, materials, textures, animations, bounding box).
 *
 * This is used by the web UI to show file stats in the queue rows and
 * to give the user a sense of what they're about to convert. It does
 * NOT do the full conversion — that path is convertGltfToFbx.
 *
 * Works in both browser and Node. In Node we provide the small DOM surface
 * three.js needs to load embedded PNG/JPEG textures. The encoded image bytes
 * are retained so GLTFExporter can write unchanged textures back out without
 * a native canvas dependency.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Box3, Vector3, type Matrix4 } from 'three';
import type { InspectResult } from '../shared/options.js';

declare const __IS_BROWSER__: boolean | undefined;

// --- Node polyfill (only when running under Node) ---
//
// three.js's GLTFLoader uses `new Image()`, `new FileReader()`, and
// `new ProgressEvent()` to load textures, parse blobs, and report data-URI
// buffer progress. Node does not provide all of them, so we install minimal
// stubs. This is enough for metadata extraction and the optimize pass — we
// never read pixel data here (texture resize in the browser does the real work).
const isBrowser =
  typeof __IS_BROWSER__ === 'boolean' ? __IS_BROWSER__ : typeof window !== 'undefined';

const NODE_IMAGE_SOURCE = Symbol('modelshift.nodeImageSource');

interface NodeImageSource {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

interface NodeImageLike {
  width: number;
  height: number;
  [NODE_IMAGE_SOURCE]?: NodeImageSource;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
}

function encodedImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { width: number; height: number } | null {
  if (mimeType === 'image/png') return pngDimensions(bytes);
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return jpegDimensions(bytes);
  return pngDimensions(bytes) ?? jpegDimensions(bytes);
}

class NodePassthroughCanvasContext {
  imageSmoothingQuality = 'low';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  private source: NodeImageSource | null = null;
  private transformed = false;
  private composed = false;

  constructor(private readonly canvas: NodePassthroughCanvas) {}

  translate(x: number, y: number): void {
    if (x !== 0 || y !== 0) this.transformed = true;
  }

  scale(x: number, y: number): void {
    if (x !== 1 || y !== 1) this.transformed = true;
  }

  drawImage(image: NodeImageLike, _x: number, _y: number, width: number, height: number): void {
    const source = image[NODE_IMAGE_SOURCE];
    if (!source) {
      throw new Error(
        'Node texture export requires an unchanged embedded PNG or JPEG source image.',
      );
    }
    if (
      width !== source.width ||
      height !== source.height ||
      this.canvas.width !== source.width ||
      this.canvas.height !== source.height
    ) {
      throw new Error('Node texture export cannot resize images without a canvas implementation.');
    }
    if (this.source && this.source !== source) this.composed = true;
    this.source = source;
  }

  fillRect(): void {
    this.composed = true;
  }

  getImageData(): never {
    throw new Error(
      'Node texture export cannot read image pixels without a canvas implementation.',
    );
  }

  putImageData(): void {
    this.composed = true;
  }

  sourceBlob(mimeType: string): Blob {
    if (!this.source) {
      throw new Error('Node texture export did not receive an encoded source image.');
    }
    if (this.transformed) {
      throw new Error('Node texture export cannot flip images without a canvas implementation.');
    }
    if (this.composed) {
      throw new Error(
        'Node texture export cannot composite images without a canvas implementation.',
      );
    }
    const requestedType = mimeType.toLowerCase();
    const sourceType = this.source.mimeType.toLowerCase();
    if (requestedType && requestedType !== sourceType) {
      throw new Error(
        `Node texture export cannot transcode ${sourceType || 'an image'} to ${requestedType}.`,
      );
    }
    return this.source.blob;
  }
}

class NodePassthroughCanvas {
  width = 0;
  height = 0;
  private readonly context = new NodePassthroughCanvasContext(this);

  getContext(contextId: string): NodePassthroughCanvasContext | null {
    return contextId === '2d' ? this.context : null;
  }

  toBlob(callback: (blob: Blob) => void, mimeType = ''): void {
    callback(this.context.sourceBlob(mimeType));
  }

  convertToBlob(options: { type?: string } = {}): Promise<Blob> {
    return Promise.resolve(this.context.sourceBlob(options.type ?? ''));
  }
}

/** Install the minimal DOM aliases three.js needs for textured glTF in Node. */
export function installNodeGltfLoaderPolyfills(): void {
  if (isBrowser) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  // GLTFLoader refers to `self.URL` when resolving embedded image blobs.
  // Node exposes URL.createObjectURL(), but not the browser/worker `self`
  // alias, so make the alias explicit before any textured asset is parsed.
  if (typeof g.self === 'undefined') g.self = g;
  if (typeof g.self.URL === 'undefined') g.self.URL = g.URL;
  if (typeof g.ProgressEvent === 'undefined') {
    class NodeProgressEvent {
      readonly type: string;
      readonly lengthComputable: boolean;
      readonly loaded: number;
      readonly total: number;

      constructor(type: string, init: ProgressEventInit = {}) {
        this.type = type;
        this.lengthComputable = init.lengthComputable ?? false;
        this.loaded = init.loaded ?? 0;
        this.total = init.total ?? 0;
      }
    }
    g.ProgressEvent = NodeProgressEvent;
  }
  class NodeImage {
    width = 0;
    height = 0;
    naturalWidth = 0;
    naturalHeight = 0;
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private _src = '';
    private requestId = 0;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    [NODE_IMAGE_SOURCE]?: NodeImageSource;

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    private dispatch(type: 'load' | 'error', reason?: unknown): void {
      const event = { type, target: this, error: reason };
      for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
      if (type === 'load') this.onload?.call(this);
      else this.onerror?.call(this, reason);
    }

    get src(): string {
      return this._src;
    }

    set src(v: string) {
      this._src = v;
      const requestId = ++this.requestId;
      void this.load(v, requestId);
    }

    private async load(url: string, requestId: number): Promise<void> {
      try {
        if (!url.startsWith('blob:') && !url.startsWith('data:')) {
          throw new Error(
            'Node glTF texture loading supports embedded blob: and data: images only.',
          );
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Image request failed with status ${response.status}.`);
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const mimeType = (blob.type || response.headers.get('content-type') || '').toLowerCase();
        const dimensions = encodedImageDimensions(bytes, mimeType);
        if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
          throw new Error(`Unsupported or invalid embedded image type: ${mimeType || 'unknown'}.`);
        }
        if (requestId !== this.requestId) return;
        this.width = dimensions.width;
        this.height = dimensions.height;
        this.naturalWidth = dimensions.width;
        this.naturalHeight = dimensions.height;
        this[NODE_IMAGE_SOURCE] = {
          blob,
          mimeType,
          width: dimensions.width,
          height: dimensions.height,
        };
        this.dispatch('load');
      } catch (error) {
        if (requestId === this.requestId) this.dispatch('error', error);
      }
    }
  }

  if (typeof g.Image === 'undefined') {
    g.Image = NodeImage;
  }
  if (typeof g.HTMLImageElement === 'undefined') {
    g.HTMLImageElement = g.Image;
  }
  if (typeof g.HTMLCanvasElement === 'undefined') {
    g.HTMLCanvasElement = NodePassthroughCanvas;
  }
  if (typeof g.document === 'undefined') {
    const createElement = (tagName: string) => {
      if (tagName.toLowerCase() === 'img') return new g.Image();
      if (tagName.toLowerCase() === 'canvas') return new NodePassthroughCanvas();
      throw new Error(`Node glTF processing cannot create <${tagName}>.`);
    };
    g.document = {
      createElement,
      createElementNS: (_namespace: string, tagName: string) => createElement(tagName),
    };
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
            const chunks: string[] = [];
            for (let offset = 0; offset < u8.length; offset += 0x8000) {
              chunks.push(String.fromCharCode(...u8.subarray(offset, offset + 0x8000)));
            }
            this.result = `data:application/octet-stream;base64,${btoa(chunks.join(''))}`;
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
}

installNodeGltfLoaderPolyfills();

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
  boundingBox?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  } | null;
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
  // GLTFLoader populates BufferGeometry.boundingBox directly from accessor
  // min/max values. Reusing it turns inspection of a multi-million-vertex
  // model from a full synchronous vertex scan into a constant-time lookup.
  const embedded = geo.boundingBox;
  if (
    embedded &&
    [
      embedded.min.x,
      embedded.min.y,
      embedded.min.z,
      embedded.max.x,
      embedded.max.y,
      embedded.max.z,
    ].every(Number.isFinite)
  ) {
    return {
      min: [embedded.min.x, embedded.min.y, embedded.min.z],
      max: [embedded.max.x, embedded.max.y, embedded.max.z],
    };
  }

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

function worldBBox(
  local: { min: [number, number, number]; max: [number, number, number] },
  matrixWorld?: Matrix4,
): { min: [number, number, number]; max: [number, number, number] } {
  if (!matrixWorld) return local;
  const box = new Box3(
    new Vector3(local.min[0], local.min[1], local.min[2]),
    new Vector3(local.max[0], local.max[1], local.max[2]),
  ).applyMatrix4(matrixWorld);
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

/**
 * Parse a glTF / GLB ArrayBuffer and return scene metadata.
 * Throws on parse failure.
 */
export function inspectGltf(buf: ArrayBuffer | Uint8Array): Promise<InspectResult> {
  const ab =
    buf instanceof Uint8Array
      ? // Reuse a full, non-shared buffer. Copy only sliced/shared views.
        (() => {
          if (
            buf.buffer instanceof ArrayBuffer &&
            buf.byteOffset === 0 &&
            buf.byteLength === buf.buffer.byteLength
          ) {
            return buf.buffer;
          }
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
  let morphTargets = 0;
  // Bounding box
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  root.updateMatrixWorld?.(true);
  root.traverse(
    (obj: {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      geometry?: unknown;
      material?: unknown | unknown[];
      materials?: unknown[];
      matrixWorld?: Matrix4;
      skeleton?: { bones?: unknown[] };
      morphTargetInfluences?: ArrayLike<number>;
    }) => {
      if (obj.isMesh || obj.isSkinnedMesh) {
        meshes.push(obj);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const geo = obj.geometry as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const morph = (geo as any).morphAttributes as Record<string, unknown> | undefined;
        const geometryMorphTargets = morph
          ? Math.max(
              0,
              ...Object.values(morph).map((targets) =>
                Array.isArray(targets) ? targets.length : 0,
              ),
            )
          : 0;
        const meshMorphTargets = Math.max(
          geometryMorphTargets,
          obj.morphTargetInfluences?.length ?? 0,
        );
        if (meshMorphTargets > 0) hasMorph = true;
        morphTargets += meshMorphTargets;

        triangles += geomTriangleCount(geo);
        vertices += geomVertexCount(geo);

        const bb = worldBBox(computeBBox(geo), obj.matrixWorld);
        if (bb.min[0] < min[0]) min[0] = bb.min[0];
        if (bb.min[1] < min[1]) min[1] = bb.min[1];
        if (bb.min[2] < min[2]) min[2] = bb.min[2];
        if (bb.max[0] > max[0]) max[0] = bb.max[0];
        if (bb.max[1] > max[1]) max[1] = bb.max[1];
        if (bb.max[2] > max[2]) max[2] = bb.max[2];

        // Material(s) — Mesh can have an array of materials (multi-material mesh).
        const materialValue = obj.materials ?? obj.material;
        const mats = Array.isArray(materialValue)
          ? materialValue
          : materialValue
            ? [materialValue]
            : [];
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
    morphTargets,
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
