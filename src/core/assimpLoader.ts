/**
 * Public types for the assimpjs loader. The actual implementation lives in
 * `assimpLoaderImpl.ts` which is aliased to either the browser or Node
 * variant via Vite/tsup. This keeps Node-only code out of the browser bundle.
 */

export interface AssimpInstance {
  FileList: new () => AssimpFileList;
  ConvertFileList(list: AssimpFileList, targetFormat: string): AssimpResult;
}

export interface AssimpFileList {
  AddFile(name: string, content: Uint8Array): void;
}

export interface AssimpResult {
  IsSuccess(): boolean;
  FileCount(): number;
  GetErrorCode(): string;
  GetFile(index: number): AssimpOutputFile;
}

export interface AssimpOutputFile {
  GetContent(): Uint8Array;
}

// Re-export the platform-specific getAssimp.
export { getAssimp } from './assimpLoaderImpl.js';
