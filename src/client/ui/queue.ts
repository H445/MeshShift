/**
 * Queue UI — list of files in the bottom panel.
 * Renders rows with per-file status, progress, checkbox (for batch opt-in),
 * direct conversion, click-to-preview, and retry-save-to-exports controls.
 */
import type { ConvertResult, InspectResult } from '../../shared/options.js';
import { selectConversionTargets } from '../lib/conversion-targets.js';
import { normalizeLodLevels } from '../lib/lod-selection.js';

export type QueueStatus = 'queued' | 'converting' | 'done' | 'error';

export interface QueueRow {
  id: string;
  name: string;
  size: number;
  status: QueueStatus;
  progress: number; // 0..1
  phase?: string;
  result?: ConvertResult;
  errorMessage?: string;
  /** Pre-conversion metadata, shown in the row. */
  inspect?: InspectResult;
  /** Whether the row is included in the next "Convert" run. */
  selected: boolean;
  /** LOD levels available from the source and current generation profile. */
  availableLods: number[];
  /** LOD levels retained in the next saved export. */
  selectedLods: number[];
}

export interface QueueHandle {
  add(file: File): QueueRow;
  update(id: string, patch: Partial<QueueRow>): void;
  remove(id: string): void;
  clear(): void;
  list(): QueueRow[];
  /** Resolves either the checked batch or one explicitly requested row. */
  conversionTargets(requestedId?: string): QueueRow[];
  /** Sets all rows' selected state to the same value. */
  selectAll(selected: boolean): void;
  /** Sets a single row as the "active" row (visually highlighted). */
  setActive(id: string | null): void;
  /** Returns { selected, total } counts. */
  selectionCounts(): { selected: number; total: number };
  /** Locks queue mutations and row actions during a conversion run. */
  setBusy(busy: boolean): void;
  onConvertOne(cb: (id: string) => void): void;
  onSaveOne(cb: (id: string) => void): void;
  onPreviewOne(cb: (id: string) => void): void;
  onRemoveOne(cb: (id: string) => void): void;
  onRowClick(cb: (id: string) => void): void;
  onLodSelectionChange(cb: (id: string, levels: number[]) => void): void;
  onSelectionChange(cb: (counts: { selected: number; total: number }) => void): void;
  showSaveAllButton(show: boolean): void;
}

function formatBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatTriangles(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tris`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tris`;
  return `${Math.round(n)} tris`;
}

