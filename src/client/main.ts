/**
 * Web app entry point. Wires up dropzone, queue, viewers, settings, and conversion.
 * The core is loaded dynamically so three.js + assimpjs don't bloat the initial bundle.
 */
import { createDropzone } from './ui/dropzone.js';
import { createQueue } from './ui/queue.js';
import { createSettings } from './ui/settings.js';
import { createProfiles } from './ui/profiles.js';
import { createViewer, type ViewerAxis } from './ui/viewer.js';
import { progressToast, toast } from './ui/toast.js';
import { saveResultsToExports, type SavedExport } from './lib/export-store.js';
import {
  cancelPreviewNormalizations,
  disposePreviewNormalizer,
  normalizePreview,
  type PreviewNormalized,
} from './lib/preview-normalizer.js';
import { detectLods, selectLod, renderLodSelector, hideLodSelector } from './ui/lod.js';
import type { AssetFile, ConvertPhase, ConvertResult, InspectResult } from '../shared/options.js';
import type { OptimizeChange } from '../core/optimize.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

const inputCanvas = document.getElementById('canvas-input') as HTMLCanvasElement;
const outputCanvas = document.getElementById('canvas-output') as HTMLCanvasElement;
const inputEmpty = document.querySelector('#viewer-input .viewer-empty') as HTMLElement;
const outputEmpty = document.querySelector('#viewer-output .viewer-empty') as HTMLElement;
const inputLoading = document.getElementById('input-loading') as HTMLElement;
const inputLoadingTitle = document.getElementById('input-loading-title') as HTMLElement;
const inputLoadingDetail = document.getElementById('input-loading-detail') as HTMLElement;
const inputLoadingBar = document.getElementById('input-loading-bar') as HTMLElement;
const inputLoadingPercent = document.getElementById('input-loading-percent') as HTMLElement;
const inputLoadingTrack = inputLoadingBar.parentElement as HTMLElement;
const outputLoading = document.getElementById('output-loading') as HTMLElement;
const outputLoadingTitle = document.getElementById('output-loading-title') as HTMLElement;
const outputLoadingDetail = document.getElementById('output-loading-detail') as HTMLElement;
const outputLoadingBar = document.getElementById('output-loading-bar') as HTMLElement;
const outputLoadingPercent = document.getElementById('output-loading-percent') as HTMLElement;
const outputLoadingTrack = outputLoadingBar.parentElement as HTMLElement;
const pickBtn = document.getElementById('pick-file-btn') as HTMLButtonElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const addMoreBtn = document.getElementById('add-more-btn') as HTMLButtonElement;
const previewOptBtn = document.getElementById('preview-opt-btn') as HTMLButtonElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const queueHost = document.getElementById('queue-host') as HTMLElement;
const queueList = document.getElementById('queue-list') as HTMLElement;
const queueCount = document.getElementById('queue-count') as HTMLElement;
const convertAllBtn = document.getElementById('convert-all-btn') as HTMLButtonElement;
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
const saveAllBtn = document.getElementById('save-all-btn') as HTMLButtonElement;
const masterCheck = document.getElementById('master-check') as HTMLInputElement | null;
const statsPanel = document.getElementById('stats-panel') as HTMLElement;
const statsGrid = document.getElementById('stats-grid') as HTMLElement;
const statsChangesWrap = document.getElementById('stats-changes-wrap') as HTMLElement;
const statsChanges = document.getElementById('stats-changes') as HTMLElement;
const lodSelector = document.getElementById('lod-selector') as HTMLElement;
const lodSliderHost = document.getElementById('lod-slider-host') as HTMLElement;
const wireframeInputBtn = document.getElementById('wireframe-input-btn') as HTMLButtonElement;
const wireframeOutputBtn = document.getElementById('wireframe-output-btn') as HTMLButtonElement;
const axisLockInput = document.getElementById('axis-lock-input') as HTMLElement;
const axisLockOutput = document.getElementById('axis-lock-output') as HTMLElement;
const autoRotateInputBtn = document.querySelector(
  '#axis-lock-input [data-auto-rotate]',
) as HTMLButtonElement;
const autoRotateOutputBtn = document.querySelector(
  '#axis-lock-output [data-auto-rotate]',
) as HTMLButtonElement;

const inputViewer = createViewer(inputCanvas);
const outputViewer = createViewer(outputCanvas);
const settings = createSettings();
const profiles = createProfiles();

function readOptions() {
  return { ...settings.read(), ...profiles.read() };
}

const TASK_PHASE_RANGES: Record<ConvertPhase, [number, number]> = {
  parse: [0, 0.08],
  inspect: [0.92, 1],
  optimize: [0.16, 0.72],
  textures: [0.08, 0.16],
  materials: [0.72, 0.76],
  skeleton: [0.76, 0.8],
  animation: [0.8, 0.84],
  export: [0.84, 0.94],
  post: [0.94, 1],
};

