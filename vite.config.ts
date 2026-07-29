import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
