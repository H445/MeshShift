import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/desktop/main.ts',
    preload: 'src/desktop/preload.ts',
  },
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  minify: false,
  external: ['electron'],
  outDir: 'dist/desktop',
  outExtension() {
    return { js: '.cjs' };
  },
});
