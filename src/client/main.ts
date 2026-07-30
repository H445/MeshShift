/**
 * Web app entry point. Wires up dropzone, queue, viewers, settings, and conversion.
 * The core is loaded dynamically so three.js + assimpjs don't bloat the initial bundle.
 */
import { createDropzone } from './ui/dropzone.js';
import { createQueue } from './ui/queue.js';
import { createSettings } from './ui/settings.js';
import { createProfiles } from './ui/profiles.js';
import { createViewer, type ViewerAxis } from './ui/viewer.js';
import { toast } from './ui/toast.js';
import { saveResultsToExports, type SavedExport } from './lib/export-store.js';
import {
  cancelPreviewNormalizations,
  convertInWorker,
  disposePreviewNormalizer,
  normalizeForConversion,
  normalizePreview,
  optimizeInWorker,
  type PreviewNormalized,
} from './lib/preview-normalizer.js';
import { optimizationOptionsKey, usesOptimization } from './lib/optimization-cache.js';
import { lodLevelsThrough, reconcileLodLevels, sameLodLevels } from './lib/lod-selection.js';
import { detectLods, selectLod, renderLodSelector, hideLodSelector } from './ui/lod.js';
import type { AssetFile, ConvertPhase, ConvertResult, InspectResult } from '../shared/options.js';
import type { OptimizeChange, OptimizeResult } from '../core/optimize.js';
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
  /** Reuse an optimized GLB while its source and optimization settings match. */
  optimizedPreview?: {
    key: string;
    result: OptimizeResult;
  };
  /** Highest LOD discovered in the source before generated profile levels are added. */
  sourceMaxLod: number;
}
const fileRows: FileRow[] = [];
let activeId: string | null = null;
let inputPreviewRequest = 0;
let outputPreviewRequest = 0;

function syncFileLodLevels(
  entry: FileRow,
  generatedLods = profiles.read().generateLODs ?? 0,
): void {
  const row = queue.list().find((candidate) => candidate.id === entry.id);
  if (!row) return;
  const availableLods = lodLevelsThrough(Math.max(entry.sourceMaxLod, generatedLods));
  if (sameLodLevels(row.availableLods, availableLods)) return;
  const selectedLods = reconcileLodLevels(row.availableLods, row.selectedLods, availableLods);
  queue.update(entry.id, {
    availableLods,
    selectedLods,
    ...(row.status === 'done'
      ? {
          status: 'queued' as const,
          progress: 0,
          phase: undefined,
          result: undefined,
        }
      : {}),
  });
}

function syncAllFileLodLevels(generatedLods: number): void {
  for (const entry of fileRows) syncFileLodLevels(entry, generatedLods);
  syncSaveAllVisibility();
}

profiles.onChange((options) => syncAllFileLodLevels(options.generateLODs ?? 0));

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
    const entry = { id: row.id, file: group.primary, files: group.files, sourceMaxLod: 0 };
    fileRows.push(entry);
    added.push(entry);
    syncFileLodLevels(entry);
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
  entry.optimizedPreview = undefined;
  entry.sourceMaxLod = 0;
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
    availableLods: [0],
    selectedLods: [0],
  });
  syncFileLodLevels(entry);
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

