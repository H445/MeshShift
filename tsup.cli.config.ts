import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const OUT_DIR = 'dist/cli';
const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export default defineConfig({
  entry: { modelshift: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  minify: true,
  shebang: '#!/usr/bin/env node',
  external: [
    'commander',
    'jszip',
    'meshoptimizer',
    'three',
    'three-mesh-bvh',
    'watlas',
    /^three\/examples\/jsm\//,
  ],
  outDir: OUT_DIR,
  outExtension() {
    return { js: '.mjs' };
  },
  define: {
    __IS_BROWSER__: 'false',
    __MODELSHIFT_VERSION__: JSON.stringify(packageVersion),
  },
});
