#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = resolve(option('--input', resolve(root, 'artifacts', 'portable-cli')));
const output = resolve(option('--output', resolve(root, 'artifacts', 'meshshift-cli.tar.gz')));
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
const archiveFormat = output.toLowerCase().endsWith('.zip') ? 'zip' : 'tar.gz';
const args = archiveFormat === 'zip' ? ['-a', '-c', '-f', output, '.'] : ['-czf', output, '.'];
await execFileAsync('tar', args, { cwd: input });
console.log(`Wrote ${output}.`);
