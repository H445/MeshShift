import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { DEFAULT_MAX_EXPORT_BYTES, writeExportFile } from '../server/exportServer.js';

const DESKTOP_SCHEME = 'meshshift';
const DESKTOP_HOST = 'app';
const EXPORT_CHANNEL = 'meshshift:save-export';
const MAX_EXPORT_BYTES = DEFAULT_MAX_EXPORT_BYTES;
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // Assimp's generated Emscripten bindings use Function constructors. The
  // renderer still loads only packaged code; this is the narrow, documented
  // exception required by the vendored runtime.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

interface SaveExportRequest {
  path: unknown;
  data: unknown;
}

interface SaveExportResponse {
  bytes: number;
  path: string;
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
        'Content-Security-Policy': CSP,
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

function exportRoot(): string {
  return resolve(app.getPath('documents'), 'MeshShift');
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
  const saved = await writeExportFile(
    exportRoot(),
    path,
    (async function* () {
      yield data;
    })(),
    MAX_EXPORT_BYTES,
  );
  return { bytes: saved.bytes, path: `exports/${saved.relativePath}` };
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
