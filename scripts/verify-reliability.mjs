#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const budget = JSON.parse(await readFile(resolve(root, 'docs/reliability-budgets.json'), 'utf8'));
const reportPath = resolve(
  root,
  process.env.MODELSHIFT_RELIABILITY_REPORT ?? 'artifacts/reliability-baseline.json',
);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const failures = [];

if (report.schemaVersion !== 1) failures.push('reliability report has an unsupported schema.');
if (report.itemCount !== budget.itemCount) {
  failures.push(`expected ${budget.itemCount} items, got ${report.itemCount}.`);
}
if (report.maxConcurrency !== budget.maxConcurrency) {
  failures.push(`expected max concurrency ${budget.maxConcurrency}, got ${report.maxConcurrency}.`);
}
if (!Number.isFinite(report.elapsedMs) || report.elapsedMs > budget.maxElapsedMs) {
  failures.push(`reliability run exceeded ${budget.maxElapsedMs} ms: ${report.elapsedMs} ms.`);
}
if (report.succeeded !== budget.itemCount || report.failed?.length !== 0) {
  failures.push(`expected ${budget.itemCount} successes and no failures.`);
}
if (report.progressViolations?.length !== 0) {
  failures.push(`progress validation reported ${report.progressViolations.length} violation(s).`);
}
if (!Number.isSafeInteger(report.progressEvents) || report.progressEvents < budget.itemCount) {
  failures.push('every concurrent conversion must report at least one progress event.');
}

const expectedNames = new Set(budget.fixtureNames);
const observedNames = new Set((report.outputs ?? []).map((group) => group.inputName));
for (const name of expectedNames) {
  if (!observedNames.has(name)) failures.push(`missing output group for ${name}.`);
}
if (observedNames.size !== expectedNames.size)
  failures.push('unexpected output groups were reported.');

for (const group of report.outputs ?? []) {
  if (!expectedNames.has(group.inputName)) continue;
  if (!Array.isArray(group.outputs) || group.outputs.length !== budget.repetitions) {
    failures.push(`${group.inputName} did not produce ${budget.repetitions} outputs.`);
    continue;
  }
  const digests = new Set();
  for (const output of group.outputs) {
    if (!Number.isSafeInteger(output.outputBytes) || output.outputBytes <= 0) {
      failures.push(`${group.inputName} produced an invalid output size.`);
    }
    if (!/^[a-f0-9]{64}$/.test(output.sha256)) {
      failures.push(`${group.inputName} produced an invalid output digest.`);
    }
    digests.add(output.sha256);
  }
  if (digests.size !== 1)
    failures.push(`${group.inputName} was not deterministic under concurrency.`);
}

if (failures.length > 0) {
  console.error('Reliability verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Reliability verification passed for ${report.itemCount} concurrent conversions.`);
}
