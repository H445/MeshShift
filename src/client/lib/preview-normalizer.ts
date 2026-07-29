import type {
  AssetFile,
  ConvertOptions,
  ConvertPhase,
  ConvertResult,
  ConvertStats,
  ConvertWarning,
  InspectResult,
  OutputFormat,
} from '../../shared/options.js';
import type { OptimizeChange, OptimizeResult } from '../../core/optimize.js';

export interface PreviewNormalized {
  data: Uint8Array;
  stats: ConvertStats;
}

export type WorkerConvertOptions = Omit<ConvertOptions, 'onProgress'>;

export type ModelWorkerRequest =
  | {
      type: 'normalize';
      id: number;
      name: string;
      files: Array<{ name: string; data: ArrayBuffer }>;
    }
  | {
      type: 'optimize';
      id: number;
      data: ArrayBuffer;
      options: WorkerConvertOptions;
    }
  | {
      type: 'convert';
      id: number;
      name: string;
      files: Array<{ name: string; data: ArrayBuffer }>;
      options: WorkerConvertOptions;
    };

export type ModelWorkerSuccess =
  | {
      type: 'normalize-result';
      id: number;
      data: ArrayBuffer;
      stats: ConvertStats;
    }
  | {
      type: 'optimize-result';
      id: number;
      data: ArrayBuffer;
      stats: InspectResult;
      changes: OptimizeChange[];
    }
  | {
      type: 'convert-result';
      id: number;
      result: {
        files: Array<{ name: string; data: ArrayBuffer; mimeType: string }>;
        format: OutputFormat;
        stats: ConvertStats;
        warnings: ConvertWarning[];
        filename: string;
      };
    };

export type ModelWorkerResponse =
  | {
      type: 'progress';
      id: number;
      phase: ConvertPhase;
      pct: number;
    }
  | {
      type: 'error';
      id: number;
      name: string;
      message: string;
    }
  | ModelWorkerSuccess;

interface PendingRequest {
  resolve: (message: ModelWorkerSuccess) => void;
  reject: (reason: Error) => void;
  onProgress?: (phase: ConvertPhase, pct: number) => void;
}

interface WorkerChannel {
  worker: Worker | null;
  pending: Map<number, PendingRequest>;
}

const previewChannel: WorkerChannel = { worker: null, pending: new Map() };
const pipelineChannel: WorkerChannel = { worker: null, pending: new Map() };
let nextRequestId = 1;

function rejectPending(channel: WorkerChannel, error: Error): void {
  for (const request of channel.pending.values()) request.reject(error);
  channel.pending.clear();
}

function createWorker(channel: WorkerChannel): Worker {
  const next = new Worker(new URL('../workers/normalize.worker.ts', import.meta.url), {
    type: 'module',
    name: 'modelshift-model-worker',
  });
  next.addEventListener('message', (event: MessageEvent<ModelWorkerResponse>) => {
    const message = event.data;
    const request = channel.pending.get(message.id);
    if (!request) return;
    if (message.type === 'progress') {
      request.onProgress?.(message.phase, message.pct);
      return;
    }
    channel.pending.delete(message.id);
    if (message.type === 'error') {
      const error = new Error(message.message);
      error.name = message.name;
      request.reject(error);
    } else {
      request.resolve(message);
    }
  });
  next.addEventListener('error', (event) => {
    const error = new Error(event.message || 'The model loading worker stopped unexpectedly.');
    rejectPending(channel, error);
    next.terminate();
    if (channel.worker === next) channel.worker = null;
  });
  return next;
}

function transferableBuffer(data: ArrayBuffer | Uint8Array, preserve: boolean): ArrayBuffer {
  if (!preserve) {
    if (data instanceof ArrayBuffer) return data;
    if (
      data.buffer instanceof ArrayBuffer &&
      data.byteOffset === 0 &&
      data.byteLength === data.buffer.byteLength
    ) {
      return data.buffer;
    }
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data instanceof Uint8Array ? data : new Uint8Array(data));
  return copy.buffer;
}

