import type { AssimpInstance } from '../../core/assimpLoader.js';
import assimpFactory from 'virtual:meshshift-assimp';

type AssimpFactory = (options?: {
  locateFile?: (file: string) => string;
}) => Promise<AssimpInstance>;

let cached: Promise<AssimpInstance> | null = null;
const moduleUrl = import.meta.url;

/**
 * Resolve public assets in both Vite development and relative production
 * builds. Workers resolve relative URLs from their own `assets/` directory,
 * while the document resolves them from the built index page.
 */
function publicAssetUrl(name: string): string {
  if (import.meta.env.DEV) {
    return new URL(`/${name}`, globalThis.location.href).href;
  }
  // The model worker installs a minimal canvas-only document shim. Only use a
  // document base when this is the real page document with a valid base URI.
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string') {
    return new URL(name, document.baseURI).href;
  }
  // Keep the module URL in a variable so Vite does not interpret the dynamic
  // asset name as a build-time glob.
  return new URL(`../${name}`, moduleUrl).href;
}

async function loadAssimp(): Promise<AssimpInstance> {
  const wasmUrl = publicAssetUrl('assimpjs.wasm');
  const factory = assimpFactory as AssimpFactory;
  if (typeof factory !== 'function') throw new Error('Assimp runtime factory is unavailable.');
  return factory({ locateFile: () => wasmUrl });
}

export function getAssimp(): Promise<AssimpInstance> {
  cached ??= loadAssimp().catch((error: unknown) => {
    // A transient script/network failure should not permanently poison the
    // process-wide cache. The next conversion gets a clean retry.
    cached = null;
    throw error;
  });
  return cached;
}
