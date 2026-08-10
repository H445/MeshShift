import JSZip from 'jszip';
import { basename, resolve } from 'node:path';
import { throwIfAborted } from '../core/progress.js';
import { writeOutputFile } from './outputFiles.js';

export interface ArchiveOutput {
  path: string;
  data: Uint8Array;
}

/** Build and atomically commit the CLI archive, honoring cancellation before commit. */
export async function writeZipArchive(
  outputRoot: string,
  outputs: Iterable<ArchiveOutput>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const zip = new JSZip();
  for (const output of outputs) {
    throwIfAborted(signal);
    zip.file(basename(output.path), output.data);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  throwIfAborted(signal);
  return writeOutputFile(resolve(outputRoot), 'meshshift.zip', buffer, signal);
}
