import type { AssetFile, ConvertPhase, ConvertStats } from '../../shared/options.js';

export interface PreviewNormalized {
  data: Uint8Array;
  stats: ConvertStats;
}

export interface NormalizeRequest {
  type: 'normalize';
  id: number;
  name: string;
  files: Array<{ name: string; data: ArrayBuffer }>;
}

export type NormalizeResponse =
  | {
      type: 'progress';
      id: number;
      phase: ConvertPhase;
      pct: number;
    }
  | {
      type: 'result';
      id: number;
      data: ArrayBuffer;
      stats: ConvertStats;
    }
  | {
      type: 'error';
      id: number;
      name: string;
      message: string;
    };

interface PendingRequest {
  resolve: (value: PreviewNormalized) => void;
  reject: (reason: Error) => void;
  onProgress?: (phase: ConvertPhase, pct: number) => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function createWorker(): Worker {
  const next = new Worker(new URL('../workers/normalize.worker.ts', import.meta.url), {
    type: 'module',
    name: 'modelshift-preview-normalizer',
  });
  next.addEventListener('message', (event: MessageEvent<NormalizeResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === 'progress') {
      request.onProgress?.(message.phase, message.pct);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'result') {
      request.resolve({
        data: new Uint8Array(message.data),
        stats: message.stats,
      });
      return;
    }
    const error = new Error(message.message);
    error.name = message.name;
    request.reject(error);
  });
  next.addEventListener('error', (event) => {
    const error = new Error(event.message || 'The model loading worker stopped unexpectedly.');
    rejectPending(error);
    next.terminate();
    if (worker === next) worker = null;
  });
  return next;
}

function exactArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

/**
 * Normalize a source asset to GLB outside the browser UI thread.
 *
 * The input buffers are transferred to the worker, so callers should pass
 * freshly-read file data rather than buffers they intend to reuse.
 */
export function normalizePreview(
  files: AssetFile[],
  name: string,
  onProgress?: (phase: ConvertPhase, pct: number) => void,
): Promise<PreviewNormalized> {
  if (!worker) worker = createWorker();
  const id = nextRequestId++;
  const transferableFiles = files.map((file) => ({
    name: file.name,
    data: exactArrayBuffer(file.data),
  }));
  const message: NormalizeRequest = {
    type: 'normalize',
    id,
    name,
    files: transferableFiles,
  };

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage(
      message,
      transferableFiles.map((file) => file.data),
    );
  });
}

/** Stop an obsolete large preview immediately when the user changes assets. */
export function cancelPreviewNormalizations(): void {
  if (!worker || pending.size === 0) return;
  worker.terminate();
  worker = null;
  const error = new Error('Preview loading was cancelled.');
  error.name = 'AbortError';
  rejectPending(error);
}

/** Release the worker and its WebAssembly heap when the queue is cleared. */
export function disposePreviewNormalizer(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
  const error = new Error('Preview loading was cancelled.');
  error.name = 'AbortError';
  rejectPending(error);
}
