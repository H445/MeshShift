/**
 * Settings panel — reads/writes ConvertOptions to/from the side panel.
 * Persists the user's choices across reloads.
 */
import { type ConvertOptions, type OutputFormat } from '../../shared/options.js';

const SETTINGS_STORAGE_KEY = 'meshshift.settings.v1';
const PREVIOUS_STORAGE_KEY = 'meshshift-3d.settings.v1';
const LEGACY_STORAGE_KEY = 'gltf-to-fbx.settings.v1';
const OUTPUT_FORMATS = ['fbx', 'glb', 'gltf', 'obj', 'stl', 'ply', 'dae'] as const;

export interface SettingsHandle {
  read(): ConvertOptions;
  destroy(): void;
}

export function createSettings(): SettingsHandle {
  const panel = document.getElementById('settings-panel') as HTMLElement;
  const openBtn = document.getElementById('settings-btn') as HTMLButtonElement;
  const closeBtn = document.getElementById('settings-close-btn') as HTMLButtonElement;
  const formatEl = document.getElementById('opt-format') as HTMLSelectElement;
  const maxTexEl = document.getElementById('opt-max-tex') as HTMLSelectElement;
  const exportPathEl = document.getElementById('settings-export-path') as HTMLInputElement;
  const exportBrowseBtn = document.getElementById('settings-export-browse') as HTMLButtonElement;
  const exportDefaultBtn = document.getElementById('settings-export-default') as HTMLButtonElement;
  const exportStatusEl = document.getElementById('settings-export-status') as HTMLElement;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'settings-title');
  let returnFocus: HTMLElement | null = null;

  function readControls(): ConvertOptions {
    return {
      outputFormat: (formatEl.value as OutputFormat) || 'fbx',
      maxTextureSize: Number(maxTexEl.value) || 2048,
    };
  }

  function selectHasValue(select: HTMLSelectElement, value: string): boolean {
    return Array.from(select.options).some((option) => option.value === value);
  }

  function restorePersistedSettings(): void {
    try {
      const raw =
        localStorage.getItem(SETTINGS_STORAGE_KEY) ??
        localStorage.getItem(PREVIOUS_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<ConvertOptions> | null;
      if (!saved || typeof saved !== 'object') return;

      if (
        typeof saved.outputFormat === 'string' &&
        OUTPUT_FORMATS.includes(saved.outputFormat as (typeof OUTPUT_FORMATS)[number])
      ) {
        formatEl.value = saved.outputFormat;
      }
      if (
        typeof saved.maxTextureSize === 'number' &&
        selectHasValue(maxTexEl, String(saved.maxTextureSize))
      ) {
        maxTexEl.value = String(saved.maxTextureSize);
      }
    } catch {
      // localStorage can be unavailable in private/locked-down contexts.
    }
  }

  function persistSettings(): void {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(readControls()));
    } catch {
      // Conversion should still work when browser storage is unavailable.
    }
  }

  function updateExportLocation(path: string, isDefault: boolean): void {
    exportPathEl.value = path;
    exportPathEl.title = path;
    exportStatusEl.textContent = isDefault
      ? 'Default location: exports beside the installed app when the platform permits writing there.'
      : 'Custom export location.';
  }

  async function loadExportLocation(): Promise<void> {
    const desktop = window.meshshiftDesktop;
    if (!desktop) {
      exportPathEl.value = 'exports/ (project folder)';
      exportPathEl.title = exportPathEl.value;
      exportPathEl.disabled = true;
      exportBrowseBtn.disabled = true;
      exportDefaultBtn.disabled = true;
      exportStatusEl.textContent = 'Desktop folder selection is available in the installed app.';
      return;
    }
    try {
      const location = await desktop.getExportDirectory();
      updateExportLocation(location.path, location.isDefault);
    } catch (error) {
      exportStatusEl.textContent = `Could not read export location: ${String(error)}`;
    }
  }

  async function chooseExportLocation(): Promise<void> {
    const desktop = window.meshshiftDesktop;
    if (!desktop) return;
    exportBrowseBtn.disabled = true;
    exportDefaultBtn.disabled = true;
    try {
      const selected = await desktop.chooseExportDirectory();
      if (selected) {
        const location = await desktop.setExportDirectory(selected);
        updateExportLocation(location.path, location.isDefault);
      }
    } catch (error) {
      exportStatusEl.textContent = `Could not set export location: ${String(error)}`;
    } finally {
      exportBrowseBtn.disabled = false;
      exportDefaultBtn.disabled = false;
    }
  }

  async function useDefaultExportLocation(): Promise<void> {
    const desktop = window.meshshiftDesktop;
    if (!desktop) return;
    exportBrowseBtn.disabled = true;
    exportDefaultBtn.disabled = true;
    try {
      const location = await desktop.setExportDirectory(null);
      updateExportLocation(location.path, location.isDefault);
    } catch (error) {
      exportStatusEl.textContent = `Could not reset export location: ${String(error)}`;
    } finally {
      exportBrowseBtn.disabled = false;
      exportDefaultBtn.disabled = false;
    }
  }

  restorePersistedSettings();
  void loadExportLocation();

  const controls: Array<HTMLInputElement | HTMLSelectElement> = [formatEl, maxTexEl];
  for (const control of controls) control.addEventListener('change', persistSettings);
  exportBrowseBtn.addEventListener('click', chooseExportLocation);
  exportDefaultBtn.addEventListener('click', useDefaultExportLocation);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  function open() {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.hidden = false;
    requestAnimationFrame(() => focusableElements()[0]?.focus());
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    const focus = returnFocus;
    returnFocus = null;
    focus?.focus();
  }
  const togglePanel = () => (panel.hidden ? open() : close());
  const onKeydown = (event: KeyboardEvent) => {
    if (panel.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusableElements();
    if (elements.length === 0) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  openBtn.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', onKeydown);

  return {
    read: readControls,
    destroy() {
      for (const control of controls) control.removeEventListener('change', persistSettings);
      exportBrowseBtn.removeEventListener('click', chooseExportLocation);
      exportDefaultBtn.removeEventListener('click', useDefaultExportLocation);
      openBtn.removeEventListener('click', togglePanel);
      closeBtn.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeydown);
    },
  };
}
