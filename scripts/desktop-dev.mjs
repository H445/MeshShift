#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronCli = resolve(root, 'node_modules', 'electron', 'cli.js');
const port = 5173;

function runBuild() {
  const result = spawnSync(npmCommand, ['run', 'desktop:build'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function waitForPort(host, expectedPort) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.createConnection({ host, port: expectedPort });
      socket.once('connect', () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > 30_000) {
          reject(new Error(`Timed out waiting for Vite on ${host}:${expectedPort}.`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

if (!existsSync(electronCli)) {
  console.error('Electron is not installed. Run "pnpm install" first.');
  process.exit(1);
}

runBuild();
const vite = spawn(process.execPath, [resolve(root, 'scripts', 'dev.mjs'), '--host', '127.0.0.1'], {
  cwd: root,
  stdio: 'inherit',
});
let stopping = false;
let electron = null;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  vite.kill('SIGTERM');
  electron?.kill('SIGTERM');
  process.exitCode = code;
};

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
vite.once('exit', (code) => {
  if (!stopping && code !== 0) stop(code ?? 1);
});

try {
  await waitForPort('127.0.0.1', port);
  electron = spawn(process.execPath, [electronCli, resolve(root, 'dist', 'desktop', 'main.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      MESHSHIFT_ELECTRON_DEV_URL: `http://127.0.0.1:${port}/`,
    },
    stdio: 'inherit',
  });
  electron.once('exit', (code) => stop(code ?? 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
