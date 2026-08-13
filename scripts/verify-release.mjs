#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RELEASE_FILES } from './release-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requiredFiles = [...RELEASE_FILES, 'dist/RELEASE-MANIFEST.json'];

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const failures = [];

for (const relativePath of requiredFiles) {
  try {
    await access(resolve(root, relativePath));
  } catch {
    failures.push(`missing release artifact: ${relativePath}`);
  }
}

const cli = await readFile(resolve(root, 'dist/cli/meshshift.mjs'), 'utf8').catch(() => '');
if (!cli.startsWith('#!/usr/bin/env node'))
  failures.push('CLI artifact is missing its Node shebang.');

const client = await readFile(resolve(root, 'dist/client/index.html'), 'utf8').catch(() => '');
if (!client.includes('<title>MeshShift</title>')) {
  failures.push('browser artifact is missing the product title.');
}

const manifest = JSON.parse(
  await readFile(resolve(root, 'dist/RELEASE-MANIFEST.json'), 'utf8').catch(() => '{}'),
);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
  failures.push('release manifest is missing or has an unsupported schema.');
} else {
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const relativePath of RELEASE_FILES) {
    const entry = entries.get(relativePath);
    if (!entry || !Number.isSafeInteger(entry.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      failures.push(`release manifest has no valid entry for ${relativePath}.`);
      continue;
    }
    const data = await readFile(resolve(root, relativePath));
    const digest = createHash('sha256').update(data).digest('hex');
    if (data.byteLength !== entry.bytes || digest !== entry.sha256) {
      failures.push(`release artifact hash mismatch: ${relativePath}`);
    }
  }
}

if (packageJson.engines?.node !== '>=22') {
  failures.push('package metadata must declare Node.js >=22.');
}
if (packageJson.bin?.meshshift !== 'dist/cli/meshshift.mjs') {
  failures.push('package metadata points meshshift at an unexpected executable.');
}

if (failures.length > 0) {
  console.error('Release verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release verification passed for ${packageJson.name}@${packageJson.version}.`);
  console.log(`  ${requiredFiles.length} required artifacts present.`);
}