function postRequest(
  channel: WorkerChannel,
  message: ModelWorkerRequest,
  transfer: ArrayBuffer[],
  onProgress: ((phase: ConvertPhase, pct: number) => void) | undefined,
): Promise<ModelWorkerSuccess> {
  if (!channel.worker) channel.worker = createWorker(channel);
  return new Promise((resolve, reject) => {
    channel.pending.set(message.id, { resolve, reject, onProgress });
    channel.worker!.postMessage(message, transfer);
  });
}

async function normalizeWithChannel(
  channel: WorkerChannel,
  files: AssetFile[],
  name: string,
  preserveInputs: boolean,
  onProgress?: (phase: ConvertPhase, pct: number) => void,
): Promise<PreviewNormalized> {
  const id = nextRequestId++;
  const transferableFiles = files.map((file) => ({
    name: file.name,
    data: transferableBuffer(file.data, preserveInputs),
  }));
  const response = await postRequest(
    channel,
    { type: 'normalize', id, name, files: transferableFiles },
    transferableFiles.map((file) => file.data),
    onProgress,
  );
  if (response.type !== 'normalize-result') throw new Error('Unexpected model worker response.');
  return { data: new Uint8Array(response.data), stats: response.stats };
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
  return normalizeWithChannel(previewChannel, files, name, false, onProgress);
}

/** Normalize a conversion source without sharing lifecycle with active preview loading. */
export function normalizeForConversion(
  files: AssetFile[],
  name: string,
  onProgress?: (phase: ConvertPhase, pct: number) => void,
  preserveInputs = false,
): Promise<PreviewNormalized> {
  return normalizeWithChannel(pipelineChannel, files, name, preserveInputs, onProgress);
}

/** Run geometry, LOD, and texture optimization away from the browser UI thread. */
export async function optimizeInWorker(
  data: ArrayBuffer | Uint8Array,
  options: WorkerConvertOptions,
  onProgress?: (phase: ConvertPhase, pct: number) => void,
): Promise<OptimizeResult> {
  const id = nextRequestId++;
  const transferable = transferableBuffer(data, true);
  const response = await postRequest(
    pipelineChannel,
    { type: 'optimize', id, data: transferable, options },
    [transferable],
    onProgress,
  );
  if (response.type !== 'optimize-result') throw new Error('Unexpected model worker response.');
  return {
    data: new Uint8Array(response.data),
    stats: response.stats,
    changes: response.changes,
  };
}

/** Export prepared model data through Assimp without blocking the page thread. */
export async function convertInWorker(
  files: AssetFile[],
  name: string,
  options: WorkerConvertOptions,
  onProgress?: (phase: ConvertPhase, pct: number) => void,
): Promise<ConvertResult> {
  const id = nextRequestId++;
  const transferableFiles = files.map((file) => ({
    name: file.name,
    data: transferableBuffer(file.data, true),
  }));
  const response = await postRequest(
    pipelineChannel,
    {
      type: 'convert',
      id,
      name,
      files: transferableFiles,
      options,
    },
    transferableFiles.map((file) => file.data),
    onProgress,
  );
  if (response.type !== 'convert-result') throw new Error('Unexpected model worker response.');
  const convertedFiles = response.result.files.map((file) => ({
    ...file,
    data: new Uint8Array(file.data),
  }));
  const primary =
    convertedFiles.find((file) => file.name === response.result.filename) ?? convertedFiles[0];
  if (!primary) throw new Error('Model worker returned no converted files.');
  return {
    ...response.result,
    files: convertedFiles,
    data: primary.data,
  };
}

function terminateChannel(channel: WorkerChannel, message: string): void {
  if (!channel.worker) return;
  channel.worker.terminate();
  channel.worker = null;
  const error = new Error(message);
  error.name = 'AbortError';
  rejectPending(channel, error);
}

/** Stop an obsolete source preview without interrupting an active export. */
export function cancelPreviewNormalizations(): void {
  if (previewChannel.pending.size === 0) return;
  terminateChannel(previewChannel, 'Preview loading was cancelled.');
}

/** Release both worker WebAssembly heaps when the queue is cleared. */
export function disposePreviewNormalizer(): void {
  terminateChannel(previewChannel, 'Preview loading was cancelled.');
  terminateChannel(pipelineChannel, 'Model processing was cancelled.');
}
