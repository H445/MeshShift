import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_FILES = [
  'dist/core/index.js',
  'dist/core/index.d.ts',
  'dist/cli/meshshift.mjs',
  'dist/vendor/assimpjs.js',
  'dist/vendor/assimpjs.wasm',
  'dist/client/index.html',
  'dist/client/THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'SHIP_READINESS_PLAN.md',
  'SHIP_READINESS_REPORT.md',
  'docs/RELEASE_CONTRACT.md',
  'docs/FORMAT_FEATURE_MATRIX.md',
  'docs/QUALITY_BUDGETS.md',
  'docs/THREAT_MODEL.md',
  'docs/OPERATIONS_RUNBOOK.md',
  'docs/RELEASE_APPROVAL_RECORD.md',
  'docs/REMEDIATION_PLAN.md',
  'docs/BROWSER_COMPATIBILITY_MATRIX.md',
  'docs/BROWSER_LOCAL_EVIDENCE.md',
  'docs/performance-budgets.json',
  'docs/performance-baseline.json',
  'docs/reliability-budgets.json',
];

export async function createReleaseManifest(root) {
  const files = [];
  for (const relativePath of RELEASE_FILES) {
    const data = await readFile(resolve(root, relativePath));
    const info = await stat(resolve(root, relativePath));
    files.push({
      path: relativePath,
      bytes: info.size,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  return {
    schemaVersion: 1,
    package: JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
    files,
  };
}

export async function writeReleaseManifest(root) {
  const manifest = await createReleaseManifest(root);
  await writeFile(
    resolve(root, 'dist/RELEASE-MANIFEST.json'),
    `${JSON.stringify(
      {
        schemaVersion: manifest.schemaVersion,
        package: {
          name: manifest.package.name,
          version: manifest.package.version,
        },
        files: manifest.files,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  await writeReleaseManifest(root);
  console.log('Wrote dist/RELEASE-MANIFEST.json.');
}
