#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configuredPnpm = process.env.MESHSHIFT_PNPM;
const configuredScript = process.env.MESHSHIFT_PNPM_SCRIPT;
const pnpm =
  configuredPnpm ??
  (process.platform === 'win32'
    ? resolve(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    : 'pnpm');
const pnpmArgs = configuredScript
  ? [configuredScript]
  : process.platform === 'win32' && !configuredPnpm
    ? [pnpm]
    : [];
const pnpmCommand = process.platform === 'win32' && !configuredPnpm ? process.execPath : pnpm;
const pnpmExecOptions = {
  cwd: root,
  maxBuffer: 32 * 1024 * 1024,
};

function packageRef(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function collectTree(node, components, dependencies, seen) {
  const dependenciesByName = node.dependencies ?? {};
  for (const [name, dependency] of Object.entries(dependenciesByName)) {
    if (!dependency || typeof dependency !== 'object' || typeof dependency.version !== 'string')
      continue;
    const ref = packageRef(name, dependency.version);
    if (!seen.has(ref)) {
      seen.add(ref);
      components.push({
        type: 'library',
        bomRef: ref,
        name,
        version: dependency.version,
        purl: ref,
      });
    }
    const childRefs = Object.entries(dependency.dependencies ?? {})
      .filter(
        ([, child]) => child && typeof child === 'object' && typeof child.version === 'string',
      )
      .map(([childName, child]) => packageRef(childName, child.version));
    dependencies.push({ ref, dependsOn: childRefs });
    collectTree(dependency, components, dependencies, seen);
  }
}

const { stdout } = await execFileAsync(
  pnpmCommand,
  [...pnpmArgs, 'list', '--prod', '--depth', 'Infinity', '--json'],
  pnpmExecOptions,
);
const tree = JSON.parse(stdout)[0] ?? {};
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const components = [];
const dependencies = [];
const seen = new Set();
collectTree(tree, components, dependencies, seen);

const output = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      bomRef: packageRef(packageJson.name, packageJson.version),
      name: packageJson.name,
      version: packageJson.version,
    },
  },
  components: components.sort((a, b) => a.purl.localeCompare(b.purl)),
  dependencies,
};

const outputPath = resolve(root, 'artifacts', 'sbom.cdx.json');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${output.components.length} production components to ${outputPath}.`);
