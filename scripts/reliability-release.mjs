#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureNames = ['cube.glb', 'animated-cube.glb', 'skinned-cube.glb', 'sphere.glb'];
const repetitions = 2;
const maxConcurrency = 8;
const { convertBatch } = await import(pathToFileURL(resolve(root, 'dist/core/index.js')).href);

const items = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const name of fixtureNames) {
    items.push({
      name,
      data: new Uint8Array(await readFile(resolve(root, 'test/fixtures', name))),
    });
  }
}

const progress = new Map();
const progressViolations = [];
const memoryBefore = process.memoryUsage();
const started = performance.now();
const result = await convertBatch(
  items,
  { outputFormat: 'fbx', maxConcurrency },
  (itemIndex, phase, pct) => {
    if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
      progressViolations.push({ itemIndex, phase, pct });
    }
    progress.set(itemIndex, { phase, pct });
  },
);
const elapsedMs = Number((performance.now() - started).toFixed(2));
const memoryAfter = process.memoryUsage();

const outputDigest = (data) => createHash('sha256').update(data).digest('hex');
const outputByName = new Map();
for (const item of result.succeeded) {
  const output =
    item.files.find((file) => file.name.toLowerCase().endsWith('.fbx')) ?? item.files[0];
  const entry = {
    name: item.filename,
    inputName: item.filename.replace(/\.fbx$/i, '.glb'),
    outputBytes: item.stats.outputBytes,
    sha256: outputDigest(output.data),
  };
  const values = outputByName.get(entry.inputName) ?? [];
  values.push(entry);
  outputByName.set(entry.inputName, values);
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  itemCount: items.length,
  maxConcurrency,
  elapsedMs,
  maxRssDeltaBytes: Math.max(0, memoryAfter.rss - memoryBefore.rss),
  maxHeapDeltaBytes: Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed),
  succeeded: result.succeeded.length,
  failed: result.failed,
  progressEvents: progress.size,
  progressViolations,
  outputs: [...outputByName.entries()].map(([inputName, outputs]) => ({ inputName, outputs })),
};

const outputPath = resolve(root, 'artifacts', 'reliability-baseline.json');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Wrote reliability baseline for ${items.length} concurrent conversions to ${outputPath}.`,
);
