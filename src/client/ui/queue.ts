/**
 * Queue UI — list of files in the bottom panel.
 * Renders rows with per-file status, progress, checkbox (for batch opt-in),
 * click-to-preview, and download button.
 */
import type { FbxResult, InspectResult } from '../../shared/options.js';

export type QueueStatus = 'queued' | 'converting' | 'done' | 'error';

export interface QueueRow {
  id: string;
  name: string;
  size: number;
  status: QueueStatus;
  progress: number; // 0..1
  phase?: string;
  result?: FbxResult;
  errorMessage?: string;
  /** Pre-conversion metadata, shown in the row. */
  inspect?: InspectResult;
  /** Whether the row is included in the next "Convert" run. */
  selected: boolean;
}

export interface QueueHandle {
  add(file: File): QueueRow;
  update(id: string, patch: Partial<QueueRow>): void;
  remove(id: string): void;
  clear(): void;
  list(): QueueRow[];
  /** Returns rows that are checked in (selected AND not yet converted). */
  selectedForConvert(): QueueRow[];
  /** Toggles a row's selected state. */
  toggleSelected(id: string): void;
  /** Sets all rows' selected state to the same value. */
  selectAll(selected: boolean): void;
  /** Sets a single row as the "active" row (visually highlighted). */
  setActive(id: string | null): void;
  /** Returns { selected, total } counts. */
  selectionCounts(): { selected: number; total: number };
  onConvertAll(cb: () => void): void;
  onClear(cb: () => void): void;
  onDownloadAll(cb: () => void): void;
  onDownloadOne(cb: (id: string) => void): void;
  onPreviewOne(cb: (id: string) => void): void;
  onRemoveOne(cb: (id: string) => void): void;
  onRowClick(cb: (id: string) => void): void;
  onSelectionChange(cb: (counts: { selected: number; total: number }) => void): void;
  onSelectAll(cb: (selected: boolean) => void): void;
  showDownloadAllButton(show: boolean): void;
  onCountChange(cb: (n: number) => void): void;
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

export function createQueue(_host: HTMLElement, listEl: HTMLElement): QueueHandle {
  const rows: QueueRow[] = [];
  let activeId: string | null = null;
  const handlers = {
    convertAll: () => {},
    clear: () => {},
    downloadAll: () => {},
    downloadOne: (_id: string) => {},
    previewOne: (_id: string) => {},
    removeOne: (_id: string) => {},
    rowClick: (_id: string) => {},
    selectAll: (_selected: boolean) => {},
  };
  let countCb: (n: number) => void = () => {};
  let selectionCb: (counts: { selected: number; total: number }) => void = () => {};

  function render() {
    listEl.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = 'queue-item';
      if (r.selected) li.classList.add('checked');
      if (!r.selected) li.classList.add('skipped');
      if (r.id === activeId) li.classList.add('active');

      // Checkbox — controls whether this row is included in the next
      // "Convert" run. Clicking the checkbox must NOT trigger row click.
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'queue-item-check';
      check.checked = r.selected;
      check.setAttribute('aria-label', `Include ${r.name} in conversion`);
      check.title = r.selected
        ? 'Included in conversion — uncheck to skip'
        : 'Skipped — check to include in conversion';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        r.selected = check.checked;
        li.classList.toggle('checked', r.selected);
        li.classList.toggle('skipped', !r.selected);
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
          const texStr = r.inspect.textureMaxSize > 0
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
        parts.push('inspecting…');
      }
      // progress is only meaningful while converting
      if (r.status === 'converting' || r.status === 'done') {
        parts.push(`${pct}%`);
      } else if (r.phase) {
        parts.push(r.phase);
      }
      meta.textContent = parts.join(' · ');
      info.append(name, meta);

      const prog = document.createElement('div');
      prog.className = 'queue-item-progress';
      prog.style.setProperty('--p', String(r.progress));
      if (r.status === 'converting') {
        prog.classList.add('animated');
      }

      const status = document.createElement('div');
      const statusText =
        r.status === 'done' ? 'Done' :
        r.status === 'error' ? 'Error' :
        r.status === 'converting' ? 'Converting' :
        r.selected ? 'Queued' : 'Skipped';
      status.className = `queue-item-status ${r.status === 'done' ? 'ok' : r.status === 'error' ? 'err' : r.status === 'converting' ? 'working' : r.selected ? '' : 'skipped'}`;
      status.textContent = statusText;

      // Remove button — always present so users can clean up the queue.
      const remove = document.createElement('button');
      remove.className = 'queue-item-remove';
      remove.title = 'Remove from queue';
      remove.setAttribute('aria-label', `Remove ${r.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.removeOne(r.id);
      });

      const action = document.createElement('div');
      action.className = 'queue-item-actions';
      if (r.status === 'done' && r.result) {
        const preview = document.createElement('button');
        preview.className = 'btn btn-secondary';
        preview.textContent = 'Preview';
        preview.title = 'Show this FBX in the right-side viewer';
        preview.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.previewOne(r.id);
        });

        const dl = document.createElement('button');
        dl.className = 'btn btn-primary';
        dl.textContent = 'Download';
        dl.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.downloadOne(r.id);
        });

        action.append(preview, dl);
      } else if (r.status === 'error') {
        const err = document.createElement('span');
        err.className = 'queue-item-error';
        err.textContent = r.errorMessage ?? 'Failed';
        err.title = err.textContent;
        action.append(err);
      }

      // Click anywhere on the row (outside of the interactive children
      // above, which stop propagation) to focus the row and surface its
      // source preview in the INPUT viewer.
      li.addEventListener('click', () => handlers.rowClick(r.id));

      li.append(check, info, prog, status, action, remove);
      listEl.append(li);
    }
  }

  function nextId() {
    return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function notifyCount() {
    countCb(rows.length);
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
      };
      rows.push(row);
      render();
      notifyCount();
      notifySelection();
      return row;
    },
    update(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      Object.assign(r, patch);
      render();
    },
    remove(id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows.splice(i, 1);
      if (activeId === id) activeId = null;
      render();
      notifyCount();
      notifySelection();
    },
    clear() {
      rows.length = 0;
      activeId = null;
      render();
      notifyCount();
      notifySelection();
    },
    list() {
      return rows.slice();
    },
    selectedForConvert() {
      return rows.filter((r) => r.selected && r.status !== 'done' && r.status !== 'converting');
    },
    toggleSelected(id) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      r.selected = !r.selected;
      render();
      notifySelection();
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
    onConvertAll(cb) { handlers.convertAll = cb; },
    onClear(cb) { handlers.clear = cb; },
    onDownloadAll(cb) { handlers.downloadAll = cb; },
    onDownloadOne(cb) { handlers.downloadOne = cb; },
    onPreviewOne(cb) { handlers.previewOne = cb; },
    onRemoveOne(cb) { handlers.removeOne = cb; },
    onRowClick(cb) { handlers.rowClick = cb; },
    onSelectionChange(cb) {
      selectionCb = cb;
      // Fire immediately so the caller can sync the master checkbox + button label.
      cb(selectionCounts());
    },
    onSelectAll(cb) { handlers.selectAll = cb; },
    showDownloadAllButton(show) {
      const btn = document.getElementById('download-all-btn') as HTMLButtonElement | null;
      if (btn) btn.hidden = !show;
    },
    onCountChange(cb) { countCb = cb; },
  };
}
