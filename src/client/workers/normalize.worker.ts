import { convertAsset } from '@core';
import type { NormalizeRequest, NormalizeResponse } from '../lib/preview-normalizer.js';

interface WorkerScope {
  onmessage: ((event: MessageEvent<NormalizeRequest>) => void) | null;
  postMessage(message: NormalizeResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
let workQueue: Promise<void> = Promise.resolve();

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
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

async function normalize(message: NormalizeRequest): Promise<void> {
  try {
    const result = await convertAsset(message.files, {
      name: message.name,
      outputFormat: 'glb',
      onProgress: (phase, pct) => {
        scope.postMessage({
          type: 'progress',
          id: message.id,
          phase,
          pct,
        });
      },
    });
    const data = exactArrayBuffer(result.data);
    scope.postMessage(
      {
        type: 'result',
        id: message.id,
        data,
        stats: result.stats,
      },
      [data],
    );
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    scope.postMessage({
      type: 'error',
      id: message.id,
      name: error.name,
      message: error.message,
    });
  }
}

scope.onmessage = (event) => {
  // Assimp keeps process-wide WebAssembly state. Serialize preview jobs inside
  // the worker instead of racing multiple conversions through that state.
  workQueue = workQueue.then(() => normalize(event.data));
};
