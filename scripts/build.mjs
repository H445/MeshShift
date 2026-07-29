#!/usr/bin/env node
/**
 * Production build — runs the CLI tsup build and the Vite client build in parallel.
 * Output:
 *   - dist/cli/gltf-to-fbx.mjs        (CLI, Node 20+, includes vendored assimpjs)
 *   - dist/cli/assimpjs.js, .wasm     (vendored engine, ~4 MB total)
 *   - dist/client/                    (static SPA — open index.html or host anywhere)
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

function run(label, command, args) {
  return new Promise((resolveP, reject) => {
    console.log(`\n▶ ${label}\n`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: root,
      shell: isWin, // shell mode on Windows so .cmd wrappers resolve
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolveP() : reject(new Error(`${label} exited with code ${code}`)),
    );
  });
}

try {
  await Promise.all([
    run('Building CLI', 'npx', ['tsup', '--config', 'tsup.cli.config.ts']),
    run('Building web client', 'npx', ['vite', 'build']),
  ]);
  console.log('\n✅ Build complete.');
  console.log('   • dist/cli/gltf-to-fbx.mjs    (CLI)');
  console.log('   • dist/client/index.html       (web UI — open in browser)');
} catch (err) {
  console.error('\n❌ Build failed:', err.message);
  process.exit(1);
}
