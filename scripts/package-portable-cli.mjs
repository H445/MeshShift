#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const output = resolve(option('--output', resolve(root, 'artifacts', 'portable-cli')));
const appDir = resolve(option('--app-dir', resolve(output, 'app')));
const platform = option('--platform', process.platform);
const arch = option('--arch', process.arch);
const runtimeVersion = process.env.MESHSHIFT_NODE_RUNTIME_VERSION ?? '24.19.0';
const runtimePlatform = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux';
const runtimeRoot = resolve(
  option(
    '--runtime-root',
    resolve(
      root,
      'artifacts',
      'node-runtime',
      'extracted',
      `node-v${runtimeVersion}-${runtimePlatform}-${arch}`,
    ),
  ),
);

if (!runtimeRoot || !existsSync(runtimeRoot)) {
  throw new Error('Pass --runtime-root pointing to an extracted official Node.js runtime.');
}
if (!existsSync(resolve(appDir, 'dist', 'cli', 'meshshift.mjs'))) {
  throw new Error(`Portable CLI app directory is missing dist/cli/meshshift.mjs: ${appDir}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(appDir, resolve(output, 'app'), { recursive: true, dereference: true });
// Copy the extracted runtime contents so the launcher can use the stable
// runtime/node.exe or runtime/bin/node path regardless of the archive folder.
await cp(runtimeRoot, resolve(output, 'runtime'), { recursive: true, dereference: true });

const packageJson = JSON.parse(await readFile(resolve(appDir, 'package.json'), 'utf8'));
const version = packageJson.version;
const nodeExecutable = platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node';
const launcherName = platform === 'win32' ? 'meshshift.cmd' : 'meshshift';
const launcher =
  platform === 'win32'
    ? `@echo off\r\n"%~dp0${nodeExecutable}" "%~dp0app\\dist\\cli\\meshshift.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/usr/bin/env sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$SCRIPT_DIR/${nodeExecutable}" "$SCRIPT_DIR/app/dist/cli/meshshift.mjs" "$@"\n`;
await writeFile(resolve(output, launcherName), launcher, { mode: 0o755 });
await writeFile(
  resolve(output, 'README.txt'),
  [
    `MeshShift ${version} portable CLI`,
    '',
    `Platform: ${platform}-${arch}`,
    '',
    platform === 'win32'
      ? 'Run meshshift.cmd from PowerShell or Command Prompt.'
      : 'Run ./meshshift from a shell.',
    'This archive contains its own Node.js runtime and does not require Node installed on the host.',
    'See app/docs/CLI.md for command usage and app/THIRD_PARTY_NOTICES.md for licenses.',
    '',
  ].join('\n'),
);
console.log(`Portable CLI staged at ${output} using ${basename(runtimeRoot)}.`);
