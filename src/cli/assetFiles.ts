import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { getMaxInputBytes, InputTooLargeError, type AssetFile } from '../core/index.js';
import { throwIfAborted } from '../core/progress.js';

function isInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return (
    distance !== '' &&
    distance !== '..' &&
    !distance.startsWith(`..\\`) &&
    !distance.startsWith(`../`) &&
    !isAbsolute(distance)
  );
}

/** Return a decoded local reference, rejecting URL and traversal semantics. */
export function decodeLocalReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    /^(?:data|file|https?):/i.test(trimmed) ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed).replace(/\\/g, '/');
  } catch {
    return undefined;
  }
  const segments = decoded.split('/');
  if (
    decoded.includes('\0') ||
    decoded.startsWith('/') ||
    /^[a-z]:/i.test(decoded) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return decoded;
}

/** Resolve a local companion URI without allowing it to leave the asset root. */
export function resolveCompanionReference(
  assetRoot: string,
  parentFile: string,
  reference: string,
): string | undefined {
  const decoded = decodeLocalReference(reference);
  if (!decoded) return undefined;
  const root = resolve(assetRoot);
  const candidate = resolve(dirname(parentFile), decoded);
  return isInside(root, candidate) ? candidate : undefined;
}

export function referencesFrom(name: string, data: Uint8Array): string[] {
  const extension = extname(name).toLowerCase();
  if (!['.gltf', '.obj', '.mtl', '.dae'].includes(extension)) return [];
  const text = new TextDecoder().decode(data);
  if (extension === '.gltf') {
    try {
      const document = JSON.parse(text) as {
        buffers?: Array<{ uri?: string }>;
        images?: Array<{ uri?: string }>;
      };
      return [...(document.buffers ?? []), ...(document.images ?? [])]
        .map((item) => item.uri)
        .filter((uri): uri is string => Boolean(uri));
    } catch {
      return [];
    }
  }
  if (extension === '.obj') {
    return Array.from(text.matchAll(/^\s*mtllib\s+(.+)$/gim), (match) => match[1].trim());
  }
  if (extension === '.mtl') {
    return Array.from(
      text.matchAll(/^\s*(?:map_\w+|bump|disp|decal)\s+(.+)$/gim),
      (match) => match[1].trim().split(/\s+/).pop() ?? '',
    ).filter(Boolean);
  }
  return Array.from(text.matchAll(/<init_from>\s*([^<]+)\s*<\/init_from>/gim), (match) =>
    match[1].trim(),
  );
}

async function regularFile(path: string): Promise<boolean> {
  return stat(path)
    .then((value) => value.isFile())
    .catch(() => false);
}

/**
 * Load a primary asset and only the local companion files it references.
 * Symlinks are canonicalized before the boundary check, so a link cannot
 * smuggle a file from outside the input directory into an import bundle.
 */
export async function loadAssetFiles(
  inputPath: string,
  verbose = false,
  signal?: AbortSignal,
): Promise<AssetFile[]> {
  throwIfAborted(signal);
  const primaryPath = await realpath(inputPath);
  const root = await realpath(dirname(primaryPath));
  const byteLimit = getMaxInputBytes();
  let loadedBytes = 0;
  const queue = [primaryPath];
  const seen = new Set<string>();
  const files: AssetFile[] = [];

  while (queue.length > 0) {
    throwIfAborted(signal);
    const path = queue.shift()!;
    const canonicalPath = await realpath(path);
    throwIfAborted(signal);
    if (!isInside(root, canonicalPath)) {
      if (verbose) console.error(`    skipped companion outside input folder: ${path}`);
      continue;
    }
    const key = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    if (seen.has(key)) continue;
    seen.add(key);

    const fileInfo = await stat(canonicalPath);
    const projectedBytes = loadedBytes + fileInfo.size;
    if (projectedBytes > byteLimit) {
      throw new InputTooLargeError(projectedBytes, byteLimit);
    }
    const data = new Uint8Array(await readFile(canonicalPath, { signal }));
    throwIfAborted(signal);
    loadedBytes += data.byteLength;
    if (loadedBytes > byteLimit) {
      throw new InputTooLargeError(loadedBytes, byteLimit);
    }

    files.push({
      name: relative(root, canonicalPath).replace(/\\/g, '/'),
      data,
    });
    for (const uri of referencesFrom(canonicalPath, data)) {
      const reference = resolveCompanionReference(root, canonicalPath, uri);
      if (!reference) {
        if (verbose) console.error(`    skipped unsafe companion path: ${uri}`);
        continue;
      }
      const canonicalReference = await realpath(reference).catch(() => undefined);
      if (canonicalReference && (await regularFile(canonicalReference))) {
        queue.push(canonicalReference);
      } else if (verbose) {
        console.error(`    missing companion: ${uri}`);
      }
    }
  }
  return files;
}