const TASK_PHASE_LABELS: Record<ConvertPhase, string> = {
  parse: 'Reading source…',
  inspect: 'Checking result…',
  optimize: 'Optimizing geometry…',
  textures: 'Processing textures…',
  materials: 'Processing materials…',
  skeleton: 'Processing skeleton…',
  animation: 'Processing animation…',
  export: 'Exporting…',
  post: 'Finalizing…',
};

const OPTIMIZED_PREVIEW_PHASE_RANGES: Record<ConvertPhase, [number, number]> = {
  parse: [0, 0.1],
  textures: [0.1, 0.24],
  optimize: [0.24, 0.72],
  materials: [0.72, 0.78],
  skeleton: [0.78, 0.82],
  animation: [0.82, 0.86],
  inspect: [0.86, 0.92],
  export: [0.92, 0.99],
  post: [0.99, 1],
};

const OPTIMIZED_PREVIEW_PHASE_LABELS: Record<ConvertPhase, string> = {
  parse: 'Parsing normalized model…',
  textures: 'Preparing textures…',
  optimize: 'Optimizing geometry and generating LODs…',
  materials: 'Updating materials…',
  skeleton: 'Preserving skeleton…',
  animation: 'Preserving animation…',
  inspect: 'Inspecting optimized scene…',
  export: 'Packaging optimized preview…',
  post: 'Finalizing optimized preview…',
};

const queue = createQueue(queueHost, queueList);
interface FileRow {
  id: string;
  file: File;
  files: File[];
  /** Reuse the active preview parse instead of parsing large files again. */
  inspectPromise?: Promise<InspectResult>;
  /** Reuse the worker-normalized GLB when a row is focused again. */
  previewNormalizedPromise?: Promise<PreviewNormalized>;
}
const fileRows: FileRow[] = [];
let activeId: string | null = null;
let inputPreviewRequest = 0;
let outputPreviewRequest = 0;

// Dropzone
createDropzone(document.body).onFiles((files) => addFiles(files));

// File picker
let replaceActiveOnLoad = false;
pickBtn.addEventListener('click', () => fileInput.click());
loadBtn.addEventListener('click', () => {
  replaceActiveOnLoad = true;
  fileInput.multiple = true;
  fileInput.click();
});
addMoreBtn.addEventListener('click', () => {
  replaceActiveOnLoad = false;
  fileInput.multiple = true;
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  if (files.length) {
    if (replaceActiveOnLoad) replaceActiveFiles(files);
    else addFiles(files);
  }
  replaceActiveOnLoad = false;
  fileInput.multiple = true;
  fileInput.value = '';
});

const PRIMARY_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds'];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function groupAssetFiles(files: File[]): Array<{ primary: File; files: File[] }> {
  const primary = files.filter((file) => PRIMARY_EXTENSIONS.includes(extensionOf(file.name)));
  const companions = files.filter((file) => !primary.includes(file));
  return primary.map((file) => ({ primary: file, files: [file, ...companions] }));
}

function fileImportName(file: File): string {
  return file.webkitRelativePath || file.name;
}

function readFileWithProgress(
  file: File,
  onProgress: (loaded: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    reader.addEventListener('load', () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error(`Could not read "${file.name}" as binary data.`));
        return;
      }
      onProgress(reader.result.byteLength);
      resolve(reader.result);
    });
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error(`Could not read "${file.name}".`));
    });
    reader.addEventListener('abort', () => {
      const error = new Error(`Reading "${file.name}" was cancelled.`);
      error.name = 'AbortError';
      reject(error);
    });
    reader.readAsArrayBuffer(file);
  });
}

async function readAssetFiles(
  entry: FileRow,
  onProgress?: (pct: number) => void,
): Promise<AssetFile[]> {
  const total = entry.files.reduce((sum, file) => sum + file.size, 0);
  const loaded = new Map<File, number>();
  const update = (file: File, bytes: number) => {
    loaded.set(file, bytes);
    const current = Array.from(loaded.values()).reduce((sum, value) => sum + value, 0);
    onProgress?.(total > 0 ? Math.min(1, current / total) : 1);
  };
  onProgress?.(0);
  const files = await Promise.all(
    entry.files.map(async (file) => ({
      name: fileImportName(file),
      data: await readFileWithProgress(file, (bytes) => update(file, bytes)),
    })),
  );
  onProgress?.(1);
  return files;
}

async function addFiles(files: File[]) {
  if (files.length === 0) return;
  const groups = groupAssetFiles(files);
  if (groups.length === 0) {
    toast('No supported 3D asset was selected.', 'warn');
    return;
  }
  queueHost.hidden = false;
  const added: FileRow[] = [];
  for (const group of groups) {
    const row = queue.add(group.primary);
    const entry = { id: row.id, file: group.primary, files: group.files };
    fileRows.push(entry);
    added.push(entry);
    const totalBytes = group.files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes !== group.primary.size) queue.update(row.id, { size: totalBytes });
  }
  // Auto-focus the last added file so the user sees a preview right away.
  const lastId = added[added.length - 1].id;
  focusRow(lastId);
}

