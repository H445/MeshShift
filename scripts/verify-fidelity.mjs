#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const report = JSON.parse(
  await readFile(resolve(root, 'artifacts', 'fidelity-baseline.json'), 'utf8'),
);
const expected = new Map([
  ['cube.glb', { animations: 0, bones: 0, textures: 0 }],
  ['animated-cube.glb', { animations: 1, bones: 0, textures: 0 }],
  ['skinned-cube.glb', { animations: 0, bones: 2, textures: 0 }],
  ['sphere.glb', { animations: 0, bones: 0, textures: 0 }],
  ['potion.glb', { animations: 0, bones: 0, textures: 2 }],
  ['item-bag.glb', { animations: 0, bones: 0, textures: 2 }],
]);

function fail(message) {
  throw new Error(`Fidelity verification failed: ${message}`);
}

function finite(value, label) {
  if (!Number.isFinite(value)) fail(`${label} is not finite.`);
}

function close(left, right, tolerance, label) {
  if (Math.abs(left - right) > tolerance) {
    fail(`${label} differs by ${Math.abs(left - right)}.`);
  }
}

if (report.schemaVersion !== 1) fail(`unsupported schema version ${report.schemaVersion}.`);
if (report.bboxTolerance !== 1e-3) fail('the declared bounding-box tolerance changed.');
if (!Array.isArray(report.fixtures) || report.fixtures.length !== expected.size) {
  fail(`expected ${expected.size} fixture rows.`);
}

for (const row of report.fixtures) {
  const required = expected.get(row.name);
  if (!required) fail(`unexpected fixture ${row.name}.`);
  for (const [feature, count] of Object.entries(required)) {
    if (row.source[feature] !== count) fail(`${row.name} source ${feature} baseline drifted.`);
    if (row.glb.metadata[feature] !== count) fail(`${row.name} GLB ${feature} was not retained.`);
  }
  if (row.source.triangles <= 0 || row.glb.metadata.triangles !== row.source.triangles) {
    fail(`${row.name} triangle count changed.`);
  }
  if (row.fbx.bytes <= 64 || row.fbx.stats.meshes <= 0 || row.fbx.stats.triangles <= 0) {
    fail(`${row.name} FBX output is not structurally valid.`);
  }
  if (!Array.isArray(row.fbx.meshCardinality) || row.fbx.meshCardinality.length === 0) {
    fail(`${row.name} has no FBX mesh cardinality evidence.`);
  }
  for (const axis of ['bboxMin', 'bboxMax']) {
    for (let index = 0; index < 3; index++) {
      finite(row.source[axis][index], `${row.name} source ${axis}[${index}]`);
      finite(row.glb.metadata[axis][index], `${row.name} GLB ${axis}[${index}]`);
      close(
        row.glb.metadata[axis][index],
        row.source[axis][index],
        report.bboxTolerance,
        `${row.name} ${axis}[${index}]`,
      );
    }
  }
}

console.log(`Fidelity verification passed for ${report.fixtures.length} fixtures.`);
