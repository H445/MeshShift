import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { DEFAULT_MAX_EXPORT_BYTES, writeExportFile } from '../server/exportServer.js';
import { DESKTOP_CONTENT_SECURITY_POLICY } from './contentSecurityPolicy.js';

const DESKTOP_SCHEME = 'meshshift';
const DESKTOP_HOST = 'app';
const EXPORT_CHANNEL = 'meshshift:save-export';
const GET_EXPORT_DIRECTORY_CHANNEL = 'meshshift:get-export-directory';
const CHOOSE_EXPORT_DIRECTORY_CHANNEL = 'meshshift:choose-export-directory';
const SET_EXPORT_DIRECTORY_CHANNEL = 'meshshift:set-export-directory';
const MAX_EXPORT_BYTES = DEFAULT_MAX_EXPORT_BYTES;
const EXPORT_SETTINGS_FILE = 'export-settings.json';

interface SaveExportRequest {
  path: unknown;
  data: unknown;
}

interface SaveExportResponse {
  bytes: number;
  path: string;
}

interface ExportDirectoryResponse {
  path: string;
  defaultPath: string;
  isDefault: boolean;
}

interface StoredExportSettings {
  exportDirectory?: unknown;
}

let mainWindow: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function rendererRoot(): string {
  return resolve(app.getAppPath(), 'dist', 'client');
}

function isRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${DESKTOP_SCHEME}:` && parsed.host === DESKTOP_HOST;
  } catch {
    return false;
  }
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function safeRendererPath(requestUrl: string): string | null {
  const parsed = new URL(requestUrl);
  if (parsed.protocol !== `${DESKTOP_SCHEME}:` || parsed.host !== DESKTOP_HOST) return null;
  const requested = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html';
  const root = rendererRoot();
  const candidate = resolve(root, requested);
  const fromRoot = relative(root, candidate);
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot.includes('\0')
  ) {
    return null;
  }
  return candidate;
}

async function handleRendererRequest(request: Request): Promise<Response> {
  try {
    const path = safeRendererPath(request.url);
    if (!path) return new Response('Not found', { status: 404 });
    const info = await stat(path);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    const body = await readFile(path);
    return new Response(body, {
      headers: {
        'Content-Type': mimeType(path),
        'Content-Security-Policy': DESKTOP_CONTENT_SECURITY_POLICY,
        'Cache-Control': app.isPackaged ? 'public, max-age=31536000, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function assertTrustedSender(event: { senderFrame: { url: string } | null }): void {
  const senderUrl = event.senderFrame?.url ?? '';
  if (!isRendererUrl(senderUrl) && !senderUrl.startsWith('http://localhost:')) {
    throw new Error('Untrusted renderer.');
  }
}

function installRoot(): string {
  if (!app.isPackaged) return app.getAppPath();
  if (process.env.APPIMAGE) return dirname(process.env.APPIMAGE);
  return resolve(app.getAppPath(), '..', '..');
}

function defaultExportRoot(): string {
  return resolve(installRoot(), 'exports');
}

function fallbackExportRoot(): string {
  return resolve(app.getPath('documents'), 'MeshShift', 'exports');
}

function exportSettingsPath(): string {
  return resolve(app.getPath('userData'), EXPORT_SETTINGS_FILE);
}

function validateExportDirectory(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)) {
    throw new Error('Export directory must be an absolute path.');
  }
  return resolve(value);
}

let storedExportDirectory: string | null | undefined;

async function loadStoredExportDirectory(): Promise<string | null> {
  if (storedExportDirectory !== undefined) return storedExportDirectory;
  try {
    const raw = JSON.parse(await readFile(exportSettingsPath(), 'utf8')) as StoredExportSettings;
    storedExportDirectory = validateExportDirectory(raw.exportDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      storedExportDirectory = null;
    } else if (error instanceof SyntaxError) {
      storedExportDirectory = null;
    } else {
      throw error;
    }
  }
  return storedExportDirectory;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error('The configured export path is not a directory.');
}

async function activeExportDirectory(): Promise<{ path: string; isDefault: boolean }> {
  const configured = await loadStoredExportDirectory();
  if (configured) {
    await ensureDirectory(configured);
    return { path: configured, isDefault: false };
  }

  const preferred = defaultExportRoot();
  try {
    await ensureDirectory(preferred);
    return { path: preferred, isDefault: true };
  } catch (error) {
    const fallback = fallbackExportRoot();
    try {
      await ensureDirectory(fallback);
      console.warn(
        `MeshShift could not write to the install directory (${preferred}); using ${fallback}.`,
      );
      return { path: fallback, isDefault: true };
    } catch {
      throw error;
    }
  }
}

async function exportDirectoryResponse(): Promise<ExportDirectoryResponse> {
  const active = await activeExportDirectory();
  return { path: active.path, defaultPath: defaultExportRoot(), isDefault: active.isDefault };
}

async function setExportDirectory(value: unknown): Promise<ExportDirectoryResponse> {
  const directory = validateExportDirectory(value);
  if (directory) await ensureDirectory(directory);
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(exportSettingsPath(), JSON.stringify({ exportDirectory: directory }, null, 2));
  storedExportDirectory = directory;
  return exportDirectoryResponse();
}

async function chooseExportDirectory(event: {
  senderFrame: { url: string } | null;
}): Promise<string | null> {
  assertTrustedSender(event);
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Export data must be a byte buffer.');
}

function asRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new Error('Export path must be a non-empty string.');
  }
  return value;
}

async function saveExport(
  event: { senderFrame: { url: string } | null },
  request: SaveExportRequest,
): Promise<SaveExportResponse> {
  assertTrustedSender(event);
  const path = asRelativePath(request.path);
  const data = asBytes(request.data);
  if (data.byteLength > MAX_EXPORT_BYTES) {
    throw new Error(`Export exceeds the ${Math.floor(MAX_EXPORT_BYTES / 1024 / 1024)} MB limit.`);
  }
  const exportDirectory = await activeExportDirectory();
  const saved = await writeExportFile(
    exportDirectory.path,
    path,
    (async function* () {
      yield data;
    })(),
    MAX_EXPORT_BYTES,
  );
  return { bytes: saved.bytes, path: resolve(exportDirectory.path, saved.relativePath) };
}

function wireSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  app.on('web-contents-created', (...args: unknown[]) => {
    const contents = args[1] as {
      on(event: string, listener: (event: { preventDefault(): void }, url: string) => void): void;
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
    };
    contents.on('will-navigate', (event, url) => {
      if (!isRendererUrl(url) && !url.startsWith('http://localhost:')) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#10151d',
    webPreferences: {
      preload: resolve(app.getAppPath(), 'dist', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  const devUrl = process.env.MESHSHIFT_ELECTRON_DEV_URL;
  void (devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadURL(`${DESKTOP_SCHEME}://${DESKTOP_HOST}/index.html`));
}

function registerIpc(): void {
  ipcMain.handle(GET_EXPORT_DIRECTORY_CHANNEL, (event) => {
    assertTrustedSender(event);
    return exportDirectoryResponse();
  });
  ipcMain.handle(CHOOSE_EXPORT_DIRECTORY_CHANNEL, (event) => chooseExportDirectory(event));
  ipcMain.handle(SET_EXPORT_DIRECTORY_CHANNEL, (event, value: unknown) => {
    assertTrustedSender(event);
    return setExportDirectory(value);
  });
  ipcMain.handle(EXPORT_CHANNEL, (event, request: unknown) =>
    saveExport(event, (request ?? {}) as SaveExportRequest),
  );
}

async function start(): Promise<void> {
  await app.whenReady();
  protocol.handle(DESKTOP_SCHEME, handleRendererRequest);
  wireSecurity();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  void start().catch((error: unknown) => {
    console.error('MeshShift desktop startup failed:', error);
    app.exit(1);
  });
}