function trackInspection(
  entry: FileRow,
  file: File,
  promise: Promise<InspectResult>,
): Promise<InspectResult> {
  entry.inspectPromise = promise;
  promise
    .then((info) => {
      if (entry.file === file) queue.update(entry.id, { inspect: info });
    })
    .catch(() => {
      // Inspection is non-critical; optimization will surface parse errors.
    });
  return promise;
}

function resetOutputPreview() {
  outputPreviewRequest++;
  outputLoading.hidden = true;
  outputViewer.clear();
  outputViewer.setAxisLock(null);
  outputViewer.setWireframe(false);
  wireframeOutputBtn.setAttribute('aria-pressed', 'false');
  outputEmpty.hidden = false;
  outputCanvas.hidden = true;
  showOutputLabel('Converted preview');
  hideStats();
  hideLodSelector(lodSelector, lodSliderHost);
}

function replaceActiveFiles(files: File[]) {
  const group = groupAssetFiles(files)[0];
  if (!group) {
    toast('No supported 3D asset was selected.', 'warn');
    return;
  }
  const entry = activeId ? fileRows.find((row) => row.id === activeId) : undefined;
  if (!entry) {
    addFiles(files);
    return;
  }

  inputPreviewRequest++;
  cancelPreviewNormalizations();
  entry.file = group.primary;
  entry.files = group.files;
  entry.inspectPromise = undefined;
  entry.previewNormalizedPromise = undefined;
  queue.update(entry.id, {
    name: group.primary.name,
    size: group.files.reduce((sum, file) => sum + file.size, 0),
    status: 'queued',
    progress: 0,
    phase: undefined,
    result: undefined,
    errorMessage: undefined,
    inspect: undefined,
    selected: true,
  });
  queue.setActive(entry.id);
  resetOutputPreview();
  focusRow(entry.id);
}

function updateInputLoading(request: number, pct: number, detail: string): void {
  if (request !== inputPreviewRequest) return;
  const progress = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  const percent = Math.round(progress * 100);
  inputLoading.hidden = false;
  inputLoadingDetail.textContent = detail;
  inputLoadingBar.style.width = `${percent}%`;
  inputLoadingPercent.textContent = `${percent}%`;
  inputLoadingTrack.setAttribute('aria-valuenow', String(percent));
}

function beginInputLoading(request: number, file: File): void {
  inputLoadingTitle.textContent = `Loading ${file.name}`;
  updateInputLoading(request, 0, 'Preparing source files…');
}

function finishInputLoading(request: number): void {
  if (request !== inputPreviewRequest) return;
  inputLoading.hidden = true;
}

function updateOutputLoading(request: number, pct: number, detail: string): void {
  if (request !== outputPreviewRequest) return;
  const progress = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  const percent = Math.round(progress * 100);
  outputLoading.hidden = false;
  outputLoadingDetail.textContent = detail;
  outputLoadingBar.style.width = `${percent}%`;
  outputLoadingPercent.textContent = `${percent}%`;
  outputLoadingTrack.setAttribute('aria-valuenow', String(percent));
}

function beginOutputLoading(request: number, file: File): void {
  outputLoadingTitle.textContent = `Generating optimized preview · ${file.name}`;
  updateOutputLoading(request, 0, 'Preparing source model…');
}

function finishOutputLoading(request: number): void {
  if (request !== outputPreviewRequest) return;
  outputLoading.hidden = true;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function workerNormalizationProgress(phase: ConvertPhase, pct: number): [number, string] {
  const progress = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  if (phase === 'parse') {
    return [progress * 0.5, 'Analyzing source geometry…'];
  }
  if (phase === 'export') {
    return [0.5 + progress * 0.4, 'Building browser preview…'];
  }
  return [progress >= 1 ? 1 : 0.5, 'Finalizing normalized model…'];
}

async function normalizedPreview(
  entry: FileRow,
  file: File,
  onReadProgress: (pct: number) => void,
  onWorkerProgress: (phase: ConvertPhase, pct: number) => void,
  onReuse: () => void,
): Promise<PreviewNormalized> {
  if (!entry.previewNormalizedPromise) {
    entry.previewNormalizedPromise = (async () => {
      const files = await readAssetFiles(entry, onReadProgress);
      return normalizePreview(files, file.name, onWorkerProgress);
    })().catch((error) => {
      entry.previewNormalizedPromise = undefined;
      throw error;
    });
  } else {
    onReuse();
  }
  return entry.previewNormalizedPromise;
}

function parsePreviewGlb(data: Uint8Array): Promise<GLTF> {
  const buffer =
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.slice().buffer;
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, (reason) =>
      reject(reason instanceof Error ? reason : new Error(reason?.message ?? 'unknown error')),
    );
  });
}

