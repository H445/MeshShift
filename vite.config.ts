import { defineConfig, type Plugin } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExportMiddleware } from './src/server/exportServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exportRoot = resolve(__dirname, 'exports');

function modelShiftExportPlugin(): Plugin {
  return {
    name: 'modelshift-export-store',
    configureServer(server) {
      server.middlewares.use(createExportMiddleware(exportRoot));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createExportMiddleware(exportRoot));
    },
  };
}

export default defineConfig({
  plugins: [modelShiftExportPlugin()],
  root: resolve(__dirname, 'src/client'),
  publicDir: resolve(__dirname, 'src/client/public'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/client'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core/index.ts'),
    },
  },
  define: {
    // Tells the platform check in assimpLoaderImpl.ts to take the browser branch
    // and tree-shake out the Node branch (which imports node:fs, node:vm).
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
    // The model worker lazy-loads the conversion/optimization core. ES output
    // supports the resulting worker chunks; Vite's IIFE default does not.
    format: 'es',
  },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
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
