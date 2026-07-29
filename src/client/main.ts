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
import { downloadBlob, makeFbxZip } from './lib/zip.js';
import { detectLods, selectLod, renderLodSelector, hideLodSelector } from './ui/lod.js';
import type { ConvertPhase, FbxResult, InspectResult } from '../shared/options.js';
import type { OptimizeChange } from '../core/optimize.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const inputCanvas = document.getElementById('canvas-input') as HTMLCanvasElement;
const outputCanvas = document.getElementById('canvas-output') as HTMLCanvasElement;
const inputEmpty = document.querySelector('#viewer-input .viewer-empty') as HTMLElement;
const outputEmpty = document.querySelector('#viewer-output .viewer-empty') as HTMLElement;
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
const downloadAllBtn = document.getElementById('download-all-btn') as HTMLButtonElement;
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

function updateTaskToast(
  task: ReturnType<typeof progressToast>,
  phase: ConvertPhase,
  pct: number,
  detail?: string,
): void {
  const [start, end] = TASK_PHASE_RANGES[phase];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  task.update(start + (end - start) * clamped, detail ?? TASK_PHASE_LABELS[phase]);
}

const queue = createQueue(queueHost, queueList);
const fileRows: { id: string; file: File }[] = [];
let activeId: string | null = null;

// Dropzone
createDropzone(document.body).onFiles((files) => addFiles(files));

// File picker
let replaceActiveOnLoad = false;
pickBtn.addEventListener('click', () => fileInput.click());
loadBtn.addEventListener('click', () => {
  replaceActiveOnLoad = true;
  fileInput.multiple = false;
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
    if (replaceActiveOnLoad) replaceActiveFile(files[0]);
    else addFiles(files);
  }
  replaceActiveOnLoad = false;
  fileInput.multiple = true;
  fileInput.value = '';
});

async function addFiles(files: File[]) {
  if (files.length === 0) return;
  queueHost.hidden = false;
  for (const f of files) {
    const row = queue.add(f);
    fileRows.push({ id: row.id, file: f });
  }
  // Auto-focus the last added file so the user sees a preview right away.
  const lastId = fileRows[fileRows.length - 1].id;
  focusRow(lastId);
  // Kick off inspection in the background — the queue row will
  // update with metadata as soon as it's ready.
  for (const f of files) {
    inspectOne(f)
      .then((info) => {
        const entry = fileRows.find((e) => e.file === f);
        if (entry) queue.update(entry.id, { inspect: info });
      })
      .catch(() => {
        // Silent — inspect is non-critical
      });
  }
}

function resetOutputPreview() {
  outputViewer.clear();
  outputViewer.setAxisLock(null);
  outputViewer.setWireframe(false);
  wireframeOutputBtn.setAttribute('aria-pressed', 'false');
  outputEmpty.hidden = false;
  outputCanvas.hidden = true;
  showOutputLabel('FBX preview');
  hideStats();
  hideLodSelector(lodSelector, lodSliderHost);
}

