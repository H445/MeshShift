import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfAborted } from '../core/progress.js';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class OutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputPathError';
  }
}

export function resolveOutputPath(outputRoot: string, fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new OutputPathError('Generated output path must be relative.');
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
    throw new OutputPathError('Generated output path contains an unsafe segment.');
  }
  const root = resolve(outputRoot);
  const target = resolve(root, ...segments);
  const distance = relative(root, target);
  if (!distance || distance === '..' || distance.startsWith(`..\\`) || distance.startsWith('../')) {
    throw new OutputPathError('Generated output path escapes the output folder.');
  }
  return target;
}

async function assertDirectory(path: string, message: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new OutputPathError(message);
}

async function prepareOutputPath(
  outputRoot: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const target = resolveOutputPath(outputRoot, fileName);
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  throwIfAborted(signal);
  await assertDirectory(root, 'The output folder must be a regular directory.');

  const segments = fileName.replace(/\\/g, '/').split('/');
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    throwIfAborted(signal);
    parent = resolve(parent, segment);
    try {
      await assertDirectory(parent, 'The output path contains a non-directory segment.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(parent);
      await assertDirectory(parent, 'The output path contains a non-directory segment.');
    }
  }

  throwIfAborted(signal);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || info.isDirectory()) {
      throw new OutputPathError('The output target must not be a symlink or directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

/** Write a generated artifact atomically without following output symlinks. */
export async function writeOutputFile(
  outputRoot: string,
  fileName: string,
  data: Uint8Array | string,
  signal?: AbortSignal,
): Promise<string> {
  const target = await prepareOutputPath(outputRoot, fileName, signal);
  const temporaryPath = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', signal });
    throwIfAborted(signal);
    await rename(temporaryPath, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    const existing = await lstat(target);
    if (existing.isDirectory()) throw new OutputPathError('The output target is a directory.');
    await rm(target, { force: true });
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return target;
}
