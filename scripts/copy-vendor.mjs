#!/usr/bin/env node
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

export async function copyVendorFiles(root = projectRoot) {
  const sourceDir = resolve(root, 'src/client/public');
  const outputDir = resolve(root, 'dist/vendor');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    ['assimpjs.js', 'assimpjs.wasm'].map((name) =>
      copyFile(resolve(sourceDir, name), resolve(outputDir, name)),
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await copyVendorFiles();
  console.log('Copied Node vendor assets to dist/vendor.');
}