export function createQueue(listEl: HTMLElement): QueueHandle {
  const rows: QueueRow[] = [];
  let activeId: string | null = null;
  let busy = false;
  const handlers = {
    convertOne: (_id: string) => {},
    saveOne: (_id: string) => {},
    previewOne: (_id: string) => {},
    removeOne: (_id: string) => {},
    rowClick: (_id: string) => {},
    lodSelection: (_id: string, _levels: number[]) => {},
  };
  const globalLodHost = document.getElementById('queue-global-lods') as HTMLElement | null;
  let selectionCb: (counts: { selected: number; total: number }) => void = () => {};

  function renderGlobalLodControls(): void {
    if (!globalLodHost) return;
    globalLodHost.innerHTML = '';
    const levels = normalizeLodLevels(rows.flatMap((row) => row.availableLods));
    globalLodHost.hidden = rows.length === 0 || levels.length <= 1;
    if (globalLodHost.hidden) return;

    const title = document.createElement('span');
    title.className = 'queue-lod-label';
    title.textContent = 'All files';
    globalLodHost.append(title);
    const locked = busy || rows.some((row) => row.status === 'converting');

    for (const level of levels) {
      const applicable = rows.filter((row) => row.availableLods.includes(level));
      const selectedCount = applicable.filter((row) => row.selectedLods.includes(level)).length;
      const label = document.createElement('label');
      label.className = 'queue-lod-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = applicable.length > 0 && selectedCount === applicable.length;
      input.indeterminate = selectedCount > 0 && selectedCount < applicable.length;
      input.disabled = locked;
      input.setAttribute('aria-label', `Save LOD${level} for all files`);
      const text = document.createElement('span');
      text.textContent = `LOD${level}`;
      input.addEventListener('change', () => {
        const selected = input.checked;
        for (const row of applicable) {
          const next = normalizeLodLevels(
            selected
              ? [...row.selectedLods, level]
              : row.selectedLods.filter((candidate) => candidate !== level),
          );
          if (
            next.length === row.selectedLods.length &&
            next.every((candidate, index) => candidate === row.selectedLods[index])
          ) {
            continue;
          }
          row.selectedLods = next;
          handlers.lodSelection(row.id, [...next]);
        }
        render();
      });
      label.append(input, text);
      globalLodHost.append(label);
    }
  }

  function render() {
    listEl.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = 'queue-item';
      if (r.selected) li.classList.add('checked');
      if (!r.selected && r.status === 'queued') li.classList.add('skipped');
      if (r.id === activeId) li.classList.add('active');

      // Checkbox — controls whether this row is included in the next
      // "Convert" run. Clicking the checkbox must NOT trigger row click.
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'queue-item-check';
      check.checked = r.selected;
      check.disabled = busy;
      check.setAttribute('aria-label', `Include ${r.name} in conversion`);
      check.title = r.selected
        ? 'Included in conversion — uncheck to skip'
        : 'Skipped — check to include in conversion';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        r.selected = check.checked;
        li.classList.toggle('checked', r.selected);
        li.classList.toggle('skipped', !r.selected && r.status === 'queued');
        notifySelection();
      });

      const info = document.createElement('div');
      info.className = 'queue-item-info';
      const name = document.createElement('div');
      name.className = 'queue-item-name';
      name.textContent = r.name;
      name.title = r.name;
      const meta = document.createElement('div');
      meta.className = 'queue-item-meta';
      const pct = Math.round(r.progress * 100);
      const sizeStr = formatBytes(r.size);
      // File size · triangles · textures · animations
      const parts: string[] = [sizeStr];
      if (r.inspect) {
        if (r.inspect.triangles > 0) parts.push(formatTriangles(r.inspect.triangles));
        if (r.inspect.textures > 0) {
          const texStr =
            r.inspect.textureMaxSize > 0
              ? `${r.inspect.textures} tex (max ${r.inspect.textureMaxSize}px)`
              : `${r.inspect.textures} tex`;
          parts.push(texStr);
        }
        if (r.inspect.materials > 0) parts.push(`${r.inspect.materials} mats`);
        if (r.inspect.animations > 0) parts.push(`${r.inspect.animations} anim`);
        if (r.inspect.bones > 0) parts.push(`${r.inspect.bones} bones`);
        if (r.inspect.hasSkin) parts.push('skinned');
        if (r.inspect.hasMorph) parts.push('morph');
      } else {
        parts.push('preview for details');
      }
      // progress is only meaningful while converting
      if (r.status === 'converting' || r.status === 'done') {
        parts.push(`${pct}%`);
      } else if (r.phase) {
        parts.push(r.phase);
      }
      meta.textContent = parts.join(' · ');
      info.append(name, meta);

      if (r.availableLods.length > 1) {
        const lods = document.createElement('div');
        lods.className = 'queue-item-lods';
        lods.setAttribute('aria-label', `LOD export selection for ${r.name}`);
        const lodLabel = document.createElement('span');
        lodLabel.className = 'queue-lod-label';
        lodLabel.textContent = 'Save';
        lods.append(lodLabel);
        for (const level of r.availableLods) {
          const label = document.createElement('label');
          label.className = 'queue-lod-toggle';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = r.selectedLods.includes(level);
          input.disabled = busy || r.status === 'converting';
          input.setAttribute('aria-label', `Save LOD${level} for ${r.name}`);
          input.addEventListener('click', (event) => event.stopPropagation());
          input.addEventListener('change', () => {
            r.selectedLods = normalizeLodLevels(
              input.checked
                ? [...r.selectedLods, level]
                : r.selectedLods.filter((candidate) => candidate !== level),
            );
            handlers.lodSelection(r.id, [...r.selectedLods]);
            render();
          });
          const text = document.createElement('span');
          text.textContent = `LOD${level}`;
          label.append(input, text);
          lods.append(label);
        }
        info.append(lods);
      }

      const prog = document.createElement('div');
      prog.className = 'queue-item-progress';
      prog.style.setProperty('--p', String(r.progress));
      prog.setAttribute('role', 'progressbar');
      prog.setAttribute('aria-label', `Conversion progress for ${r.name}`);
      prog.setAttribute('aria-valuemin', '0');
      prog.setAttribute('aria-valuemax', '100');
      prog.setAttribute('aria-valuenow', String(Math.round(r.progress * 100)));
      if (r.status === 'converting') {
        prog.classList.add('animated');
      }

      const status = document.createElement('div');
      const statusText =
        r.status === 'done'
          ? 'Done'
          : r.status === 'error'
            ? 'Error'
            : r.status === 'converting'
              ? 'Converting'
              : r.selected
                ? 'Queued'
                : 'Skipped';
      status.className = `queue-item-status ${r.status === 'done' ? 'ok' : r.status === 'error' ? 'err' : r.status === 'converting' ? 'working' : r.selected ? '' : 'skipped'}`;
      status.textContent = statusText;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');

      // Remove button — always present so users can clean up the queue.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'queue-item-remove';
      remove.title = 'Remove from queue';
      remove.setAttribute('aria-label', `Remove ${r.name}`);
      remove.textContent = '×';
      remove.disabled = busy;
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.removeOne(r.id);
      });

      const action = document.createElement('div');
      action.className = 'queue-item-actions';
      const convert = document.createElement('button');
      convert.type = 'button';
      convert.className = `btn ${
        r.status === 'done' ? 'btn-secondary' : 'btn-primary'
      } queue-item-convert`;
      convert.textContent =
        r.status === 'converting'
          ? 'Converting…'
          : r.status === 'error'
            ? 'Retry'
            : r.status === 'done'
              ? 'Convert again'
              : 'Convert';
      convert.title =
        r.status === 'done'
          ? `Convert ${r.name} again using the current settings`
          : `Convert only ${r.name}`;
      convert.setAttribute('aria-label', `${convert.textContent} ${r.name}`);
      convert.disabled = busy || r.status === 'converting';
      convert.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.convertOne(r.id);
      });

      if (r.status === 'done' && r.result) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'btn btn-secondary';
        preview.textContent = 'Preview';
        preview.title = 'Show this converted asset in the right-side viewer';
        preview.setAttribute('aria-label', `Preview ${r.name}`);
        preview.disabled = busy;
        preview.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.previewOne(r.id);
        });

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn btn-primary';
        save.textContent = 'Save again';
        save.title = 'Save again or overwrite converted files in the project exports folder';
        save.setAttribute('aria-label', `Save ${r.name} again`);
        save.disabled = busy;
        save.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.saveOne(r.id);
        });

        action.append(convert, preview, save);
      } else if (r.status === 'error') {
        const err = document.createElement('span');
        err.className = 'queue-item-error';
        err.textContent = r.errorMessage ?? 'Failed';
        err.title = err.textContent;
        action.append(err, convert);
      } else {
        action.append(convert);
      }

      // Click anywhere on the row (outside of the interactive children
      // above, which stop propagation) to focus the row and surface its
      // source preview in the INPUT viewer.
      li.addEventListener('click', () => handlers.rowClick(r.id));

      li.append(check, info, prog, status, action, remove);
      listEl.append(li);
    }
    renderGlobalLodControls();
  }

  function nextId() {
    return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function notifySelection() {
    selectionCb(selectionCounts());
  }

  function selectionCounts() {
    return { selected: rows.filter((r) => r.selected).length, total: rows.length };
  }

  return {
    add(file: File) {
      const row: QueueRow = {
        id: nextId(),
        name: file.name,
        size: file.size,
        status: 'queued',
        progress: 0,
        selected: true,
        availableLods: [0],
        selectedLods: [0],
      };
      rows.push(row);
      render();
      notifySelection();
      return row;
    },
    update(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      const previousSelected = r.selected;
      const previousStatus = r.status;
      Object.assign(r, patch);
      r.availableLods = normalizeLodLevels(r.availableLods);
      r.selectedLods = normalizeLodLevels(r.selectedLods).filter((level) =>
        r.availableLods.includes(level),
      );
      render();
      if (r.selected !== previousSelected || r.status !== previousStatus) notifySelection();
    },
    remove(id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows.splice(i, 1);
      if (activeId === id) activeId = null;
      render();
      notifySelection();
    },
    clear() {
      rows.length = 0;
      activeId = null;
      render();
      notifySelection();
    },
    list() {
      return rows.slice();
    },
    conversionTargets(requestedId) {
      return selectConversionTargets(rows, requestedId);
    },
    selectAll(selected) {
      for (const r of rows) r.selected = selected;
      render();
      notifySelection();
    },
    setActive(id) {
      activeId = id;
      // Re-render only the active class — cheaper than full render.
      for (const li of Array.from(listEl.querySelectorAll('.queue-item'))) {
        const idx = Array.from(listEl.children).indexOf(li);
        if (idx >= 0 && rows[idx]) {
          li.classList.toggle('active', rows[idx].id === activeId);
        }
      }
    },
    selectionCounts() {
      return selectionCounts();
    },
    setBusy(nextBusy) {
      if (busy === nextBusy) return;
      busy = nextBusy;
      render();
    },
    onConvertOne(cb) {
      handlers.convertOne = cb;
    },
    onSaveOne(cb) {
      handlers.saveOne = cb;
    },
    onPreviewOne(cb) {
      handlers.previewOne = cb;
    },
    onRemoveOne(cb) {
      handlers.removeOne = cb;
    },
    onRowClick(cb) {
      handlers.rowClick = cb;
    },
    onLodSelectionChange(cb) {
      handlers.lodSelection = cb;
    },
    onSelectionChange(cb) {
      selectionCb = cb;
      // Fire immediately so the caller can sync the master checkbox + button label.
      cb(selectionCounts());
    },
    showSaveAllButton(show) {
      const btn = document.getElementById('save-all-btn') as HTMLButtonElement | null;
      if (btn) btn.hidden = !show;
    },
  };
}
