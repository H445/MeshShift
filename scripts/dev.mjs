#!/usr/bin/env node
/**
 * Shared development entry point used by the root PowerShell/POSIX launchers
 * and the package-manager `dev` command.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const viteCli = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

if (nodeMajor < 20) {
  console.error(`ModelShift requires Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

if (!existsSync(viteCli)) {
  console.error('ModelShift dependencies are not installed. Run "pnpm install" first.');
  process.exit(1);
}

// Invoke Vite through Node so this works cross-platform without shell parsing.
const child = spawn(process.execPath, [viteCli, ...process.argv.slice(2)], {
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
