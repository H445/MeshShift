#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.MESHSHIFT_NODE_RUNTIME_VERSION ?? '24.19.0';
const platform = process.env.MESHSHIFT_NODE_RUNTIME_PLATFORM ?? process.platform;
const arch = process.env.MESHSHIFT_NODE_RUNTIME_ARCH ?? process.arch;
const output = resolve(
  process.env.MESHSHIFT_NODE_RUNTIME_OUTPUT ?? resolve(root, 'artifacts', 'node-runtime'),
);

const nodePlatform = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
const nodeArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
if (!['win', 'darwin', 'linux'].includes(nodePlatform) || !['x64', 'arm64'].includes(nodeArch)) {
  throw new Error(`Unsupported portable Node runtime target: ${nodePlatform}-${nodeArch}`);
}

const extension = nodePlatform === 'win' ? 'zip' : 'tar.gz';
const folder = `node-v${version}-${nodePlatform}-${nodeArch}`;
const archiveName = `${folder}.${extension}`;
const baseUrl = `https://nodejs.org/dist/v${version}`;
const checksums = await (await fetch(`${baseUrl}/SHASUMS256.txt`)).text();
if (!checksums.includes(archiveName))
  throw new Error(`Node runtime was not found in SHASUMS256.txt: ${archiveName}`);
const expected = checksums
  .split(/\r?\n/)
  .find((line) => line.endsWith(`  ${archiveName}`))
  ?.split(/\s+/)[0];
if (!expected) throw new Error(`No checksum found for ${archiveName}.`);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const archivePath = resolve(output, archiveName);
const archiveResponse = await fetch(`${baseUrl}/${archiveName}`);
if (!archiveResponse.ok || !archiveResponse.body)
  throw new Error(`Failed to download ${archiveName}.`);
await writeFile(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
const actual = createHash('sha256')
  .update(await readFile(archivePath))
  .digest('hex');
if (actual !== expected) throw new Error(`Node runtime checksum mismatch for ${archiveName}.`);

const extractDir = resolve(output, 'extracted');
await mkdir(extractDir, { recursive: true });
if (extension === 'zip' && process.platform === 'win32') {
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:MESHSHIFT_ARCHIVE_PATH -DestinationPath $env:MESHSHIFT_EXTRACT_DIR -Force',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MESHSHIFT_ARCHIVE_PATH: archivePath,
        MESHSHIFT_EXTRACT_DIR: extractDir,
      },
    },
  );
} else {
  await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], { cwd: root });
}
const runtimeRoot = resolve(extractDir, folder);
await writeFile(
  resolve(output, 'runtime-metadata.json'),
  `${JSON.stringify({ version, platform, arch, archiveName, sha256: actual }, null, 2)}\n`,
);
console.log(JSON.stringify({ runtimeRoot, archive: archivePath, sha256: actual }));
