#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const readmePath = resolve(root, 'README.md');
const docsRoot = resolve(root, 'docs');
const docEntries = await readdir(docsRoot, { recursive: true });
const documentationPaths = [
  readmePath,
  ...docEntries.filter((entry) => entry.endsWith('.md')).map((entry) => resolve(docsRoot, entry)),
];
const documentation = await Promise.all(
  documentationPaths.map(async (path) => ({
    path,
    text: await readFile(path, 'utf8'),
  })),
);
const documentationText = documentation
  .map(({ text }) => text)
  .join('\n')
  .replace(/\s+/g, ' ');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const cliPath = resolve(root, 'dist/cli/meshshift.mjs');
const fixturePath = resolve(root, 'test/fixtures/cube.glb');

const run = (args) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `Command failed (${args.join(' ')}): ${result.stderr.trim() || result.stdout.trim()}`,
          ),
        );
        return;
      }
      resolveResult(result);
    });
  });

const requiredDocumentation = [
  'pnpm install',
  'pnpm build',
  'npm run release:check',
  'artifacts/test-results.json',
  'docs/RELEASE_APPROVAL_RECORD.md',
  'no model is uploaded to a remote service',
];
for (const text of requiredDocumentation) {
  if (!documentationText.includes(text)) {
    throw new Error(`Documentation is missing required text: ${text}`);
  }
}

const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
for (const { path, text } of documentation) {
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    await stat(resolve(path, '..', target));
  }
}

const help = await run([cliPath, '--help']);
if (!help.stdout.includes('--format') || !help.stdout.includes('--json')) {
  throw new Error('CLI help is missing documented options.');
}
const version = await run([cliPath, '--version']);
if (version.stdout.trim() !== packageJson.version) {
  throw new Error(
    `CLI version mismatch: expected ${packageJson.version}, got ${version.stdout.trim()}.`,
  );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'meshshift-docs-'));
try {
  await run([cliPath, fixturePath, '--output', temporaryRoot, '--json']);
  const cliOutput = new Uint8Array(await readFile(resolve(temporaryRoot, 'cube.fbx')));
  const cliStats = JSON.parse(await readFile(resolve(temporaryRoot, 'cube.stats.json'), 'utf8'));
  if (
    cliOutput.byteLength === 0 ||
    cliStats.triangles <= 0 ||
    cliStats.outputBytes !== cliOutput.byteLength
  ) {
    throw new Error('CLI documentation example produced invalid cube output.');
  }

  const { convertAsset } = await import(pathToFileURL(resolve(root, 'dist/core/index.js')).href);
  const apiResult = await convertAsset(new Uint8Array(await readFile(fixturePath)), {
    name: 'cube.glb',
    outputFormat: 'fbx',
  });
  if (apiResult.data.byteLength === 0 || apiResult.stats.triangles <= 0) {
    throw new Error('Core API documentation example produced invalid cube output.');
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Documentation verification passed: links, CLI examples, and core API example.');
