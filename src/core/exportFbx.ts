/**
 * FBX export — uses vendored assimpjs (repalash fork, FBX export enabled).
 * This replaces the (non-existent) three.js FBXExporter.
 */
import { getAssimp } from './assimpLoader.js';
import type { ConvertOptions } from '../shared/options.js';
import { makeProgress } from './progress.js';
import { ExportError } from './errors.js';

export async function exportFbx(
  sourceBytes: Uint8Array,
  sourceName: string,
  options?: ConvertOptions,
): Promise<Uint8Array> {
  const progress = makeProgress(options);
  progress('export', 0);

  const ajs = await getAssimp();
  const fileList = new ajs.FileList();
  // The name matters — assimp uses the extension to pick the importer.
  const lowerName = sourceName.toLowerCase();
  const name =
    lowerName.endsWith('.glb') || lowerName.endsWith('.gltf') ? sourceName : `${sourceName}.glb`;
  fileList.AddFile(name, sourceBytes);

  progress('export', 0.5);
  const result = ajs.ConvertFileList(fileList, 'fbx');
  if (!result.IsSuccess() || result.FileCount() === 0) {
    const code = result.GetErrorCode();
    throw new ExportError(`assimp failed: ${code || 'unknown error'}`);
  }

  const out = result.GetFile(0);
  progress('export', 1);
  return out.GetContent();
}
