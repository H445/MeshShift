#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(
  root,
  process.env.MESHSHIFT_BENCHMARK_REPORT ?? 'artifacts/benchmark-baseline.json',
);
const budgets = JSON.parse(await readFile(resolve(root, 'docs/performance-budgets.json'), 'utf8'));
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const failures = [];

if (report.schemaVersion !== 2 || !Array.isArray(report.measurements)) {
  failures.push('benchmark report is missing schemaVersion 2 or measurements.');
}
if (
  !report.startup ||
  !Number.isFinite(report.startup.moduleLoadMs) ||
  !Array.isArray(report.startup.cliHelpMs) ||
  report.startup.cliHelpMs.length < 3 ||
  report.startup.cliHelpMs.some((value) => !Number.isFinite(value) || value < 0)
) {
  failures.push('benchmark report is missing valid startup measurements.');
}

const measurements = new Map((report.measurements ?? []).map((item) => [item.fixture, item]));
for (const [fixture, budget] of Object.entries(budgets.fixtures)) {
  const measurement = measurements.get(fixture);
  if (!measurement) {
    failures.push(`missing benchmark measurement for ${fixture}.`);
    continue;
  }
  if (budget.inputBytes !== undefined && measurement.inputBytes !== budget.inputBytes) {
    failures.push(
      `${fixture} input size changed: expected ${budget.inputBytes}, got ${measurement.inputBytes}.`,
    );
  }
  if (
    !Number.isSafeInteger(measurement.iterations) ||
    measurement.iterations < budgets.minimumIterations
  ) {
    failures.push(`${fixture} has fewer than ${budgets.minimumIterations} benchmark iterations.`);
  }
  if (
    !Array.isArray(measurement.durationMs) ||
    measurement.durationMs.length !== measurement.iterations ||
    measurement.durationMs.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    failures.push(`${fixture} has invalid duration samples.`);
  } else if (Math.max(...measurement.durationMs) > budget.maxSampleMs) {
    failures.push(
      `${fixture} exceeds ${budget.maxSampleMs} ms: ${Math.max(...measurement.durationMs).toFixed(2)} ms.`,
    );
  }
  for (const [field, values] of [
    ['cpuMs', measurement.cpuMs],
    ['inputThroughputMiBPerSec', measurement.inputThroughputMiBPerSec],
    ['outputThroughputMiBPerSec', measurement.outputThroughputMiBPerSec],
  ]) {
    if (
      !Array.isArray(values) ||
      values.length !== measurement.iterations ||
      values.some((value) => !Number.isFinite(value) || value < 0)
    ) {
      failures.push(`${fixture} has invalid ${field} samples.`);
    }
  }
  for (const field of [
    'maxCpuMs',
    'meanCpuMs',
    'meanInputThroughputMiBPerSec',
    'meanOutputThroughputMiBPerSec',
    'maxRetainedRssDeltaBytes',
    'maxRetainedHeapDeltaBytes',
  ]) {
    if (!Number.isFinite(measurement[field]) || measurement[field] < 0) {
      failures.push(`${fixture} has invalid ${field}.`);
    }
  }
  if (
    !Number.isSafeInteger(measurement.outputBytes) ||
    measurement.outputBytes > budget.maxOutputBytes
  ) {
    failures.push(
      `${fixture} exceeds ${budget.maxOutputBytes} output bytes: ${measurement.outputBytes}.`,
    );
  }
  if (
    budget.maxRssDeltaBytes !== undefined &&
    (!Number.isSafeInteger(measurement.maxRssDeltaBytes) ||
      measurement.maxRssDeltaBytes > budget.maxRssDeltaBytes)
  ) {
    failures.push(
      `${fixture} exceeds ${budget.maxRssDeltaBytes} RSS delta bytes: ${measurement.maxRssDeltaBytes}.`,
    );
  }
  if (
    budget.maxHeapDeltaBytes !== undefined &&
    (!Number.isSafeInteger(measurement.maxHeapDeltaBytes) ||
      measurement.maxHeapDeltaBytes > budget.maxHeapDeltaBytes)
  ) {
    failures.push(
      `${fixture} exceeds ${budget.maxHeapDeltaBytes} heap delta bytes: ${measurement.maxHeapDeltaBytes}.`,
    );
  }
}

for (const fixture of measurements.keys()) {
  if (!Object.hasOwn(budgets.fixtures, fixture))
    failures.push(`unexpected benchmark fixture: ${fixture}.`);
}

if (failures.length > 0) {
  console.error('Benchmark verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Benchmark verification passed for ${measurements.size} fixtures.`);
}
