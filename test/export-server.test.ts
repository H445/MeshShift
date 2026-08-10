import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExportRequestError,
  getMaxExportBytes,
  resolveExportPath,
  writeExportFile,
  createExportMiddleware,
} from '../src/server/exportServer.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modelshift-exports-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('local export store', () => {
  it('uses the default export limit for invalid environment values', () => {
    const previous = process.env.MODELSHIFT_MAX_EXPORT_MB;
    process.env.MODELSHIFT_MAX_EXPORT_MB = 'not-a-number';
    try {
      expect(getMaxExportBytes()).toBe(1024 * 1024 * 1024);
    } finally {
      if (previous === undefined) delete process.env.MODELSHIFT_MAX_EXPORT_MB;
      else process.env.MODELSHIFT_MAX_EXPORT_MB = previous;
    }
  });

  it('resolves nested paths inside the exports root', async () => {
    const root = await temporaryRoot();
    const target = resolveExportPath(root, 'model/mesh.obj');
    expect(target.relativePath).toBe('model/mesh.obj');
    expect(target.absolutePath).toBe(join(root, 'model', 'mesh.obj'));
  });

  it.each(['../escape.fbx', '/absolute.fbx', 'C:\\escape.fbx', 'mesh/../escape.fbx', 'CON'])(
    'rejects unsafe path %s',
    async (path) => {
      const root = await temporaryRoot();
      expect(() => resolveExportPath(root, path)).toThrow(ExportRequestError);
    },
  );

  it('streams and replaces an export file', async () => {
    const root = await temporaryRoot();
    const chunks = async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    };
    const first = await writeExportFile(root, 'mesh/model.glb', chunks());
    expect(first).toEqual({ bytes: 4, relativePath: 'mesh/model.glb' });
    expect([...new Uint8Array(await readFile(join(root, 'mesh', 'model.glb')))]).toEqual([
      1, 2, 3, 4,
    ]);

    const replacement = async function* () {
      yield new Uint8Array([9]);
    };
    await writeExportFile(root, 'mesh/model.glb', replacement());
    expect([...new Uint8Array(await readFile(join(root, 'mesh', 'model.glb')))]).toEqual([9]);
  });

  it('removes partial files when the size limit is exceeded', async () => {
    const root = await temporaryRoot();
    const chunks = async function* () {
      yield new Uint8Array([1, 2, 3]);
    };
    await expect(writeExportFile(root, 'too-large.glb', chunks(), 2)).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(readFile(join(root, 'too-large.glb'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the temporary file when an export stream is interrupted', async () => {
    const root = await temporaryRoot();
    const chunks = async function* () {
      yield new Uint8Array([1, 2, 3]);
      throw new Error('simulated interruption');
    };
    await expect(writeExportFile(root, 'interrupted.glb', chunks())).rejects.toThrow(
      'simulated interruption',
    );
    await expect(readFile(join(root, 'interrupted.glb'))).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(root));
    expect(entries).toEqual([]);
  });

  it('does not overwrite a configured exports root that is a regular file', async () => {
    const root = await temporaryRoot();
    const exportRoot = join(root, 'not-a-directory');
    await writeFile(exportRoot, 'keep this marker');

    const chunks = async function* () {
      yield new Uint8Array([1, 2, 3]);
    };
    await expect(writeExportFile(exportRoot, 'model.glb', chunks())).rejects.toThrow();
    await expect(readFile(exportRoot, 'utf8')).resolves.toBe('keep this marker');
  });

  it('accepts binary files through the local HTTP endpoint', async () => {
    const root = await temporaryRoot();
    const middleware = createExportMiddleware(root);
    const server = createServer((request, response) => {
      void middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server has no TCP port.');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/__modelshift/exports?path=${encodeURIComponent('asset/model.fbx')}`,
        {
          method: 'PUT',
          body: new Uint8Array([7, 8, 9]),
        },
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        bytes: 3,
        path: 'exports/asset/model.fbx',
      });
      expect([...new Uint8Array(await readFile(join(root, 'asset', 'model.fbx')))]).toEqual([
        7, 8, 9,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('rejects a known oversized request before writing it', async () => {
    const root = await temporaryRoot();
    const previous = process.env.MODELSHIFT_MAX_EXPORT_MB;
    process.env.MODELSHIFT_MAX_EXPORT_MB = '0';
    const middleware = createExportMiddleware(root);
    const server = createServer((request, response) => {
      void middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server has no TCP port.');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/__modelshift/exports?path=${encodeURIComponent('too-large.fbx')}`,
        {
          method: 'PUT',
          headers: { 'Content-Length': '1' },
          body: new Uint8Array([7]),
        },
      );
      expect(response.status).toBe(413);
      await expect(readFile(join(root, 'too-large.fbx'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.MODELSHIFT_MAX_EXPORT_MB;
      else process.env.MODELSHIFT_MAX_EXPORT_MB = previous;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
