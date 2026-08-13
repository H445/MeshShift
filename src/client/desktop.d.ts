export interface MeshShiftDesktopApi {
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
