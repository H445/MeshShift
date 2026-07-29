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
const viteCli = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');

// Invoke Vite through Node so this works cross-platform without shell parsing.
const child = spawn(process.execPath, [viteCli], {
  stdio: 'inherit',
  cwd: root,
});

child.on('error', (err) => {
  console.error('Failed to start Vite:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