function focusRow(id: string) {
  const entry = fileRows.find((e) => e.id === id);
  if (!entry) return;
  if (activeId !== id) cancelPreviewNormalizations();
  activeId = id;
  queue.setActive(id);
  const file = entry.file;
  const previewPromise = previewInput(entry, file);
  if (!queue.list().find((row) => row.id === entry.id)?.inspect) {
    trackInspection(entry, file, previewPromise);
  } else {
    previewPromise.catch(() => {
      // The preview callback already reports its own error.
    });
  }
}

// Normalize any supported input to GLB for the shared three.js preview.
async function previewInput(entry: FileRow, file: File): Promise<InspectResult> {
  const request = ++inputPreviewRequest;
  beginInputLoading(request, file);
  try {
    let lastProgress = 0;
    const updateMonotonic = (progress: number, detail: string) => {
      lastProgress = Math.max(lastProgress, progress);
      updateInputLoading(request, lastProgress, detail);
    };
    const normalized = await normalizedPreview(
      entry,
      file,
      (pct) => updateMonotonic(0.02 + pct * 0.16, 'Reading source files…'),
      (phase, pct) => {
        const [progress, detail] = workerNormalizationProgress(phase, pct);
        updateMonotonic(0.18 + progress * 0.72, detail);
      },
      () => updateMonotonic(0.18, 'Reusing prepared model…'),
    );
    if (request !== inputPreviewRequest || entry.file !== file || activeId !== entry.id) {
      const error = new Error('Preview loading was superseded.');
      error.name = 'AbortError';
      throw error;
    }

    updateInputLoading(request, 0.92, 'Parsing preview scene…');
    await nextPaint();
    const gltf = await parsePreviewGlb(normalized.data);
    updateInputLoading(request, 0.96, 'Inspecting scene metadata…');
    const { inspectScene } = await import('@core');
    const info = inspectScene(gltf.scene, gltf.animations);

    if (request !== inputPreviewRequest || entry.file !== file || activeId !== entry.id) {
      const error = new Error('Preview loading was superseded.');
      error.name = 'AbortError';
      throw error;
    }

    updateInputLoading(request, 0.98, 'Sending model to the viewer…');
    await nextPaint();
    inputEmpty.hidden = true;
    inputCanvas.hidden = false;
    inputViewer.setScene(gltf.scene);
    updateInputLoading(request, 1, 'Preview ready');
    await nextPaint();
    finishInputLoading(request);
    return info;
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    finishInputLoading(request);
    if (error.name !== 'AbortError' && entry.file === file && activeId === entry.id) {
      toast(`Preview failed: ${error.message}`, 'err');
    }
    throw error;
  }
}

// Preview any converted format by normalizing its output bundle to GLB.

function showOutputLabel(text: string): void {
  const label = document.getElementById('output-label') as HTMLElement | null;
  if (label) label.textContent = text;
}

/**
 * Detect LODs in a loaded scene, render the LOD slider, and
 * hide it if no LODs are found. Called after every output preview.
 */
function handleLodsForScene(scene: unknown) {
  const info = detectLods(scene as { traverse: (cb: (obj: unknown) => void) => void });
  if (info.maxLod === 0) {
    hideLodSelector(lodSelector, lodSliderHost);
    return;
  }
  renderLodSelector(lodSelector, lodSliderHost, info, (level) => {
    selectLod(info, level);
  });
  // Default to the original mesh; every generated LOD remains selectable.
  selectLod(info, 0);
}

async function previewConverted(result: ConvertResult) {
  const request = ++outputPreviewRequest;
  outputEmpty.hidden = true;
  outputCanvas.hidden = false;
  try {
    const { getAssimp } = await import('@core');
    const ajs = await getAssimp();
    const fl = new ajs.FileList();
    for (const file of result.files) fl.AddFile(file.name, new Uint8Array(file.data));
    const r = ajs.ConvertFileList(fl, 'glb2');
    if (!r.IsSuccess() || r.FileCount() === 0) {
      throw new Error(`assimp round-trip failed: ${r.GetErrorCode()}`);
    }
    const glb = r.GetFile(0).GetContent();
    const ab = new ArrayBuffer(glb.byteLength);
    new Uint8Array(ab).set(glb);
    new GLTFLoader().parse(
      ab,
      '',
      (gltf) => {
        if (request !== outputPreviewRequest) return;
        outputViewer.setScene(gltf.scene);
        showOutputLabel(`Converted ${result.format.toUpperCase()} · ${result.filename}`);
        handleLodsForScene(gltf.scene);
      },
      (err) => {
        if (request !== outputPreviewRequest) return;
        outputEmpty.hidden = false;
        outputCanvas.hidden = true;
        toast(`Preview failed: ${err?.message ?? 'unknown error'}`, 'err');
      },
    );
  } catch (err) {
    if (request !== outputPreviewRequest) return;
    outputEmpty.hidden = false;
    outputCanvas.hidden = true;
    const msg = (err as Error)?.message ?? String(err);
    toast(`Converted preview failed: ${msg}`, 'err');
  }
}

