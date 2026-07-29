import type { ConvertResult, ConvertedFile } from '../../shared/options.js';

const EXPORT_API_PATH = '/__modelshift/exports';

export interface SavedExport {
  bytes: number;
  path: string;
}

interface PendingExport {
  file: ConvertedFile;
  path: string;
}

function folderName(result: ConvertResult): string {
  const withoutControls = Array.from(result.filename, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? '_' : character;
  }).join('');
  return (
    withoutControls
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/g, '') || 'asset'
  );
}

function pendingExports(results: ConvertResult[]): PendingExport[] {
  const useFolders = results.length > 1;
  const folderCounts = new Map<string, number>();
  return results.flatMap((result) => {
    let folder = folderName(result);
    if (useFolders) {
      const occurrence = (folderCounts.get(folder.toLowerCase()) ?? 0) + 1;
      folderCounts.set(folder.toLowerCase(), occurrence);
      if (occurrence > 1) folder = `${folder}-${occurrence}`;
    }
    return result.files.map((file) => ({
      file,
      path: useFolders ? `${folder}/${file.name}` : file.name,
    }));
  });
}

async function saveFile({ file, path }: PendingExport): Promise<SavedExport> {
  let response: Response;
  try {
    const data = file.data;
    const body =
      data.buffer instanceof ArrayBuffer &&
      data.byteOffset === 0 &&
      data.byteLength === data.buffer.byteLength
        ? data.buffer
        : data.slice().buffer;
    response = await fetch(`${EXPORT_API_PATH}?${new URLSearchParams({ path })}`, {
      method: 'PUT',
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
      },
      body,
    });
  } catch {
    throw new Error(
      'The local export service is unavailable. Start ModelShift with start.sh or start.ps1.',
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    bytes?: number;
    error?: string;
    path?: string;
  } | null;
  if (!response.ok || typeof payload?.path !== 'string') {
    throw new Error(
      payload?.error ??
        'The local export service is unavailable. Start ModelShift with start.sh or start.ps1.',
    );
  }
  return {
    bytes: typeof payload.bytes === 'number' ? payload.bytes : file.data.byteLength,
    path: payload.path,
  };
}

/** Save converted files through the local server instead of browser downloads. */
export async function saveResultsToExports(results: ConvertResult[]): Promise<SavedExport[]> {
  const pending = pendingExports(results);
  const saved: SavedExport[] = [];
  for (const file of pending) saved.push(await saveFile(file));
  return saved;
}
