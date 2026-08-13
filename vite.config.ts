import { defineConfig, normalizePath, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExportMiddleware } from './src/server/exportServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exportRoot = resolve(__dirname, 'exports');
const browserAssimpLoader = resolve(__dirname, 'src/client/lib/assimpLoader.browser.ts');

function meshShiftExportPlugin(): Plugin {
  return {
    name: 'meshshift-export-store',
    configureServer(server) {
      server.middlewares.use(createExportMiddleware(exportRoot));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createExportMiddleware(exportRoot));
    },
  };
}

/**
 * watlas ships a universal Emscripten wrapper containing an unreachable
 * dynamic `import("module")`. Remove that Node-only bootstrap for the browser
 * build so Rollup never needs to externalize it.
 */
function watlasBrowserPlugin(): Plugin {
  const nodeEnvironment =
    /var ENVIRONMENT_IS_NODE=typeof process=="object"&&process\.versions\?\.node&&process\.type!="renderer";/;
  const nodeBootstrap =
    /if\(ENVIRONMENT_IS_NODE\)\{const\{createRequire\}=await import\("module"\);var require=createRequire\(import\.meta\.url\)\}/;

  return {
    name: 'meshshift-watlas-browser',
    enforce: 'pre',
    transform(code, id) {
      const cleanId = normalizePath(id.split('?')[0]);
      if (!cleanId.endsWith('/node_modules/watlas/dist/watlas.js')) return null;
      if (!nodeEnvironment.test(code) || !nodeBootstrap.test(code)) {
        throw new Error('The watlas browser transform no longer matches the installed package.');
      }
      return {
        code: code
          .replace(nodeEnvironment, 'var ENVIRONMENT_IS_NODE=false;')
          .replace(nodeBootstrap, ''),
        map: null,
      };
    },
  };
}

/**
 * Treat the vendored Emscripten wrapper as a normal module. It is an IIFE that
 * assigns the factory to `assimpjs`; adding an ESM export avoids eval-like
 * execution in the renderer and model worker.
 */
function assimpBrowserPlugin(): Plugin {
  const virtualId = 'virtual:meshshift-assimp';
  const resolvedId = '\0' + virtualId;
  const sourcePath = resolve(__dirname, 'src/client/public/assimpjs.js');
  return {
    name: 'meshshift-assimp-browser',
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return null;
      return `${readFileSync(sourcePath, 'utf8')}\nexport default assimpjs;`;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [watlasBrowserPlugin(), assimpBrowserPlugin(), meshShiftExportPlugin()],
  root: resolve(__dirname, 'src/client'),
  publicDir: resolve(__dirname, 'src/client/public'),
  resolve: {
    alias: {
      './assimpLoaderImpl.js': browserAssimpLoader,
      '@': resolve(__dirname, 'src/client'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core/index.ts'),
    },
  },
  define: {
    // Remaining shared core modules use this to select browser-safe behavior.
    __IS_BROWSER__: 'true',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // watlas resolves its WebAssembly binary relative to import.meta.url.
  // Dependency pre-bundling moves the JS without its sibling .wasm file,
  // causing the dev server to return index.html for the binary request.
  optimizeDeps: {
    exclude: ['watlas'],
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    // The worker contains a static module import of the vendored Assimp
    // wrapper, so Vite's ES output can retain its lazy core chunks.
    format: 'es',
    plugins: () => [watlasBrowserPlugin(), assimpBrowserPlugin()],
  },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
