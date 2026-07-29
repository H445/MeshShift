/**
 * Client-side zip helper. Wraps JSZip so the rest of the UI doesn't import
 * the full library directly. Used to bundle multi-file and batch outputs into a
 * single download without a server.
 */
import JSZip from 'jszip';
import type { ConvertResult } from '../../shared/options.js';

export async function makeOutputZip(results: ConvertResult[]): Promise<Blob> {
  const zip = new JSZip();
  const useFolders = results.length > 1;
  for (const result of results) {
    const base = result.filename.replace(/\.[^.]+$/, '');
    for (const file of result.files) {
      zip.file(useFolders ? `${base}/${file.name}` : file.name, file.data);
    }
  }
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** @deprecated Use makeOutputZip. */
export const makeFbxZip = makeOutputZip;

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
