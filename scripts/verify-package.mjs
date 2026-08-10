#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cachePath = resolve(root, '.cache', 'npm-pack-cache');
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

const requiredFiles = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'SHIP_READINESS_PLAN.md',
  'SHIP_READINESS_REPORT.md',
  'dist/core/index.js',
  'dist/core/index.d.ts',
  'dist/cli/modelshift.mjs',
  'dist/client/index.html',
  'dist/vendor/assimpjs.js',
  'dist/vendor/assimpjs.wasm',
  'dist/RELEASE-MANIFEST.json',
  'docs/RELEASE_CONTRACT.md',
  'docs/RELEASE_APPROVAL_RECORD.md',
  'docs/REMEDIATION_PLAN.md',
  'docs/BROWSER_LOCAL_EVIDENCE.md',
]);

const forbidden = [
  /^(?:\.cache|artifacts|exports|node_modules|src|test|\.git|\.idea)(?:\/|$)/i,
  /(^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx|crt|cer|secret))(?:$|\/)/i,
  /\.map$/i,
  /(^|\/)\.npmrc$/i,
];

function isAllowed(path) {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === 'package.json') return true;
  return packageJson.files.some((entry) => {
    const prefix = entry.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

await mkdir(cachePath, { recursive: true });
const npmCli = process.env.npm_execpath?.toLowerCase().endsWith('npm-cli.js')
  ? process.env.npm_execpath
  : resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const { stdout } = await execFileAsync(
  process.execPath,
  [
    npmCli,
    'pack',
    '--dry-run',
    '--json',
    '--ignore-scripts',
    '--loglevel=error',
    '--cache',
    cachePath,
  ],
  { cwd: root, maxBuffer: 8 * 1024 * 1024 },
);

let result;
try {
  result = JSON.parse(stdout);
} catch (error) {
  throw new Error(`npm pack returned invalid JSON: ${error.message}`);
}

const pack = Array.isArray(result) ? result[0] : undefined;
const files = Array.isArray(pack?.files) ? pack.files : [];
const failures = [];
if (!pack || files.length === 0) failures.push('npm pack returned no file list.');
if (Number.isSafeInteger(pack?.unpackedSize) && pack.unpackedSize > MAX_UNPACKED_BYTES) {
  failures.push(
    `packed artifact is ${pack.unpackedSize} bytes unpacked; maximum is ${MAX_UNPACKED_BYTES}.`,
  );
}

const paths = new Set();
for (const entry of files) {
  const path = typeof entry?.path === 'string' ? entry.path.replace(/\\/g, '/') : '';
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    failures.push(`invalid path in packed artifact: ${entry?.path ?? '<missing>'}`);
    continue;
  }
  if (!isAllowed(path)) failures.push(`unexpected packed path: ${path}`);
  if (forbidden.some((pattern) => pattern.test(path))) {
    failures.push(`forbidden material in packed artifact: ${path}`);
  }
  paths.add(path);
}

for (const required of requiredFiles) {
  if (!paths.has(required)) failures.push(`required packed file is missing: ${required}`);
}

if (failures.length > 0) {
  console.error('Package-content verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Package-content verification passed: ${files.length} files, ${pack.unpackedSize} unpacked bytes.`,
  );
}
