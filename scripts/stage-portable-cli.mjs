#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(
  process.env.MESHSHIFT_PORTABLE_APP_OUTPUT ?? resolve(root, 'artifacts', 'portable-app'),
);
await rm(output, { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
const pnpm = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const pnpmArgs = process.platform === 'win32' ? ['pnpm'] : ['pnpm'];
const deployTarget = process.platform === 'win32' ? `"${output}"` : output;
await execFileAsync(
  pnpm,
  [...pnpmArgs, '--filter', '.', 'deploy', '--prod', '--no-optional', '--legacy', deployTarget],
  {
    cwd: root,
    env: { ...process.env, CI: 'true' },
    shell: process.platform === 'win32',
    maxBuffer: 4 * 1024 * 1024,
  },
);
console.log(`Portable CLI app staged at ${output}.`);
