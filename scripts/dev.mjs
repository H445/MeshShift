#!/usr/bin/env node
/**
 * Dev script — just starts Vite. No server to run; the web app is a pure
 * static SPA and the Vite dev server provides HMR for the client.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// On Windows, Node 24 refuses to spawn .cmd/.bat wrappers unless `shell: true`.
// We use `npx` directly through the shell so the .cmd lookup works everywhere.
const child = spawn('npx', ['vite'], {
  stdio: 'inherit',
  cwd: root,
  shell: isWin,
});

child.on('error', (err) => {
  console.error('Failed to start Vite:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
