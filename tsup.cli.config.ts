import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = resolve(__dirname, 'src', 'client', 'public');
const OUT_DIR = 'dist/cli';

// Copy the vendored assimpjs files next to the CLI bundle
// so the loader finds them at runtime.
const copyVendorFiles = () => {
  const outDir = resolve(__dirname, OUT_DIR);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const name of ['assimpjs.js', 'assimpjs.wasm']) {
    copyFileSync(resolve(VENDOR_DIR, name), resolve(outDir, name));
  }
};

export default defineConfig({
  entry: { 'gltf-to-fbx': 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  minify: true,
  shebang: '#!/usr/bin/env node',
  external: ['three', 'jszip', 'commander'],
  outDir: OUT_DIR,
  outExtension() {
    return { js: '.mjs' };
  },
  define: {
    __IS_BROWSER__: 'false',
  },
  onSuccess: copyVendorFiles,
});
