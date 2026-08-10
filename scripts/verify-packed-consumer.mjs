#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archiveArgument = process.argv[2];
if (!archiveArgument) throw new Error('Usage: node scripts/verify-packed-consumer.mjs <archive>');

const archivePath = resolve(root, archiveArgument);
await access(archivePath);
const consumerRoot = await mkdtemp(join(tmpdir(), 'modelshift-packed-consumer-'));
const npmCache = resolve(root, '.cache', 'packed-consumer-npm-cache');
await mkdir(npmCache, { recursive: true });

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    ...options,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: npmCache, ...options.env },
  });
}

const npmCliCandidates = [
  resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  resolve(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
];
let npmCli;
for (const candidate of npmCliCandidates) {
  try {
    await access(candidate);
    npmCli = candidate;
    break;
  } catch {
    // Try the next Node installation layout.
  }
}
if (!npmCli) throw new Error('Could not locate the npm CLI next to the current Node executable.');

try {
  await writeFile(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify({ name: 'modelshift-packed-consumer', private: true }, null, 2)}\n`,
  );
  await run(process.execPath, [
    npmCli,
    'install',
    '--prefix',
    consumerRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    archivePath,
  ]);

  const cliPath = resolve(
    consumerRoot,
    'node_modules',
    'modelshift',
    'dist',
    'cli',
    'modelshift.mjs',
  );
  const fixturePath = resolve(root, 'test/fixtures/cube.glb');
  const outputRoot = resolve(consumerRoot, 'output');
  const { stdout: versionOutput } = await run(process.execPath, [cliPath, '--version']);
  const { stdout: helpOutput } = await run(process.execPath, [cliPath, '--help']);
  await run(process.execPath, [cliPath, fixturePath, '--output', outputRoot, '--json']);

  const statsPath = join(outputRoot, 'cube.stats.json');
  const fbxPath = join(outputRoot, 'cube.fbx');
  const stats = JSON.parse(await readFile(statsPath, 'utf8'));
  const fbx = await readFile(fbxPath);
  if (!/Usage: modelshift/.test(helpOutput) || !/^\d+\.\d+\.\d+$/.test(versionOutput.trim())) {
    throw new Error('Packed consumer CLI help/version output is invalid.');
  }
  if (!Number.isSafeInteger(stats.triangles) || stats.triangles <= 0 || fbx.byteLength <= 64) {
    throw new Error('Packed consumer conversion did not produce valid output statistics.');
  }

  const report = {
    schemaVersion: 1,
    packageArchive: basename(archivePath),
    packageSha256: createHash('sha256')
      .update(await readFile(archivePath))
      .digest('hex'),
    version: versionOutput.trim(),
    outputBytes: fbx.byteLength,
    outputSha256: createHash('sha256').update(fbx).digest('hex'),
    triangles: stats.triangles,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const reportPath = resolve(root, 'artifacts', 'packed-consumer-smoke.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Packed consumer verification passed for ${archivePath}.`);
  console.log(`Wrote packed consumer evidence to ${reportPath}.`);
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}
