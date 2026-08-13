import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/core/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: true,
  external: ['meshoptimizer', 'three', 'three-mesh-bvh', 'watlas', /^three\/examples\/jsm\//],
  outDir: 'dist/core',
  define: {
    __IS_BROWSER__: 'false',
  },
});
