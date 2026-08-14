#!/usr/bin/env node
import { access, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'dist/desktop/main.cjs',
  'dist/desktop/preload.cjs',
  'dist/client/index.html',
  'dist/vendor/assimpjs.js',
  'dist/vendor/assimpjs.wasm',
];
const failures = [];

for (const relativePath of required) {
  try {
    const info = await stat(resolve(root, relativePath));
    if (!info.isFile() || info.size === 0) failures.push(`${relativePath} is empty or not a file`);
  } catch {
    failures.push(`missing ${relativePath}`);
  }
}

const main = await readFile(resolve(root, 'dist/desktop/main.cjs'), 'utf8').catch(() => '');
const preload = await readFile(resolve(root, 'dist/desktop/preload.cjs'), 'utf8').catch(() => '');
const client = await readFile(resolve(root, 'dist/client/index.html'), 'utf8').catch(() => '');

if (!main.includes('protocol.handle') || !main.includes('DESKTOP_SCHEME'))
  failures.push('desktop main does not register meshshift protocol');
if (!main.includes('contextIsolation: true') || !main.includes('nodeIntegration: false')) {
  failures.push('desktop main is missing renderer isolation settings');
}
if (!main.includes('Content-Security-Policy'))
  failures.push('desktop main is missing CSP response headers');
if (!main.includes("connect-src 'self' data: blob:")) {
  failures.push('desktop CSP blocks embedded model texture decoding');
}
if (!preload.includes('contextBridge.exposeInMainWorld'))
  failures.push('desktop preload bridge is missing');
if (!client.includes('<title>MeshShift</title>'))
  failures.push('desktop client is missing product title');

if (failures.length > 0) {
  console.error('Desktop verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Desktop verification passed (${required.length} packaged inputs).`);
