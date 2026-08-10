import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeLocalReference,
  loadAssetFiles,
  resolveCompanionReference,
} from '../src/cli/assetFiles.js';

describe('CLI companion path safety', () => {
  it.each(['../outside.bin', '/outside.bin', 'C:\\outside.bin', 'data:text/plain,x', 'a/./b.bin'])(
    'rejects unsafe reference %s',
    (reference) => {
      expect(decodeLocalReference(reference)).toBeUndefined();
    },
  );

  it('decodes a safe relative URI', () => {
    expect(decodeLocalReference('textures%2Fdiffuse.png')).toBe('textures/diffuse.png');
  });

  it('keeps companion resolution inside the asset root', () => {
    expect(
      resolveCompanionReference(
        'G:/assets',
        'G:/assets/models/scene.gltf',
        '../textures/diffuse.png',
      ),
    ).toBeUndefined();
    expect(
      resolveCompanionReference('G:/assets', 'G:/assets/models/scene.gltf', 'textures/diffuse.png'),
    ).toBe('G:\\assets\\models\\textures\\diffuse.png');
  });

  it('loads only existing local companions and skips remote or malformed references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshshift-assets-'));
    try {
      await writeFile(
        join(root, 'scene.gltf'),
        JSON.stringify({
          asset: { version: '2.0' },
          buffers: [
            { uri: 'mesh.bin', byteLength: 4 },
            { uri: 'missing.bin', byteLength: 4 },
            { uri: 'https://example.invalid/remote.bin', byteLength: 4 },
            { uri: 'bad%ZZ.bin', byteLength: 4 },
          ],
          images: [{ uri: 'data:image/png;base64,AAAA' }],
        }),
      );
      await writeFile(join(root, 'mesh.bin'), new Uint8Array([1, 2, 3, 4]));

      const files = await loadAssetFiles(join(root, 'scene.gltf'));

      expect(files.map((file) => file.name)).toEqual(['scene.gltf', 'mesh.bin']);
      await expect(readFile(join(root, 'mesh.bin'))).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates cyclic companion references without duplicate loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshshift-cyclic-'));
    try {
      await writeFile(
        join(root, 'a.gltf'),
        JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'b.gltf' }] }),
      );
      await writeFile(
        join(root, 'b.gltf'),
        JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'a.gltf' }] }),
      );

      const files = await loadAssetFiles(join(root, 'a.gltf'));

      expect(files.map((file) => file.name)).toEqual(['a.gltf', 'b.gltf']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops loading before filesystem work when cancelled', async () => {
    const controller = new AbortController();
    controller.abort('load cancelled');
    await expect(loadAssetFiles('missing.gltf', false, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'load cancelled',
    });
  });
});
