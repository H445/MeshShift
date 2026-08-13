declare module 'electron' {
  export interface IpcMainInvokeEvent {
    senderFrame: { url: string };
  }

  export const app: {
    isPackaged: boolean;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
    exit(code?: number): void;
    requestSingleInstanceLock(): boolean;
    getAppPath(): string;
    getPath(name: string): string;
  };

  export class BrowserWindow {
    constructor(options: Record<string, unknown>);
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    show(): void;
    focus(): void;
    isDestroyed(): boolean;
    once(event: string, listener: (...args: unknown[]) => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    webContents: {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    };
  }

  export const ipcMain: {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: Record<string, unknown>): void;
  };

  export const protocol: {
    registerSchemesAsPrivileged(
      schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>,
    ): void;
    handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
  };

  export const session: {
    defaultSession: {
      setPermissionRequestHandler(
        handler: (
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void,
      ): void;
    };
  };

  export const webContents: {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}