function beginOutputLoading(
  request: number,
  title: string,
  detail = 'Preparing source model…',
): void {
  outputLoadingTitle.textContent = title;
  updateOutputLoading(request, 0, detail);
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
  normalizer: typeof normalizePreview = normalizePreview,
): Promise<PreviewNormalized> {
  if (!entry.previewNormalizedPromise) {
    entry.previewNormalizedPromise = (async () => {
      const files = await readAssetFiles(entry, onReadProgress);
      return normalizer(files, file.name, onWorkerProgress);
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
    const sourceLods = detectLods(gltf.scene);
    if (sourceLods.maxLod !== entry.sourceMaxLod) {
      entry.sourceMaxLod = sourceLods.maxLod;
      syncFileLodLevels(entry);
    }

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
function handleLodsForScene(scene: unknown, allowedLevels?: number[]) {
  const info = detectLods(scene as { traverse: (cb: (obj: unknown) => void) => void });
  if (info.maxLod === 0) {
    hideLodSelector(lodSelector, lodSliderHost);
    return;
  }
  const levels = (allowedLevels ?? Array.from(info.meshesByLod.keys()))
    .filter((level) => (info.meshesByLod.get(level)?.length ?? 0) > 0)
    .sort((a, b) => a - b);
  if (levels.length === 0) {
    hideLodSelector(lodSelector, lodSliderHost);
    return;
  }
  renderLodSelector(
    lodSelector,
    lodSliderHost,
    info,
    (level) => {
      selectLod(info, level);
    },
    levels,
  );
  // Default to the first retained level in the converted export.
  selectLod(info, levels[0]);
}

async function previewConverted(result: ConvertResult) {
  resetOutputPreview();
  const request = outputPreviewRequest;
  beginOutputLoading(
    request,
    `Loading converted preview · ${result.filename}`,
    'Preparing converted files…',
  );
  let lastProgress = 0;
  try {
    const normalized = await normalizeForConversion(
      result.files,
      result.filename,
      (phase, pct) => {
        const [progress, detail] = workerNormalizationProgress(phase, pct);
        lastProgress = Math.max(lastProgress, 0.05 + progress * 0.87);
        updateOutputLoading(request, lastProgress, detail);
      },
      true,
    );
    updateOutputLoading(request, 0.96, 'Parsing converted preview…');
    await nextPaint();
    await previewGlb(
      normalized.data,
      `Converted ${result.format.toUpperCase()} · ${result.filename}`,
      request,
      result.lodLevels,
    );
    updateOutputLoading(request, 1, 'Converted preview ready');
    await nextPaint();
  } catch (err) {
    if (request !== outputPreviewRequest) return;
    outputEmpty.hidden = false;
    outputCanvas.hidden = true;
    const msg = (err as Error)?.message ?? String(err);
    toast(`Converted preview failed: ${msg}`, 'err');
  } finally {
    finishOutputLoading(request);
  }
}

// Preview a GLB (the optimized one) directly without going through FBX.
async function previewGlb(
  glb: Uint8Array,
  label: string,
  activeRequest?: number,
  allowedLodLevels?: number[],
) {
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
            handleLodsForScene(g.scene, allowedLodLevels);
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
queue.onLodSelectionChange((id) => {
  const row = queue.list().find((candidate) => candidate.id === id);
  if (!row || (row.status !== 'done' && row.status !== 'error')) return;
  queue.update(id, {
    status: 'queued',
    progress: 0,
    phase: undefined,
    result: undefined,
    errorMessage: undefined,
    selected: true,
  });
  resetOutputPreview();
  syncSaveAllVisibility();
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
  syncSaveAllVisibility();
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
  beginOutputLoading(request, `Generating optimized preview · ${target.file.name}`);
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
    const { inspectGltf } = await import('@core');
    const options = readOptions();
    const cacheKey = optimizationOptionsKey(options);
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

    let result: OptimizeResult;
    if (target.optimizedPreview?.key === cacheKey) {
      result = target.optimizedPreview.result;
      updateProgress(0.97, 'Reusing generated optimized model…');
    } else {
      result = await optimizeInWorker(normalized.data, options, (phase, pct) => {
        const [start, end] = OPTIMIZED_PREVIEW_PHASE_RANGES[phase];
        const clamped = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
        updateProgress(
          0.46 + (start + (end - start) * clamped) * 0.51,
          OPTIMIZED_PREVIEW_PHASE_LABELS[phase],
        );
      });
      assertCurrent();
      target.optimizedPreview = { key: cacheKey, result };
    }
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

function workerExportProgress(phase: ConvertPhase, pct: number): [number, string] {
  const progress = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  if (phase === 'parse') return [progress * 0.38, 'Reading prepared model…'];
  if (phase === 'export') return [0.42 + progress * 0.53, 'Writing selected format…'];
  if (phase === 'inspect') {
    return [progress >= 1 ? 1 : 0.42, 'Validating export…'];
  }
  return [0.42, 'Preparing export…'];
}

async function convertAll() {
  const targets = queue.selectedForConvert();
  if (targets.length === 0) {
    toast('No files selected for conversion.', 'warn');
    return;
  }
  const missingLodSelection = targets.find((row) => row.selectedLods.length === 0);
  if (missingLodSelection) {
    toast(`Select at least one LOD to save for ${missingLodSelection.name}.`, 'warn');
    return;
  }

  resetOutputPreview();
  const request = outputPreviewRequest;
  const title =
    targets.length === 1
      ? `Converting · ${targets[0].name}`
      : `Converting ${targets.length} models`;
  beginOutputLoading(request, title, 'Preparing conversion queue…');

  convertAllBtn.disabled = true;
  clearBtn.disabled = true;
  previewOptBtn.disabled = true;
  loadBtn.disabled = true;
  addMoreBtn.disabled = true;
  if (masterCheck) masterCheck.disabled = true;

  const options = readOptions();
  const cacheKey = optimizationOptionsKey(options);
  const itemProgress = new Map<string, number>(targets.map((row) => [row.id, 0]));
  const lastItemProgress = new Map<string, number>(targets.map((row) => [row.id, 0]));
  let autoPreview:
    | {
        data: Uint8Array;
        label: string;
        lodLevels: number[];
      }
    | undefined;
  let renderedOptimizationStats = false;

  const updateItemProgress = (entry: FileRow, progress: number, detail: string): void => {
    const monotonic = Math.max(lastItemProgress.get(entry.id) ?? 0, progress);
    lastItemProgress.set(entry.id, monotonic);
    itemProgress.set(entry.id, monotonic);
    queue.update(entry.id, { progress: monotonic, phase: detail });
    const average =
      Array.from(itemProgress.values()).reduce((sum, value) => sum + value, 0) /
      Math.max(1, itemProgress.size);
    const outputDetail = targets.length === 1 ? detail : `${entry.file.name} · ${detail}`;
    updateOutputLoading(request, Math.min(0.99, average), outputDetail);
  };

  async function runOne(id: string): Promise<void> {
    const entry = fileRows.find((candidate) => candidate.id === id);
    if (!entry) return;
    const sourceFile = entry.file;
    try {
      queue.update(entry.id, {
        status: 'converting',
        progress: 0,
        phase: 'Preparing source…',
      });

      const normalized = await normalizedPreview(
        entry,
        sourceFile,
        (pct) => updateItemProgress(entry, 0.02 + pct * 0.08, 'Reading source files…'),
        (phase, pct) => {
          const [progress, detail] = workerNormalizationProgress(phase, pct);
          updateItemProgress(entry, 0.1 + progress * 0.2, detail);
        },
        () => updateItemProgress(entry, 0.3, 'Reusing prepared source model…'),
        normalizeForConversion,
      );
      if (entry.file !== sourceFile) throw new Error('Source model changed during conversion.');
      updateItemProgress(entry, 0.3, 'Source model ready');
      const shouldOptimize = usesOptimization(options, normalized.stats.textureMaxSize);

      let preparedData = normalized.data;
      let optimized: OptimizeResult | undefined;
      if (entry.optimizedPreview?.key === cacheKey) {
        optimized = entry.optimizedPreview.result;
        preparedData = optimized.data;
        updateItemProgress(entry, 0.68, 'Reusing generated optimized model…');
      } else if (shouldOptimize) {
        optimized = await optimizeInWorker(normalized.data, options, (phase, pct) => {
          const [start, end] = OPTIMIZED_PREVIEW_PHASE_RANGES[phase];
          const clamped = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
          const progress = start + (end - start) * clamped;
          updateItemProgress(entry, 0.3 + progress * 0.38, OPTIMIZED_PREVIEW_PHASE_LABELS[phase]);
        });
        if (entry.file !== sourceFile) throw new Error('Source model changed during conversion.');
        entry.optimizedPreview = { key: cacheKey, result: optimized };
        preparedData = optimized.data;
      } else {
        updateItemProgress(entry, 0.68, 'Prepared model ready for export');
      }

      const beforeStats = queue.list().find((row) => row.id === entry.id)?.inspect;
      if (!renderedOptimizationStats && optimized && beforeStats) {
        renderStats(beforeStats, optimized.stats, optimized.changes);
        renderedOptimizationStats = true;
      }

      const preparedName = `${sourceFile.name.replace(/\.[^.]+$/, '')}.glb`;
      const exportRow = queue.list().find((row) => row.id === entry.id);
      if (!exportRow || exportRow.selectedLods.length === 0) {
        throw new Error('Select at least one LOD before exporting.');
      }
      const result = await convertInWorker(
        [{ name: preparedName, data: preparedData }],
        sourceFile.name,
        options,
        optimized?.stats ?? normalized.stats,
        {
          available: exportRow.availableLods,
          selected: exportRow.selectedLods,
        },
        (phase, pct) => {
          const [progress, detail] = workerExportProgress(phase, pct);
          updateItemProgress(entry, 0.68 + progress * 0.3, detail);
        },
      );
      if (entry.file !== sourceFile) throw new Error('Source model changed during conversion.');

      queue.update(entry.id, {
        status: 'done',
        progress: 1,
        phase: 'done',
        result,
      });
      itemProgress.set(entry.id, 1);
      lastItemProgress.set(entry.id, 1);
      autoPreview ??= {
        data: preparedData,
        label: `Converted ${result.format.toUpperCase()} · ${result.filename}`,
        lodLevels: result.lodLevels ?? exportRow.selectedLods,
      };
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      queue.update(entry.id, {
        status: 'error',
        progress: 1,
        errorMessage: error.message || 'Failed',
      });
      itemProgress.set(entry.id, 1);
      lastItemProgress.set(entry.id, 1);
      toast(`${sourceFile.name}: ${error.message || 'conversion failed'}`, 'err');
    }
  }

  // The worker serializes its native WebAssembly state. Running one model at a
  // time also prevents several large transferable buffers from accumulating.
  for (const target of targets) await runOne(target.id);

  const succeededTargets = targets.filter((row) => row.status === 'done' && row.result);
  let savedExports: SavedExport[] = [];
  let saveError: Error | undefined;
  if (succeededTargets.length > 0) {
    updateOutputLoading(request, 0.985, 'Saving converted files to exports/…');
    await nextPaint();
    try {
      savedExports = await saveResultsToExports(succeededTargets.map((row) => row.result!));
    } catch (error) {
      saveError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (autoPreview && request === outputPreviewRequest) {
    try {
      updateOutputLoading(request, 0.995, 'Rendering converted preview…');
      await nextPaint();
      await previewGlb(autoPreview.data, autoPreview.label, request, autoPreview.lodLevels);
      updateOutputLoading(
        request,
        1,
        saveError ? 'Conversion complete · save failed' : 'Conversion saved to exports/',
      );
      await nextPaint();
    } catch (error) {
      toast(`Converted preview failed: ${(error as Error).message}`, 'err');
    }
  }
  finishOutputLoading(request);

  convertAllBtn.disabled = false;
  clearBtn.disabled = false;
  previewOptBtn.disabled = false;
  loadBtn.disabled = false;
  addMoreBtn.disabled = false;
  if (masterCheck) masterCheck.disabled = false;

  syncSaveAllVisibility();
  if (saveError) {
    toast(`Conversion complete, but files were not saved: ${saveError.message}`, 'err');
  } else if (succeededTargets.length === targets.length) {
    const conversionMessage =
      targets.length === 1 ? 'Conversion complete' : `${targets.length} conversions complete`;
    toast(`${conversionMessage} · ${savedExportMessage(savedExports)}`, 'ok');
  } else if (succeededTargets.length > 0) {
    toast(
      `${succeededTargets.length}/${targets.length} conversions complete · ${savedExportMessage(savedExports)}`,
      'warn',
    );
  } else {
    toast('No files converted successfully.', 'warn');
  }
}

function syncSaveAllVisibility(): void {
  const succeeded = queue.list().filter((row) => row.status === 'done' && row.result);
  queue.showSaveAllButton(
    succeeded.length > 1 || succeeded.some((row) => (row.result?.files.length ?? 0) > 1),
  );
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
