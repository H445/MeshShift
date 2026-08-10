#!/usr/bin/env node
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = resolve(root, 'dist/cli/meshshift.mjs');
const inputPath = resolve(root, 'test/fixtures/potion.glb');
await access(cliPath);
await access(inputPath);

const outputRoot = await mkdtemp(join(tmpdir(), 'meshshift-interruption-'));
try {
  const child = spawn(
    process.execPath,
    [
      cliPath,
      inputPath,
      '--output',
      outputRoot,
      '--parallel',
      '1',
      '--generate-lods',
      '8',
      '--max-triangles',
      '1000',
      '--json',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const sent = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise(child.kill('SIGINT')), 100);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
  const entries = await readdir(outputRoot);
  const temporaryEntries = entries.filter((entry) => entry.endsWith('.tmp'));
  const graceful = result.code === 130 && /cancell|SIGINT/i.test(stderr);
  const hardInterrupted = result.signal === 'SIGINT' || result.signal === 'SIGTERM';

  if (
    !sent ||
    (!graceful && !hardInterrupted) ||
    entries.length !== 0 ||
    temporaryEntries.length !== 0
  ) {
    throw new Error(
      `CLI interruption verification failed: ${JSON.stringify({
        sent,
        ...result,
        entries,
        temporaryEntries,
        graceful,
        hardInterrupted,
      })}`,
    );
  }

  console.log(
    `CLI interruption verification passed (${graceful ? 'graceful cancellation' : result.signal}).`,
  );
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
