/**
 * Default tsup config — we currently only build the CLI from this file.
 * Kept for symmetry / future use (e.g. if we add a Node-only test runner).
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/core/index.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  external: ['three', 'three/examples/jsm/*'],
  outDir: 'dist/core',
});