function replaceActiveFile(file: File) {
  const entry = activeId ? fileRows.find((row) => row.id === activeId) : undefined;
  if (!entry) {
    addFiles([file]);
    return;
  }

  entry.file = file;
  queue.update(entry.id, {
    name: file.name,
    size: file.size,
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
  previewInput(entry);
  inspectOne(file)
    .then((info) => {
      if (entry.file === file) queue.update(entry.id, { inspect: info });
    })
    .catch(() => {
      // Inspection is non-critical; the replacement remains usable.
    });
}

async function inspectOne(file: File): Promise<InspectResult> {
  const { inspectGltf } = await import('@core');
  const buf = await file.arrayBuffer();
  return inspectGltf(buf);
}

function focusRow(id: string) {
  const entry = fileRows.find((e) => e.id === id);
  if (!entry) return;
  activeId = id;
  queue.setActive(id);
  previewInput(entry);
}

// Preview the input GLB/GLTF in the left viewer.
async function previewInput(entry: { id: string; file: File }) {
  const buf = await entry.file.arrayBuffer();
  new GLTFLoader().parse(
    buf,
    '',
    (gltf) => {
      inputEmpty.hidden = true;
      inputCanvas.hidden = false;
      inputViewer.setScene(gltf.scene);
    },
    (err) => {
      toast(`Preview failed: ${err?.message ?? 'unknown error'}`, 'err');
    },
  );
}

// Preview the converted FBX in the right viewer (via FBX → glb2 round-trip).
//
// We do this by round-tripping the generated FBX back through assimp's
// glb2 (binary glTF) export, then loading the result with three.js's
// GLTFLoader. The round-trip is lossless: assimp reads its own FBX
// output, fully reconstructs the scene (including textures, materials,
// bones, animations), and re-emits it as a glb2 — and three.js's
// GLTFLoader handles glb2 perfectly.

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

async function previewFbx(result: FbxResult) {
  outputEmpty.hidden = true;
  outputCanvas.hidden = false;
  try {
    const { getAssimp } = await import('@core');
    const ajs = await getAssimp();
    const fl = new ajs.FileList();
    fl.AddFile(result.filename, new Uint8Array(result.data));
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
        outputViewer.setScene(gltf.scene);
        showOutputLabel(`Converted FBX · ${result.filename}`);
        handleLodsForScene(gltf.scene);
      },
      (err) => {
        outputEmpty.hidden = false;
        outputCanvas.hidden = true;
        toast(`Preview failed: ${err?.message ?? 'unknown error'}`, 'err');
      },
    );
  } catch (err) {
    outputEmpty.hidden = false;
    outputCanvas.hidden = true;
    const msg = (err as Error)?.message ?? String(err);
    toast(`FBX preview failed: ${msg}`, 'err');
  }
}