// Preview a GLB (the optimized one) directly without going through FBX.
async function previewGlb(glb: Uint8Array, label: string, activeRequest?: number) {
  const request = activeRequest ?? ++outputPreviewRequest;
  outputEmpty.hidden = true;
  outputCanvas.hidden = false;
  try {
    // GLTFExporter returns an exact Uint8Array over a plain ArrayBuffer. Reuse
    // it instead of copying another complete scan-sized GLB at peak memory.
    const ab =
      glb.buffer instanceof ArrayBuffer &&
      glb.byteOffset === 0 &&
      glb.byteLength === glb.buffer.byteLength
        ? glb.buffer
        : glb.slice().buffer;
    await new Promise<void>((resolve, reject) => {
      new GLTFLoader().parse(
        ab,
        '',
        (g) => {
          if (request === outputPreviewRequest) {
            outputViewer.setScene(g.scene);
            showOutputLabel(label);
            handleLodsForScene(g.scene);
          }
          resolve();
        },
        (err) => reject(err instanceof Error ? err : new Error(err?.message ?? 'unknown error')),
      );
    });
  } catch (err) {
    if (request !== outputPreviewRequest) return;
    outputEmpty.hidden = false;
    outputCanvas.hidden = true;
    throw err;
  }
}

// Stats diff — renders the before/after panel in the OUTPUT pane.
function renderStats(before: InspectResult, after: InspectResult, changes: OptimizeChange[]) {
  statsGrid.innerHTML = '';
  const rows: {
    label: string;
    before: number;
    after: number;
    format: (n: number) => string;
    unit?: string;
  }[] = [
    {
      label: 'Triangles',
      before: before.triangles,
      after: after.triangles,
      format: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`),
    },
    {
      label: 'Vertices',
      before: before.vertices,
      after: after.vertices,
      format: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`),
    },
    {
      label: 'Meshes',
      before: before.meshes,
      after: after.meshes,
      format: (n) => `${n}`,
    },
    {
      label: 'Materials',
      before: before.materials,
      after: after.materials,
      format: (n) => `${n}`,
    },
    {
      label: 'Textures',
      before: before.textures,
      after: after.textures,
      format: (n) => `${n}`,
    },
    {
      label: 'Max texture',
      before: before.textureMaxSize,
      after: after.textureMaxSize,
      format: (n) => (n > 0 ? `${n}px` : '—'),
    },
  ];
  for (const r of rows) {
    const cell = document.createElement('div');
    cell.className = 'stats-cell';
    const label = document.createElement('div');
    label.className = 'stats-label';
    label.textContent = r.label;
    const val = document.createElement('div');
    val.className = 'stats-value';
    if (r.before === r.after) {
      val.textContent = r.format(r.after);
    } else {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = `${r.format(r.before)} → ${r.format(r.after)}`;
      val.append(arrow);
      const delta = document.createElement('span');
      delta.className = 'delta';
      const pct = r.before > 0 ? ((r.after - r.before) / r.before) * 100 : 0;
      const rounded = Math.round(pct);
      if (rounded < 0) delta.textContent = `${rounded}%`;
      else if (rounded > 0) {
        delta.textContent = `+${rounded}%`;
        delta.classList.add('bad');
      } else {
        delta.textContent = '±0%';
      }
      val.append(delta);
    }
    cell.append(label, val);
    statsGrid.append(cell);
  }
  if (changes.length > 0) {
    statsChangesWrap.hidden = false;
    statsChanges.innerHTML = '';
    for (const c of changes) {
      const li = document.createElement('li');
      li.textContent = `[${c.kind}] ${c.detail}`;
      statsChanges.append(li);
    }
  } else {
    statsChangesWrap.hidden = true;
  }
  statsPanel.hidden = false;
}

function hideStats() {
  statsPanel.hidden = true;
  statsGrid.innerHTML = '';
  statsChanges.innerHTML = '';
  statsChangesWrap.hidden = true;
}

