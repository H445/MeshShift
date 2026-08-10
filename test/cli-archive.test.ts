import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZipArchive } from '../src/cli/archive.js';

describe('CLI archive output', () => {
  it('writes an archive atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modelshift-cli-archive-'));
    try {
      const target = await writeZipArchive(root, [
        { path: join(root, 'asset.fbx'), data: new Uint8Array([1, 2, 3]) },
      ]);
      expect(target).toBe(join(root, 'modelshift.zip'));
      expect((await readFile(target)).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not commit an archive when cancelled during generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modelshift-cli-archive-cancel-'));
    const controller = new AbortController();
    try {
      const pending = writeZipArchive(
        root,
        [{ path: 'asset.fbx', data: new Uint8Array(2 * 1024 * 1024) }],
        controller.signal,
      );
      controller.abort('zip cancelled');
      await expect(pending).rejects.toMatchObject({
        name: 'AbortError',
        message: 'zip cancelled',
      });
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
