#!/usr/bin/env node
/**
 * Production build — builds the reusable API, CLI, and web client in parallel.
 * Output:
 *   - dist/core/index.js + index.d.ts  (reusable Node API)
 *   - dist/cli/modelshift.mjs          (CLI, Node 20+)
 *   - dist/vendor/assimpjs.js, .wasm   (shared Node runtime)
 *   - dist/client/                     (relative static web build)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyVendorFiles } from './copy-vendor.mjs';
import { writeReleaseManifest } from './release-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const children = new Set();

function resolvePackageBin(name, binName = name) {
  const packagePath = require.resolve(`${name}/package.json`);
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const relativeBin =
    typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];
  if (!relativeBin) throw new Error(`${name} does not declare the "${binName}" executable.`);
  return resolve(dirname(packagePath), relativeBin);
}

function run(label, script, args) {
  return new Promise((resolveP, reject) => {
    console.log(`\n▶ ${label}\n`);
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      cwd: root,
    });
    children.add(child);
    child.once('error', (error) => {
      children.delete(child);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) {
        resolveP();
      } else {
        reject(
          new Error(
            signal ? `${label} terminated by ${signal}` : `${label} exited with code ${code}`,
          ),
        );
      }
    });
  });
}

async function build() {
  // The publish allowlist includes all of dist, so start from a genuinely
  // clean tree rather than leaving stale top-level artifacts behind.
  await rm(resolve(root, 'dist'), { recursive: true, force: true });

  const tsupCli = resolvePackageBin('tsup');
  const viteCli = resolvePackageBin('vite');
  const builds = [
    run('Building core API', tsupCli, ['--config', 'tsup.config.ts']),
    run('Building CLI', tsupCli, ['--config', 'tsup.cli.config.ts']),
    run('Building web client', viteCli, ['build']),
  ];

  try {
    await Promise.all(builds);
  } catch (error) {
    for (const child of children) child.kill();
    await Promise.allSettled(builds);
    throw error;
  }

  await copyVendorFiles(root);
  await copyFile(
    resolve(root, 'THIRD_PARTY_NOTICES.md'),
    resolve(root, 'dist', 'client', 'THIRD_PARTY_NOTICES.md'),
  );
  await writeReleaseManifest(root);
  console.log('\n✅ Build complete.');
  console.log('   • dist/core/index.js          (Node API)');
  console.log('   • dist/cli/modelshift.mjs     (CLI)');
  console.log('   • dist/vendor/                 (shared Node runtime)');
  console.log('   • dist/client/index.html       (web UI)');
}

try {
  await build();
} catch (error) {
  console.error('\n❌ Build failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
