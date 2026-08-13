export interface MeshShiftDesktopApi {
  getExportDirectory(): Promise<{
    path: string;
    defaultPath: string;
    isDefault: boolean;
  }>;
  chooseExportDirectory(): Promise<string | null>;
  setExportDirectory(path: string | null): Promise<{
    path: string;
    defaultPath: string;
    isDefault: boolean;
  }>;
  saveExport(
    path: string,
    data: ArrayBuffer,
  ): Promise<{
    bytes: number;
    path: string;
  }>;
}

declare global {
  interface Window {
    meshshiftDesktop?: MeshShiftDesktopApi;
  }
}
