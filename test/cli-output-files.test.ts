import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOutputPath, writeOutputFile } from '../src/cli/outputFiles.js';

describe('CLI output path safety', () => {
  it.each(['../escape.fbx', '/absolute.fbx', 'C:\\escape.fbx', 'CON', 'nested/../escape.fbx'])(
    'rejects unsafe output path %s',
    (name) => {
      expect(() => resolveOutputPath('G:/exports', name)).toThrow();
    },
  );

  it('resolves nested output files inside the output root', () => {
    expect(resolveOutputPath('G:/exports', 'asset/model.fbx')).toBe(
      'G:\\exports\\asset\\model.fbx',
    );
  });

  it('writes and atomically replaces nested output files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshshift-cli-output-'));
    try {
      const target = await writeOutputFile(root, 'nested/model.fbx', new Uint8Array([1, 2]));
      expect([...new Uint8Array(await readFile(target))]).toEqual([1, 2]);
      await writeOutputFile(root, 'nested/model.fbx', new Uint8Array([3]));
      expect([...new Uint8Array(await readFile(target))]).toEqual([3]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('fails cleanly when the configured output root is a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshshift-cli-output-root-'));
    const outputRoot = join(root, 'not-a-directory');
    try {
      await writeFile(outputRoot, 'keep this marker');
      await expect(writeOutputFile(outputRoot, 'model.fbx', new Uint8Array([1]))).rejects.toThrow();
      await expect(readFile(outputRoot, 'utf8')).resolves.toBe('keep this marker');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not commit or leave a temporary file when cancelled before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshshift-cli-output-cancel-'));
    const controller = new AbortController();
    controller.abort('write cancelled');
    try {
      await expect(
        writeOutputFile(root, 'model.fbx', new Uint8Array([1]), controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'write cancelled' });
      await expect(readFile(join(root, 'model.fbx'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        import('node:fs/promises').then(({ readdir }) => readdir(root)),
      ).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
