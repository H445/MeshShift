import type { AssimpInstance } from '../../core/assimpLoader.js';

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

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(script);
  });
}

async function loadAssimp(): Promise<AssimpInstance> {
  const globalScope = globalThis as unknown as { assimpjs?: AssimpFactory };
  const scriptUrl = publicAssetUrl('assimpjs.js');
  const wasmUrl = publicAssetUrl('assimpjs.wasm');

  if (typeof globalScope.assimpjs !== 'function') {
    if (
      typeof document !== 'undefined' &&
      document.head &&
      typeof document.head.appendChild === 'function'
    ) {
      await loadScript(scriptUrl);
    } else {
      const response = await fetch(scriptUrl);
      if (!response.ok) {
        throw new Error(`Failed to load script: ${scriptUrl} (${response.status})`);
      }
      const source = await response.text();
      // The vendored build is a classic UMD-style script, while Vite emits
      // module workers. Evaluate it inside this isolated worker and return its
      // local factory without exposing it to the page's global scope.
      globalScope.assimpjs = new Function(`${source}\nreturn assimpjs;`)() as AssimpFactory;
    }
  }

  const factory = globalScope.assimpjs;
  if (typeof factory !== 'function') {
    throw new Error('assimpjs global not found after script load');
  }
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
