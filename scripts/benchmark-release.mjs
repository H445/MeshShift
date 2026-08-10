#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = [
  'cube.glb',
  'animated-cube.glb',
  'skinned-cube.glb',
  'sphere.glb',
  'potion.glb',
  'item-bag.glb',
];
const iterations = 3;
const moduleLoadStarted = performance.now();
const { convertAsset } = await import(pathToFileURL(resolve(root, 'dist/core/index.js')).href);
const moduleLoadMs = Number((performance.now() - moduleLoadStarted).toFixed(2));
const measurements = [];
const collectGarbage = () => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
};

const measureCliStartup = () =>
  new Promise((resolveResult, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [resolve(root, 'dist/cli/meshshift.mjs'), '--help'], {
      cwd: root,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `CLI startup probe failed with code ${code ?? 'none'} and signal ${signal ?? 'none'}.`,
          ),
        );
        return;
      }
      resolveResult(Number((performance.now() - started).toFixed(2)));
    });
  });

const startupSamples = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  startupSamples.push(await measureCliStartup());
}

async function makeLargeBenchmarkSphere(latSegments = 128, lonSegments = 256) {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const document = new Document();
  document.createBuffer();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let lat = 0; lat <= latSegments; lat++) {
    const theta = (lat * Math.PI) / latSegments;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let lon = 0; lon <= lonSegments; lon++) {
      const phi = (lon * 2 * Math.PI) / lonSegments;
      const x = sinTheta * Math.cos(phi);
      const y = cosTheta;
      const z = sinTheta * Math.sin(phi);
      positions.push(x, y, z);
      normals.push(x, y, z);
      uvs.push(lon / lonSegments, lat / latSegments);
    }
  }
  for (let lat = 0; lat < latSegments; lat++) {
    for (let lon = 0; lon < lonSegments; lon++) {
      const a = lat * (lonSegments + 1) + lon;
      const b = a + lonSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const primitive = document
    .createPrimitive()
    .setAttribute(
      'POSITION',
      document.createAccessor().setArray(new Float32Array(positions)).setType('VEC3'),
    )
    .setAttribute(
      'NORMAL',
      document.createAccessor().setArray(new Float32Array(normals)).setType('VEC3'),
    )
    .setAttribute(
      'TEXCOORD_0',
      document.createAccessor().setArray(new Float32Array(uvs)).setType('VEC2'),
    )
    .setIndices(document.createAccessor().setArray(new Uint32Array(indices)).setType('SCALAR'));
  const mesh = document.createMesh('large-benchmark-sphere').addPrimitive(primitive);
  document.createScene('Scene').addChild(document.createNode('LargeSphere').setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

const benchmarkInputs = [];
for (const fixture of fixtures) {
  benchmarkInputs.push({
    fixture,
    input: new Uint8Array(await readFile(resolve(root, 'test/fixtures', fixture))),
  });
}
benchmarkInputs.push({
  fixture: 'generated-large-sphere.glb',
  input: await makeLargeBenchmarkSphere(),
});
benchmarkInputs.push({
  fixture: 'generated-maximum-sphere.glb',
  input: await makeLargeBenchmarkSphere(512, 1024),
});

for (const { fixture, input } of benchmarkInputs) {
  const samples = [];
  const cpuSamples = [];
  const inputThroughputSamples = [];
  const outputThroughputSamples = [];
  const rssDeltaBytes = [];
  const heapDeltaBytes = [];
  const retainedRssDeltaBytes = [];
  const retainedHeapDeltaBytes = [];
  let outputBytes = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    collectGarbage();
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const result = await convertAsset(input, { name: fixture, outputFormat: 'fbx' });
    const durationMs = Number((performance.now() - started).toFixed(2));
    const memoryAfter = process.memoryUsage();
    const cpuAfter = process.cpuUsage(cpuBefore);
    const cpuMs = Number(((cpuAfter.user + cpuAfter.system) / 1000).toFixed(2));
    samples.push(durationMs);
    cpuSamples.push(cpuMs);
    inputThroughputSamples.push(
      Number((input.byteLength / 1024 / 1024 / (durationMs / 1000)).toFixed(2)),
    );
    outputThroughputSamples.push(
      Number((result.stats.outputBytes / 1024 / 1024 / (durationMs / 1000)).toFixed(2)),
    );
    rssDeltaBytes.push(Math.max(0, memoryAfter.rss - memoryBefore.rss));
    heapDeltaBytes.push(Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed));
    outputBytes = result.stats.outputBytes;
    collectGarbage();
    const memoryRetained = process.memoryUsage();
    retainedRssDeltaBytes.push(Math.max(0, memoryRetained.rss - memoryBefore.rss));
    retainedHeapDeltaBytes.push(Math.max(0, memoryRetained.heapUsed - memoryBefore.heapUsed));
  }
  measurements.push({
    fixture,
    inputBytes: input.byteLength,
    outputBytes,
    iterations,
    durationMs: samples,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    meanMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)),
    cpuMs: cpuSamples,
    maxCpuMs: Math.max(...cpuSamples),
    meanCpuMs: Number(
      (cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length).toFixed(2),
    ),
    inputThroughputMiBPerSec: inputThroughputSamples,
    outputThroughputMiBPerSec: outputThroughputSamples,
    meanInputThroughputMiBPerSec: Number(
      (
        inputThroughputSamples.reduce((sum, value) => sum + value, 0) /
        inputThroughputSamples.length
      ).toFixed(2),
    ),
    meanOutputThroughputMiBPerSec: Number(
      (
        outputThroughputSamples.reduce((sum, value) => sum + value, 0) /
        outputThroughputSamples.length
      ).toFixed(2),
    ),
    maxRssDeltaBytes: Math.max(...rssDeltaBytes),
    maxHeapDeltaBytes: Math.max(...heapDeltaBytes),
    maxRetainedRssDeltaBytes: Math.max(...retainedRssDeltaBytes),
    maxRetainedHeapDeltaBytes: Math.max(...retainedHeapDeltaBytes),
  });
}

const outputPath = resolve(root, 'artifacts', 'benchmark-baseline.json');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      startup: {
        moduleLoadMs,
        cliHelpMs: startupSamples,
        minCliHelpMs: Math.min(...startupSamples),
        maxCliHelpMs: Math.max(...startupSamples),
        meanCliHelpMs: Number(
          (startupSamples.reduce((sum, value) => sum + value, 0) / startupSamples.length).toFixed(
            2,
          ),
        ),
      },
      measurements,
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote benchmark baseline for ${measurements.length} fixtures to ${outputPath}.`);
