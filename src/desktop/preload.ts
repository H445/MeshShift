import { contextBridge, ipcRenderer } from 'electron';

interface SavedExport {
  bytes: number;
  path: string;
}

contextBridge.exposeInMainWorld('meshshiftDesktop', {
  saveExport(path: string, data: ArrayBuffer): Promise<SavedExport> {
    return ipcRenderer.invoke('meshshift:save-export', { path, data }) as Promise<SavedExport>;
  },
});