// Queue controls
queue.onConvertAll(() => convertAll());
queue.onClear(() => clearAll());
queue.onSaveOne(async (id) => {
  const r = queue.list().find((row) => row.id === id)?.result;
  if (!r) return;
  try {
    const saved = await saveResultsToExports([r]);
    toast(savedExportMessage(saved), 'ok');
  } catch (error) {
    toast((error as Error).message, 'err');
  }
});
queue.onSaveAll(() => saveAll());
queue.onPreviewOne((id) => {
  const r = queue.list().find((row) => row.id === id)?.result;
  if (r) previewConverted(r);
});
queue.onRowClick((id) => {
  // Click on a row → focus it and show the source preview in INPUT.
  // (Buttons inside the row stop propagation, so this only fires on
  // the row body / info area / status / progress bar.)
  focusRow(id);
});
queue.onRemoveOne((id) => {
  queue.remove(id);
  const i = fileRows.findIndex((e) => e.id === id);
  if (i >= 0) fileRows.splice(i, 1);
  if (activeId === id) {
    inputPreviewRequest++;
    cancelPreviewNormalizations();
    activeId = null;
    inputLoading.hidden = true;
    inputEmpty.hidden = false;
    inputCanvas.hidden = true;
    inputViewer.clear();
  }
  if (queue.list().length === 0) clearAll();
});
queue.onSelectionChange(({ selected, total }) => {
  if (queueCount) queueCount.textContent = String(total);
  if (masterCheck) {
    masterCheck.checked = total > 0 && selected === total;
    masterCheck.indeterminate = selected > 0 && selected < total;
  }
  // Reflect the current selection in the button label.
  if (convertAllBtn) {
    if (total === 0) {
      convertAllBtn.textContent = 'Convert all';
      convertAllBtn.disabled = true;
    } else if (selected === 0) {
      convertAllBtn.textContent = 'Convert 0';
      convertAllBtn.disabled = true;
    } else if (selected === total) {
      convertAllBtn.textContent = `Convert all (${total})`;
      convertAllBtn.disabled = false;
    } else {
      convertAllBtn.textContent = `Convert ${selected} of ${total}`;
      convertAllBtn.disabled = false;
    }
  }
  if (previewOptBtn) {
    previewOptBtn.disabled = total === 0;
  }
});

if (masterCheck) {
  masterCheck.addEventListener('change', () => {
    queue.selectAll(masterCheck.checked);
  });
}

queue.onCountChange((n) => {
  if (queueCount) queueCount.textContent = String(n);
});

// Wireframe toggles — independent per viewer.
function bindWireframeButton(btn: HTMLButtonElement, viewer: typeof inputViewer) {
  btn.addEventListener('click', () => {
    const next = !viewer.isWireframe();
    viewer.setWireframe(next);
    btn.setAttribute('aria-pressed', String(next));
    btn.title = next ? 'Wireframe on (click to disable)' : 'Toggle wireframe';
  });
}
bindWireframeButton(wireframeInputBtn, inputViewer);
bindWireframeButton(wireframeOutputBtn, outputViewer);

// Axis view widgets — snap to repeatable world-axis views and disable orbit
// rotation while locked so LOD comparisons stay visually stable.
function bindAxisLock(group: HTMLElement, viewer: typeof inputViewer) {
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-view-axis]'));
  function sync() {
    const active = viewer.getAxisLock();
    for (const button of buttons) {
      const value = button.dataset.viewAxis;
      const pressed = active === null ? value === 'free' : value === active;
      button.setAttribute('aria-pressed', String(pressed));
    }
  }
  group.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>('[data-view-axis]');
    if (!button || !group.contains(button)) return;
    const value = button.dataset.viewAxis;
    const axis: ViewerAxis = value === 'x' || value === 'y' || value === 'z' ? value : null;
    viewer.setAxisLock(axis);
    sync();
  });
  viewer.onAxisLockChange(sync);
  sync();
}
bindAxisLock(axisLockInput, inputViewer);
bindAxisLock(axisLockOutput, outputViewer);

function bindAutoRotateButton(btn: HTMLButtonElement, viewer: typeof inputViewer) {
  function sync() {
    const enabled = viewer.isAutoRotate();
    btn.setAttribute('aria-pressed', String(enabled));
    btn.title = enabled
      ? 'Auto-rotation on (click to disable)'
      : 'Auto-rotation off (click to enable)';
  }
  btn.addEventListener('click', () => {
    viewer.setAutoRotate(!viewer.isAutoRotate());
    sync();
  });
  sync();
}
bindAutoRotateButton(autoRotateInputBtn, inputViewer);
bindAutoRotateButton(autoRotateOutputBtn, outputViewer);

clearBtn.addEventListener('click', () => clearAll());
convertAllBtn.addEventListener('click', () => convertAll());
saveAllBtn.addEventListener('click', () => saveAll());
previewOptBtn.addEventListener('click', () => generateOptimizedPreview());

function clearAll() {
  inputPreviewRequest++;
  outputPreviewRequest++;
  disposePreviewNormalizer();
  inputLoading.hidden = true;
  outputLoading.hidden = true;
  queue.clear();
  fileRows.length = 0;
  activeId = null;
  queueHost.hidden = true;
  inputViewer.clear();
  outputViewer.clear();
  inputViewer.setAxisLock(null);
  outputViewer.setAxisLock(null);
  inputViewer.setWireframe(false);
  outputViewer.setWireframe(false);
  wireframeInputBtn.setAttribute('aria-pressed', 'false');
  wireframeOutputBtn.setAttribute('aria-pressed', 'false');
  wireframeInputBtn.title = 'Toggle wireframe';
  wireframeOutputBtn.title = 'Toggle wireframe';
  inputEmpty.hidden = false;
  outputEmpty.hidden = false;
  inputCanvas.hidden = true;
  outputCanvas.hidden = true;
  showOutputLabel('Converted preview');
  hideStats();
  hideLodSelector(lodSelector, lodSliderHost);
  queue.showSaveAllButton(false);
}

