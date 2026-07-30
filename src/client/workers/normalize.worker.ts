import type { ModelWorkerRequest, ModelWorkerResponse } from '../lib/preview-normalizer.js';
import type { ConvertPhase } from '../../shared/options.js';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ModelWorkerRequest>) => void) | null;
  postMessage(message: ModelWorkerResponse, transfer?: Transferable[]): void;
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

function installWorkerCanvasDocument(): void {
  if (typeof document !== 'undefined' || typeof OffscreenCanvas === 'undefined') return;
  const workerGlobal = globalThis as unknown as {
    document?: {
      createElement(tagName: string): OffscreenCanvas;
    };
  };
  workerGlobal.document = {
    createElement(tagName: string) {
      if (tagName.toLowerCase() !== 'canvas') {
        throw new Error(`Worker document cannot create <${tagName}>.`);
      }
      return new OffscreenCanvas(1, 1);
    },
  };
}

function postProgress(id: number, phase: ConvertPhase, pct: number): void {
  scope.postMessage({ type: 'progress', id, phase, pct });
}

async function processRequest(message: ModelWorkerRequest): Promise<void> {
  try {
    installWorkerCanvasDocument();
    const { convertAsset, convertPreparedAsset, inspectGltf, optimizeGltf } = await import('@core');
    if (message.type === 'normalize') {
      const directGlb =
        message.files.length === 1 && message.files[0].name.toLowerCase().endsWith('.glb')
          ? message.files[0]
          : undefined;
      if (directGlb) {
        const started = performance.now();
        const info = await inspectGltf(directGlb.data);
        const data = directGlb.data;
        scope.postMessage(
          {
            type: 'normalize-result',
            id: message.id,
            data,
            stats: {
              meshes: info.meshes,
              materials: info.materials,
              textures: info.textures,
              animations: info.animations,
              bones: info.bones,
              morphTargets: info.morphTargets,
              triangles: info.triangles,
              vertices: info.vertices,
              textureMaxSize: info.textureMaxSize,
              inputBytes: data.byteLength,
              outputBytes: data.byteLength,
              durationMs: performance.now() - started,
            },
          },
          [data],
        );
        return;
      }
      const result = await convertAsset(message.files, {
        name: message.name,
        outputFormat: 'glb',
        onProgress: (phase, pct) => postProgress(message.id, phase, pct),
      });
      const data = exactArrayBuffer(result.data);
      scope.postMessage(
        {
          type: 'normalize-result',
          id: message.id,
          data,
          stats: result.stats,
        },
        [data],
      );
      return;
    }
    if (message.type === 'optimize') {
      const result = await optimizeGltf(message.data, {
        ...message.options,
        onProgress: (phase, pct) => postProgress(message.id, phase, pct),
      });
      const data = exactArrayBuffer(result.data);
      scope.postMessage(
        {
          type: 'optimize-result',
          id: message.id,
          data,
          stats: result.stats,
          changes: result.changes,
        },
        [data],
      );
      return;
    }

    const preparedFile = message.files[0];
    if (!preparedFile) throw new Error('The prepared model is missing.');
    const result = await convertPreparedAsset(preparedFile, {
      ...message.options,
      name: message.name,
      knownStats: message.stats,
      onProgress: (phase, pct) => postProgress(message.id, phase, pct),
    });
    const files = result.files.map((file) => ({
      name: file.name,
      data: exactArrayBuffer(file.data),
      mimeType: file.mimeType,
    }));
    scope.postMessage(
      {
        type: 'convert-result',
        id: message.id,
        result: {
          files,
          format: result.format,
          stats: result.stats,
          warnings: result.warnings,
          filename: result.filename,
        },
      },
      files.map((file) => file.data),
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
  workQueue = workQueue.then(() => processRequest(event.data));
};
