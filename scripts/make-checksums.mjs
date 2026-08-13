#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const dir = resolve(process.argv[process.argv.indexOf('--dir') + 1] ?? 'artifacts');
const output = resolve(
  process.argv[process.argv.indexOf('--output') + 1] ?? join(dir, 'SHA256SUMS.txt'),
);
const files = [];

async function visit(current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (path === output) continue;
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile()) files.push(path);
  }
}

await visit(dir);
const lines = [];
for (const path of files.sort()) {
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  lines.push(`${digest}  ${relative(dir, path).replaceAll('\\', '/')}`);
}
await writeFile(output, `${lines.join('\n')}\n`);
console.log(`Wrote ${basename(output)} for ${lines.length} files.`);
