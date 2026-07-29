/**
 * Client-side zip helper. Wraps JSZip so the rest of the UI doesn't import
 * the full library directly. Used to bundle multiple FBX outputs into a
 * single download without a server.
 */
import JSZip from 'jszip';
import type { FbxResult } from '../../shared/options.js';

export async function makeFbxZip(results: FbxResult[]): Promise<Blob> {
  const zip = new JSZip();
  for (const r of results) {
    zip.file(r.filename, r.data);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

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