/**
 * Apply the current optimization settings to the active file (or the first
 * selected queued file), generate a model, and show it in OUTPUT without
 * writing the selected export format.
 */
async function generateOptimizedPreview() {
  const target = activeId ? fileRows.find((e) => e.id === activeId) : fileRows[0];
  if (!target) {
    toast('No file selected.', 'warn');
    return;
  }
  // Release the previous optimized scene before allocating another parsed
  // source, LOD set, texture-bake canvases, and output GLB. Keeping the old
  // preview resident made the second run substantially more memory-intensive
  // than the first and could crash the browser even on small assets.
  resetOutputPreview();
  const request = outputPreviewRequest;
  beginOutputLoading(request, target.file);
  previewOptBtn.disabled = true;
  let lastProgress = 0;
  const updateProgress = (progress: number, detail: string) => {
    lastProgress = Math.max(lastProgress, progress);
    updateOutputLoading(request, lastProgress, detail);
  };
  const assertCurrent = () => {
    if (request === outputPreviewRequest) return;
    const error = new Error('Optimized preview generation was cancelled.');
    error.name = 'AbortError';
    throw error;
  };

  try {
    const { optimizeGltf, inspectGltf } = await import('@core');
    const normalized = await normalizedPreview(
      target,
      target.file,
      (pct) => updateProgress(0.02 + pct * 0.1, 'Reading source files…'),
      (phase, pct) => {
        const [progress, detail] = workerNormalizationProgress(phase, pct);
        updateProgress(0.12 + progress * 0.3, detail);
      },
      () => updateProgress(0.42, 'Reusing prepared source model…'),
    );
    assertCurrent();

    const buf = normalized.data;
    updateProgress(0.43, 'Inspecting source model…');
    // Reuse inspection from the input preview when available. If input loading
    // is still finishing, await that same parse instead of starting another.
    let before = queue.list().find((row) => row.id === target.id)?.inspect;
    if (!before) {
      before = await (target.inspectPromise ??
        trackInspection(target, target.file, inspectGltf(buf)));
    }
    assertCurrent();
    updateProgress(0.46, 'Source model ready');

    const opts = {
      ...readOptions(),
      onProgress: (phase: ConvertPhase, pct: number) => {
        const [start, end] = OPTIMIZED_PREVIEW_PHASE_RANGES[phase];
        const clamped = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
        updateProgress(
          0.46 + (start + (end - start) * clamped) * 0.51,
          OPTIMIZED_PREVIEW_PHASE_LABELS[phase],
        );
      },
    };
    const result = await optimizeGltf(buf, opts);
    assertCurrent();
    updateProgress(0.98, 'Parsing optimized preview…');
    await nextPaint();
    await previewGlb(result.data, `Optimized preview · ${target.file.name}`, request);
    assertCurrent();
    updateProgress(1, 'Optimized preview ready');
    await nextPaint();
    finishOutputLoading(request);
    renderStats(before, result.stats, result.changes);
    if (result.changes.length === 0) {
      toast('Optimized preview ready · current settings made no changes.', 'ok');
    } else {
      toast(
        `Optimized preview ready · applied ${result.changes.length} optimization${result.changes.length === 1 ? '' : 's'}.`,
        'ok',
      );
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    const message = `Preview failed: ${(err as Error).message}`;
    toast(message, 'err');
  } finally {
    finishOutputLoading(request);
    previewOptBtn.disabled = queue.list().length === 0;
  }
}

async function convertAll() {
  const targets = queue.selectedForConvert();
  if (targets.length === 0) {
    toast('No files selected for conversion.', 'warn');
    return;
  }
  convertAllBtn.disabled = true;
  clearBtn.disabled = true;
  previewOptBtn.disabled = true;
  if (masterCheck) masterCheck.disabled = true;
  const task = progressToast(
    targets.length === 1 ? `Converting · ${targets[0].name}` : `Converting ${targets.length} files`,
  );
  const taskProgress = new Map<string, number>(targets.map((row) => [row.id, 0]));

  const updateBatchProgress = (id: string, phase: ConvertPhase, pct: number): void => {
    const [start, end] = TASK_PHASE_RANGES[phase];
    const clamped = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
    taskProgress.set(id, start + (end - start) * clamped);
    const average =
      Array.from(taskProgress.values()).reduce((sum, value) => sum + value, 0) /
      Math.max(1, taskProgress.size);
    task.update(average, `${TASK_PHASE_LABELS[phase]} (${Math.round(average * 100)}%)`);
  };

  // Dynamic import keeps the initial bundle small — assimpjs is only
  // loaded when the user actually starts a conversion.
  const { convertAsset, optimizeGltf } = await import('@core');

  // Read settings once
  const baseOpts = readOptions();
  const hasOptimization =
    baseOpts.maxTriangles! > 0 ||
    baseOpts.mergeByMaterial === true ||
    baseOpts.generateLODs! > 0 ||
    (baseOpts.maxTextureSize ?? 2048) < 8192;

  // Convert through a fixed worker pool. This bounds memory usage without
  // creating one polling timer per queued file.
  const maxConcurrency = 4;

  // Track whether we've auto-previewed any result yet so we only preview
  // the first successful conversion (subsequent rows can be previewed by
  // clicking the "Preview" button on each row).
  let autoPreviewed = false;

  async function runOne(id: string) {
    const entry = fileRows.find((e) => e.id === id);
    if (!entry) return;
    try {
      queue.update(entry.id, { status: 'converting', progress: 0 });
      updateBatchProgress(entry.id, 'parse', 0);
      let sourceFiles: AssetFile[] = await readAssetFiles(entry);
      // capture pre-stats from the row's inspect field if present
      const row = queue.list().find((r) => r.id === entry.id);
      const beforeStats: InspectResult | undefined = row?.inspect;
      if (hasOptimization) {
        queue.update(entry.id, { phase: 'optimizing' });
        const normalized = await convertAsset(sourceFiles, {
          ...baseOpts,
          name: entry.file.name,
          outputFormat: 'glb',
        });
        const opt = await optimizeGltf(normalized.data, {
          ...baseOpts,
          onProgress: (phase: ConvertPhase, pct: number) => {
            queue.update(entry.id, { progress: pct, phase });
            updateBatchProgress(entry.id, phase, pct);
          },
        });
        sourceFiles = [
          {
            name: `${entry.file.name.replace(/\.[^.]+$/, '')}.glb`,
            data: opt.data,
          },
        ];
        // Render the diff for the FIRST optimized file we see, so the
        // user gets a sense of what the pass did.
        if (!autoPreviewed && beforeStats) {
          renderStats(beforeStats, opt.stats, opt.changes);
        }
      }
      const result = await convertAsset(sourceFiles, {
        ...baseOpts,
        name: entry.file.name,
        onProgress: (phase: ConvertPhase, pct: number) => {
          queue.update(entry.id, { progress: pct, phase });
          updateBatchProgress(entry.id, phase, pct);
        },
      });
      queue.update(entry.id, { status: 'done', progress: 1, phase: 'done', result });
      taskProgress.set(entry.id, 1);
      if (!autoPreviewed) {
        autoPreviewed = true;
        previewConverted(result);
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      queue.update(entry.id, { status: 'error', errorMessage: e.message ?? 'Failed' });
      taskProgress.set(entry.id, 1);
      toast(`${entry.file.name}: ${e.message ?? 'conversion failed'}`, 'err');
    }
  }

  let nextTarget = 0;
  async function worker() {
    while (nextTarget < targets.length) {
      const target = targets[nextTarget++];
      await runOne(target.id);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, targets.length) }, () => worker()),
  );

  convertAllBtn.disabled = false;
  clearBtn.disabled = false;
  previewOptBtn.disabled = false;
  if (masterCheck) masterCheck.disabled = false;

  const succeeded = queue.list().filter((r) => r.status === 'done');
  if (succeeded.length > 1 || succeeded.some((row) => (row.result?.files.length ?? 0) > 1)) {
    queue.showSaveAllButton(true);
  }
  const succeededTargets = targets.filter((row) =>
    queue.list().some((item) => item.id === row.id && item.status === 'done'),
  );
  if (succeededTargets.length === targets.length) {
    task.complete(
      targets.length === 1 ? 'Conversion complete' : `${targets.length} conversions complete`,
    );
  } else if (succeededTargets.length > 0) {
    task.fail(`${succeededTargets.length}/${targets.length} conversions complete`);
  } else {
    task.fail('No files converted successfully.');
    toast('No files converted successfully.', 'warn');
  }
}

function savedExportMessage(saved: SavedExport[]): string {
  return saved.length === 1 ? `Saved ${saved[0].path}` : `Saved ${saved.length} files to exports/`;
}

async function saveAll() {
  const items = queue.list().filter((r) => r.status === 'done' && r.result);
  if (items.length === 0) return;
  saveAllBtn.disabled = true;
  try {
    const saved = await saveResultsToExports(items.map((r) => r.result!));
    toast(savedExportMessage(saved), 'ok');
  } catch (error) {
    toast((error as Error).message, 'err');
  } finally {
    saveAllBtn.disabled = false;
  }
}

// Keyboard: Esc closes settings
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const id of ['settings-panel', 'profiles-panel']) {
      const panel = document.getElementById(id) as HTMLElement | null;
      if (panel && !panel.hidden) panel.hidden = true;
    }
  }
});

// Resize hook
window.addEventListener('resize', () => {
  inputViewer.resize();
  outputViewer.resize();
});

// Surface unexpected errors so they don't vanish into the console.
window.addEventListener('error', (e) => {
  toast(`Unexpected error: ${e.message}`, 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = (e.reason as { message?: string } | undefined)?.message ?? String(e.reason);
  toast(`Unhandled: ${reason}`, 'err');
});
