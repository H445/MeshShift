/**
 * Node assimpjs loader used by the CLI, tests, and published core API.
 *
 * Vite replaces this module with the browser-only implementation, keeping all
 * Node built-ins out of the browser dependency graph.
 */

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { AssimpInstance } from './assimpLoader.js';

let cached: Promise<AssimpInstance> | null = null;

export function getAssimp(): Promise<AssimpInstance> {
  cached ??= loadInNode().catch((error: unknown) => {
    // A transient script/network failure should not permanently poison the
    // process-wide cache. The next conversion gets a clean retry.
    cached = null;
    throw error;
  });
  return cached;
}

async function loadInNode(): Promise<AssimpInstance> {
  type Factory = (opts?: { locateFile?: (file: string) => string }) => Promise<AssimpInstance>;

  function resolveVendoredPaths(): { jsUrl: string; wasmUrl: string } {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const cwd = process.cwd();
    const candidates = [
      process.env.MESHSHIFT_ASSIMP_DIR,
      join(thisDir, '..', 'vendor'),
      thisDir,
      join(cwd, 'src', 'client', 'public'),
      join(cwd, 'public'),
      join(thisDir, '..', '..', 'client', 'public'),
      join(thisDir, '..', 'public'),
      join(thisDir, 'public'),
    ].filter((x): x is string => Boolean(x));

    for (const dir of candidates) {
      const js = join(dir, 'assimpjs.js');
      const wasm = join(dir, 'assimpjs.wasm');
      try {
        statSync(js);
        statSync(wasm);
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
        'Set MESHSHIFT_ASSIMP_DIR to the directory containing assimpjs.js and assimpjs.wasm.',
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
