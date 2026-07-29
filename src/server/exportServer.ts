import { lstat, open, mkdir, rename, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const EXPORT_API_PATH = '/__modelshift/exports';
const DEFAULT_MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class ExportRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'ExportRequestError';
  }
}

export interface ExportWriteResult {
  bytes: number;
  relativePath: string;
}

/**
 * Resolve an untrusted browser-supplied path inside the configured export
 * root. Empty, absolute, traversal, and Windows device-name segments are
 * rejected before any filesystem operation occurs.
 */
export function resolveExportPath(
  exportRoot: string,
  requestedPath: string,
): { absolutePath: string; relativePath: string } {
  const normalized = requestedPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new ExportRequestError('Export path must be relative to the exports folder.');
  }

  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_RESERVED_NAME.test(segment),
    )
  ) {
    throw new ExportRequestError('Export path contains an unsafe segment.');
  }

  const root = resolve(exportRoot);
  const absolutePath = resolve(root, ...segments);
  const resolvedRelative = relative(root, absolutePath);
  if (!resolvedRelative || resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) {
    throw new ExportRequestError('Export path escapes the exports folder.');
  }

  return {
    absolutePath,
    relativePath: segments.join('/'),
  };
}

async function prepareExportTarget(exportRoot: string, relativePath: string): Promise<string> {
  const root = resolve(exportRoot);
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ExportRequestError('The configured exports path is not a regular directory.', 500);
  }

  const segments = relativePath.split('/');
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = resolve(parent, segment);
    try {
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ExportRequestError('Export path contains a non-directory segment.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(parent);
    }
  }
  return resolve(parent, segments.at(-1)!);
}

async function writeChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error('Could not write export data.');
    offset += bytesWritten;
  }
}

/** Stream one file into exports and replace an older copy with the same path. */
export async function writeExportFile(
  exportRoot: string,
  requestedPath: string,
  source: AsyncIterable<Uint8Array>,
  maximumBytes = DEFAULT_MAX_EXPORT_BYTES,
): Promise<ExportWriteResult> {
  const target = resolveExportPath(exportRoot, requestedPath);
  const absolutePath = await prepareExportTarget(exportRoot, target.relativePath);

  const temporaryPath = resolve(
    dirname(absolutePath),
    `.${basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, 'wx');
  let bytes = 0;
  let fileClosed = false;
  try {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        throw new ExportRequestError(
          `Export exceeds the ${Math.floor(maximumBytes / 1024 / 1024)} MB limit.`,
          413,
        );
      }
      await writeChunk(file, chunk);
    }
    await file.close();
    fileClosed = true;
    try {
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await rm(absolutePath, { force: true });
      await rename(temporaryPath, absolutePath);
    }
    return { bytes, relativePath: target.relativePath };
  } catch (error) {
    if (!fileClosed) await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type NextFunction = (error?: unknown) => void;

function json(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

/** Connect-compatible middleware mounted by both Vite dev and preview. */
export function createExportMiddleware(exportRoot: string) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: NextFunction,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://modelshift.local');
    if (url.pathname !== EXPORT_API_PATH) {
      next();
      return;
    }
    if (request.method !== 'PUT') {
      response.setHeader('Allow', 'PUT');
      json(response, 405, { error: 'Method not allowed.' });
      return;
    }

    const requestedPath = url.searchParams.get('path');
    if (!requestedPath) {
      json(response, 400, { error: 'Missing export path.' });
      return;
    }

    try {
      const saved = await writeExportFile(exportRoot, requestedPath, request);
      json(response, 201, {
        bytes: saved.bytes,
        path: `exports/${saved.relativePath}`,
      });
    } catch (error) {
      if (error instanceof ExportRequestError) {
        json(response, error.statusCode, { error: error.message });
        return;
      }
      console.error('Failed to save ModelShift export:', error);
      json(response, 500, { error: 'Could not write the export file.' });
    }
  };
}
