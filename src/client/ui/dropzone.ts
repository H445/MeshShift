/**
 * Dropzone — turns the whole window into a drop target.
 * Emits File[] on drop. Supports drag-over highlight.
 */
export interface DropzoneHandle {
  onFiles(cb: (files: File[]) => void): void;
  destroy(): void;
}

export function createDropzone(_host: HTMLElement): DropzoneHandle {
  let cb: ((files: File[]) => void) | null = null;
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('drag-active');
  };
  const onDragLeave = (e: DragEvent) => {
    // Only remove highlight if we leave the window
    if (e.relatedTarget === null) document.body.classList.remove('drag-active');
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.remove('drag-active');
    const files = Array.from(e.dataTransfer?.files ?? []).filter(isGltf);
    if (files.length) cb?.(files);
  };
  function isGltf(f: File): boolean {
    const n = f.name.toLowerCase();
    return n.endsWith('.glb') || n.endsWith('.gltf');
  }
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  return {
    onFiles(handler) { cb = handler; },
    destroy() {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  };
}