// Preview a GLB (the optimized one) directly without going through FBX.
async function previewGlb(glb: Uint8Array, label: string) {
  outputEmpty.hidden = true;
  outputCanvas.hidden = false;
  try {
    const ab = new ArrayBuffer(glb.byteLength);
    new Uint8Array(ab).set(glb);
    new GLTFLoader().parse(
      ab,
      '',
      (g) => {
        outputViewer.setScene(g.scene);
        showOutputLabel(label);
        handleLodsForScene(g.scene);
      },
      (err) => {
        outputEmpty.hidden = false;
        outputCanvas.hidden = true;
        toast(`Preview failed: ${err?.message ?? 'unknown error'}`, 'err');
      },
    );
  } catch (err) {
    outputEmpty.hidden = false;
    outputCanvas.hidden = true;
    toast(`Preview failed: ${(err as Error).message}`, 'err');
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
queue.onDownloadOne((id) => {
  const r = queue.list().find((row) => row.id === id)?.result;
  if (r) downloadBlob(new Blob([r.data.slice().buffer]), r.filename);
});
queue.onDownloadAll(() => downloadAll());
queue.onPreviewOne((id) => {
  const r = queue.list().find((row) => row.id === id)?.result;
  if (r) previewFbx(r);
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
    activeId = null;
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
downloadAllBtn.addEventListener('click', () => downloadAll());
previewOptBtn.addEventListener('click', () => previewOptimization());

function clearAll() {
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
  showOutputLabel('FBX preview');
  hideStats();
  hideLodSelector(lodSelector, lodSliderHost);
  queue.showDownloadAllButton(false);
}

/**
 * Apply the current optimization settings to the active file (or the
 * first selected queued file) and show the result in OUTPUT. Does
 * NOT write an FBX — it's a preview of the optimization pass.
 */
async function previewOptimization() {
  const target = activeId ? fileRows.find((e) => e.id === activeId) : fileRows[0];
  if (!target) {
    toast('No file selected.', 'warn');
    return;
  }
  previewOptBtn.disabled = true;
  const task = progressToast(`Preview optimization · ${target.file.name}`);
  try {
    const { optimizeGltf, inspectGltf } = await import('@core');
    const opts = {
      ...readOptions(),
      onProgress: (phase: ConvertPhase, pct: number) => updateTaskToast(task, phase, pct),
    };
    updateTaskToast(task, 'parse', 0.05, 'Reading source…');
    const buf = await target.file.arrayBuffer();
    updateTaskToast(task, 'inspect', 0, 'Inspecting source…');
    const before = await inspectGltf(buf);
    updateTaskToast(task, 'inspect', 0.12, 'Source inspected');
    const result = await optimizeGltf(buf, opts);
    updateTaskToast(task, 'export', 0.9, 'Loading optimized preview…');
    await previewGlb(result.data, `Optimized preview · ${target.file.name}`);
    renderStats(before, result.stats, result.changes);
    if (result.changes.length === 0) {
      task.complete('No optimizations applied (settings match defaults).');
    } else {
      task.complete(
        `Applied ${result.changes.length} optimization${result.changes.length === 1 ? '' : 's'}.`,
      );
    }
  } catch (err) {
    const message = `Preview failed: ${(err as Error).message}`;
    task.fail(message);
    toast(message, 'err');
  } finally {
    previewOptBtn.disabled = false;
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
  const { convertGltfToFbx, optimizeGltf } = await import('@core');

  // Read settings once
  const baseOpts = readOptions();
  const hasOptimization =
    baseOpts.maxTriangles! > 0 ||
    baseOpts.mergeByMaterial === true ||
    baseOpts.generateLODs! > 0 ||
    (baseOpts.maxTextureSize ?? 2048) < 8192;

  // Phase 1: convert in sequence, max 4 concurrent.
  const inFlight: Promise<void>[] = [];
  const sema = { n: 0, max: 4 };

  // Track whether we've auto-previewed any result yet so we only preview
  // the first successful conversion (subsequent rows can be previewed by
  // clicking the "Preview" button on each row).
  let autoPreviewed = false;

  async function runOne(id: string) {
    const entry = fileRows.find((e) => e.id === id);
    if (!entry) return;
    if (sema.n >= sema.max) {
      await new Promise<void>((r) => {
        const i = setInterval(() => {
          if (sema.n < sema.max) {
            clearInterval(i);
            r();
          }
        }, 20);
      });
    }
    sema.n++;
    try {
      queue.update(entry.id, { status: 'converting', progress: 0 });
      updateBatchProgress(entry.id, 'parse', 0);
      let convertBuf: ArrayBuffer | Uint8Array = await entry.file.arrayBuffer();
      let beforeStats: InspectResult | undefined = entry.file ? undefined : undefined;
      // capture pre-stats from the row's inspect field if present
      const row = queue.list().find((r) => r.id === entry.id);
      beforeStats = row?.inspect;
      if (hasOptimization) {
        queue.update(entry.id, { phase: 'optimizing' });
        const opt = await optimizeGltf(convertBuf, {
          ...baseOpts,
          onProgress: (phase: ConvertPhase, pct: number) => {
            queue.update(entry.id, { progress: pct, phase });
            updateBatchProgress(entry.id, phase, pct);
          },
        });
        convertBuf = opt.data;
        // Render the diff for the FIRST optimized file we see, so the
        // user gets a sense of what the pass did.
        if (!autoPreviewed && beforeStats) {
          renderStats(beforeStats, opt.stats, opt.changes);
        }
      }
      const result = await convertGltfToFbx(convertBuf, {
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
        // Render the actual generated FBX in the OUTPUT pane.
        previewFbx(result);
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      queue.update(entry.id, { status: 'error', errorMessage: e.message ?? 'Failed' });
      taskProgress.set(entry.id, 1);
      toast(`${entry.file.name}: ${e.message ?? 'conversion failed'}`, 'err');
    } finally {
      sema.n--;
    }
  }

  for (const row of targets) {
    inFlight.push(runOne(row.id));
  }
  await Promise.all(inFlight);

  convertAllBtn.disabled = false;
  clearBtn.disabled = false;
  previewOptBtn.disabled = false;
  if (masterCheck) masterCheck.disabled = false;

  const succeeded = queue.list().filter((r) => r.status === 'done');
  if (succeeded.length > 1) queue.showDownloadAllButton(true);
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

async function downloadAll() {
  const items = queue.list().filter((r) => r.status === 'done' && r.result);
  if (items.length === 0) return;
  const results = items.map((r) => r.result!);
  const blob =
    results.length === 1 ? new Blob([results[0].data.slice().buffer]) : await makeFbxZip(results);
  const name = results.length === 1 ? results[0].filename : `gltf-to-fbx-${Date.now()}.zip`;
  downloadBlob(blob, name);
  toast(results.length === 1 ? 'Downloaded FBX' : `Downloaded ${results.length} FBXs as zip`, 'ok');
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
