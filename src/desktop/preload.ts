import { contextBridge, ipcRenderer } from 'electron';

interface SavedExport {
  bytes: number;
  path: string;
}

contextBridge.exposeInMainWorld('meshshiftDesktop', {
  getExportDirectory() {
    return ipcRenderer.invoke('meshshift:get-export-directory');
  },
  chooseExportDirectory() {
    return ipcRenderer.invoke('meshshift:choose-export-directory') as Promise<string | null>;
  },
  setExportDirectory(path: string | null) {
    return ipcRenderer.invoke('meshshift:set-export-directory', path);
  },
  saveExport(path: string, data: ArrayBuffer): Promise<SavedExport> {
    return ipcRenderer.invoke('meshshift:save-export', { path, data }) as Promise<SavedExport>;
  },
});
