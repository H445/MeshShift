/**
 * Conversion tests — covers happy path, error cases, and the bulk API.
 * Round-trip validation (load output FBX back) lives in roundtrip.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertAsset,
  convertGltfToFbx,
  convertBatch,
  InputTooLargeError,
} from '../src/core/index.js';
import { makeProgress } from '../src/core/progress.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, 'fixtures');

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixturesDir, name)));
}

function makeSelfContainedGltf(): Uint8Array {
  const positionBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const indexBytes = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);
  const binary = new Uint8Array(positionBytes.byteLength + indexBytes.byteLength);
  binary.set(positionBytes);
  binary.set(indexBytes, positionBytes.byteLength);
  const document = {
    asset: { version: '2.0' },
    buffers: [
      {
        uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}`,
        byteLength: binary.byteLength,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength },
      {
        buffer: 0,
        byteOffset: positionBytes.byteLength,
        byteLength: indexBytes.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return new TextEncoder().encode(JSON.stringify(document));
}

describe('convertGltfToFbx', () => {
  it('rejects a conversion that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('cancel before parse');

    await expect(
      convertAsset(load('cube.glb'), {
        name: 'cube.glb',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'cancel before parse' });
  });

  it('stops at a cooperative progress boundary after cancellation', async () => {
    const controller = new AbortController();

    await expect(
      convertAsset(load('cube.glb'), {
        name: 'cube.glb',
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('converts cube.glb to a non-empty FBX', async () => {
    const result = await convertGltfToFbx(load('cube.glb'), { name: 'cube.glb' });
    expect(result.data.byteLength).toBeGreaterThan(64);
    expect(result.filename).toBe('cube.fbx');
    // FBX 7.4 binary magic
    const magic = new TextDecoder().decode(result.data.slice(0, 23));
    expect(magic.startsWith('Kaydara FBX Binary')).toBe(true);
  });

  it('converts animated-cube.glb', async () => {
    const result = await convertGltfToFbx(load('animated-cube.glb'), { name: 'animated-cube.glb' });
    expect(result.data.byteLength).toBeGreaterThan(64);
    expect(result.stats.animations).toBe(1);
  });

  it('converts skinned-cube.glb (with bones)', async () => {
    const result = await convertGltfToFbx(load('skinned-cube.glb'), { name: 'skinned-cube.glb' });
    expect(result.data.byteLength).toBeGreaterThan(64);
    expect(result.stats.bones).toBeGreaterThan(0);
  });

  it('converts a self-contained .gltf JSON document', async () => {
    const result = await convertGltfToFbx(makeSelfContainedGltf(), { name: 'triangle.gltf' });
    expect(result.data.byteLength).toBeGreaterThan(64);
    expect(result.filename).toBe('triangle.fbx');
    expect(result.stats.meshes).toBe(1);
  });

  it('records input and output byte sizes', async () => {
    const input = load('cube.glb');
    const result = await convertGltfToFbx(input, { name: 'cube.glb' });
    expect(result.stats.inputBytes).toBe(input.byteLength);
    expect(result.stats.outputBytes).toBe(result.data.byteLength);
  });

  it('rejects inputs exceeding the size cap', async () => {
    const prev = process.env.G2F_MAX_FILE_MB;
    process.env.G2F_MAX_FILE_MB = '0'; // 0 MB cap
    try {
      await expect(convertGltfToFbx(load('cube.glb'), { name: 'cube.glb' })).rejects.toBeInstanceOf(
        InputTooLargeError,
      );
    } finally {
      if (prev === undefined) delete process.env.G2F_MAX_FILE_MB;
      else process.env.G2F_MAX_FILE_MB = prev;
    }
  });

  it('allows trusted generated intermediates to exceed the external input cap', async () => {
    const prev = process.env.G2F_MAX_FILE_MB;
    process.env.G2F_MAX_FILE_MB = '0';
    try {
      await expect(
        convertAsset(
          { name: 'cube.glb', data: load('cube.glb') },
          {
            name: 'cube.glb',
            outputFormat: 'fbx',
            allowOversizedInput: true,
          },
        ),
      ).resolves.toMatchObject({ filename: 'cube.fbx' });
    } finally {
      if (prev === undefined) delete process.env.G2F_MAX_FILE_MB;
      else process.env.G2F_MAX_FILE_MB = prev;
    }
  });

  it('falls back to the default size cap when the environment value is invalid', async () => {
    const prev = process.env.G2F_MAX_FILE_MB;
    process.env.G2F_MAX_FILE_MB = 'not-a-number';
    try {
      await expect(convertGltfToFbx(load('cube.glb'), { name: 'cube.glb' })).resolves.toMatchObject(
        { filename: 'cube.fbx' },
      );
    } finally {
      if (prev === undefined) delete process.env.G2F_MAX_FILE_MB;
      else process.env.G2F_MAX_FILE_MB = prev;
    }
  });

  it('falls back when the configured size cap would overflow a safe byte count', async () => {
    const prev = process.env.G2F_MAX_FILE_MB;
    process.env.G2F_MAX_FILE_MB = '1e308';
    try {
      await expect(convertGltfToFbx(load('cube.glb'), { name: 'cube.glb' })).resolves.toMatchObject(
        { filename: 'cube.fbx' },
      );
    } finally {
      if (prev === undefined) delete process.env.G2F_MAX_FILE_MB;
      else process.env.G2F_MAX_FILE_MB = prev;
    }
  });

  it('rejects unsafe in-memory companion names before parsing', async () => {
    await expect(
      convertAsset(
        [
          { name: 'model.gltf', data: new Uint8Array([1]) },
          { name: '../outside.bin', data: new Uint8Array([2]) },
        ],
        { outputFormat: 'glb' },
      ),
    ).rejects.toThrow('safe relative path');
  });

  it('rejects invalid public optimization options instead of silently clamping them', async () => {
    await expect(
      convertAsset(load('cube.glb'), { outputFormat: 'glb', generateLODs: 9 }),
    ).rejects.toThrow('generateLODs must be an integer');
    await expect(
      convertAsset(load('cube.glb'), { outputFormat: 'glb', maxTriangles: Number.NaN }),
    ).rejects.toThrow('maxTriangles must be an integer');
  });

  it('rejects oversized input bundles before parsing', async () => {
    const files = Array.from({ length: 4_097 }, (_, index) => ({
      name: `file-${index}.bin`,
      data: new Uint8Array([index % 256]),
    }));
    await expect(convertAsset(files, { outputFormat: 'glb' })).rejects.toThrow(
      'cannot contain more than 4096 files',
    );
  });

  it('throws ParseError on garbage input', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(convertGltfToFbx(garbage, { name: 'garbage.glb' })).rejects.toThrow();
  });
});

describe('convertBatch', () => {
  it('converts multiple files', async () => {
    const names = ['cube.glb', 'animated-cube.glb', 'skinned-cube.glb'];
    const result = await convertBatch(
      names.map((n) => ({ name: n, data: load(n) })),
      { maxConcurrency: 2 },
    );
    expect(result.succeeded.length).toBe(3);
    expect(result.failed.length).toBe(0);
  });

  it('reports partial failures without aborting siblings', async () => {
    const result = await convertBatch(
      [
        { name: 'cube.glb', data: load('cube.glb') },
        { name: 'garbage.glb', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
        { name: 'animated-cube.glb', data: load('animated-cube.glb') },
      ],
      { maxConcurrency: 3 },
    );
    expect(result.succeeded.length).toBe(2);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].name).toBe('garbage.glb');
  });

  it('preserves input order in succeeded/failed arrays', async () => {
    const result = await convertBatch(
      [
        { name: 'animated-cube.glb', data: load('animated-cube.glb') },
        { name: 'cube.glb', data: load('cube.glb') },
        { name: 'skinned-cube.glb', data: load('skinned-cube.glb') },
      ],
      { maxConcurrency: 3 },
    );
    const order = result.succeeded.map((r) => r.filename);
    expect(order).toEqual(['animated-cube.fbx', 'cube.fbx', 'skinned-cube.fbx']);
  });

  it('preserves order when inputs have duplicate filenames', async () => {
    const first = load('animated-cube.glb');
    const second = load('cube.glb');
    const result = await convertBatch(
      [
        { name: 'duplicate.glb', data: first },
        { name: 'duplicate.glb', data: second },
      ],
      { maxConcurrency: 2 },
    );
    expect(result.failed).toHaveLength(0);
    expect(result.succeeded.map((item) => item.stats.inputBytes)).toEqual([
      first.byteLength,
      second.byteLength,
    ]);
  });

  it('reports cooperative cancellation for every batch item without rejecting the batch promise', async () => {
    const controller = new AbortController();
    const result = await convertBatch(
      ['cube.glb', 'animated-cube.glb', 'skinned-cube.glb'].map((name) => ({
        name,
        data: load(name),
      })),
      { maxConcurrency: 2, signal: controller.signal },
      (_index, phase) => {
        if (phase === 'parse') controller.abort('batch cancelled');
      },
    );

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(3);
    expect(result.failed.every((failure) => failure.error.name === 'AbortError')).toBe(true);
    expect(result.failed.every((failure) => failure.error.message === 'batch cancelled')).toBe(
      true,
    );
  });

  it('uses the default worker count when concurrency is not finite', async () => {
    const result = await convertBatch([{ name: 'cube.glb', data: load('cube.glb') }], {
      maxConcurrency: Number.NaN,
    });
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });
});

describe('progress callback', () => {
  it('fires progress events during conversion', async () => {
    const events: { phase: string; pct: number }[] = [];
    await convertGltfToFbx(load('cube.glb'), {
      name: 'cube.glb',
      onProgress: (phase, pct) => events.push({ phase, pct }),
    });
    expect(events.length).toBeGreaterThan(0);
    // Last event should be 1.0 (complete)
    expect(events[events.length - 1].pct).toBe(1);
  });

  it('normalizes non-finite progress values before invoking callbacks', () => {
    const events: number[] = [];
    const progress = makeProgress({ onProgress: (_phase, pct) => events.push(pct) });
    progress('parse', Number.NaN);
    progress('parse', Number.POSITIVE_INFINITY);
    progress('parse', 2);
    expect(events).toEqual([0, 0, 1]);
  });
});
