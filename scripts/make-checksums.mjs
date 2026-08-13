#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const dir = resolve(process.argv[process.argv.indexOf('--dir') + 1] ?? 'artifacts');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1] : join(dir, 'SHA256SUMS.txt'),
);
const files = (await readdir(dir, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(dir, entry.name))
  .filter((path) => path !== output);
const lines = [];
for (const path of files.sort()) {
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  lines.push(`${digest}  ${relative(dir, path).replaceAll('\\', '/')}`);
}
await writeFile(output, `${lines.join('\n')}\n`);
console.log(`Wrote ${basename(output)} for ${lines.length} files.`);
