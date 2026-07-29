/**
 * Cross-environment assimpjs loader.
 *
 * Browser:  loads the vendored `assimpjs.js` (repalash fork with FBX export)
 *           as a <script> tag, then initialises with `locateFile` pointing
 *           at /assimpjs.wasm.
 * Node:     reads the vendored .js + .wasm from disk and evaluates the .js
 *           inside a controlled `vm` context with a `require('fs')` shim.
 *
 * We split the file into two and use Vite/tsup `define` to set
 * `__IS_BROWSER__` so each build only includes its own branch.
 */

import type { AssimpInstance } from './assimpLoader.js';

declare const __IS_BROWSER__: boolean | undefined;

const isBrowser =
  typeof __IS_BROWSER__ === 'boolean' ? __IS_BROWSER__ : typeof window !== 'undefined';

let cached: Promise<AssimpInstance> | null = null;

export function getAssimp(): Promise<AssimpInstance> {
  if (cached) return cached;
  cached = (isBrowser ? loadInBrowser() : loadInNode()).catch((error: unknown) => {
    // A transient script/network failure should not permanently poison the
    // process-wide cache. The next conversion gets a clean retry.
    cached = null;
    throw error;
  });
  return cached;
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(s);
  });
}

function loadInBrowser(): Promise<AssimpInstance> {
  type Factory = (opts?: { locateFile?: (file: string) => string }) => Promise<AssimpInstance>;
  return (async () => {
    const g = globalThis as unknown as { assimpjs?: Factory };
    if (typeof g.assimpjs !== 'function') {
      await loadScript('/assimpjs.js');
    }
    const factory = (globalThis as unknown as { assimpjs?: Factory }).assimpjs;
    if (typeof factory !== 'function') {
      throw new Error('assimpjs global not found after script load');
    }
    return factory({ locateFile: () => '/assimpjs.wasm' });
  })();
}

async function loadInNode(): Promise<AssimpInstance> {
  // All Node-specific imports are inside this function so the browser
  // bundle never tries to resolve them.
  const [{ readFile }, { createRequire }, { dirname, join }, { fileURLToPath, pathToFileURL }, vm] =
    await Promise.all([
      import('node:fs/promises'),
      import('node:module'),
      import('node:path'),
      import('node:url'),
      import('node:vm'),
    ]);

  type Factory = (opts?: { locateFile?: (file: string) => string }) => Promise<AssimpInstance>;

  function resolveVendoredPaths(): { jsUrl: string; wasmUrl: string } {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const cwd = process.cwd();
    const candidates = [
      process.env.G2F_ASSIMP_DIR,
      thisDir,
      join(cwd, 'src', 'client', 'public'),
      join(cwd, 'public'),
      join(thisDir, '..', '..', 'client', 'public'),
      join(thisDir, '..', 'public'),
      join(thisDir, 'public'),
    ].filter((x): x is string => Boolean(x));

    let statSync: ((p: string) => unknown) | null = null;
    try {
      statSync = createRequire(import.meta.url)('node:fs').statSync;
    } catch {
      // ignore
    }

    for (const dir of candidates) {
      const js = join(dir, 'assimpjs.js');
      const wasm = join(dir, 'assimpjs.wasm');
      try {
        if (statSync) {
          statSync(js);
          statSync(wasm);
        }
        return {
          jsUrl: pathToFileURL(js).href,
          wasmUrl: pathToFileURL(wasm).href,
        };
      } catch {
        // try next
      }
    }
    throw new Error(
      `assimpjs vendor files not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
        'Set G2F_ASSIMP_DIR to the directory containing assimpjs.js and assimpjs.wasm.',
    );
  }

  const { jsUrl, wasmUrl } = resolveVendoredPaths();
  const jsPath = fileURLToPath(jsUrl);
  const wasmPath = fileURLToPath(wasmUrl);
  const [code, wasmBytes] = await Promise.all([readFile(jsPath, 'utf8'), readFile(wasmPath)]);

  const fakeModule: { exports: unknown } = { exports: {} };
  const sandbox: Record<string, unknown> = {
    module: fakeModule,
    exports: fakeModule.exports,
    __dirname: dirname(jsPath),
    __filename: jsPath,
    console,
    process,
    Buffer,
    URL,
    performance,
    TextEncoder,
    TextDecoder,
    require: (id: string) => {
      if (id === 'fs') {
        return {
          readFileSync: (p: string | URL) => {
            const s = String(p).toLowerCase();
            if (s.endsWith('.wasm')) return wasmBytes;
            return Buffer.alloc(0);
          },
          existsSync: () => true,
        };
      }
      if (id === 'path') return { dirname: () => '', join: (...a: string[]) => a.join('/') };
      throw new Error(`Unexpected require('${id}')`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(code, { filename: jsPath }).runInContext(sandbox);
  const factory = fakeModule.exports as unknown as Factory;
  if (typeof factory !== 'function') {
    throw new Error('Failed to load assimpjs — module.exports is not a function');
  }
  return factory({ locateFile: () => wasmUrl });
}
