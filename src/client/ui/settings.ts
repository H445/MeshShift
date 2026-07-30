/**
 * Settings panel — reads/writes ConvertOptions to/from the side panel.
 * Persists the user's choices across reloads.
 */
import { type ConvertOptions, type OutputFormat } from '../../shared/options.js';

const SETTINGS_STORAGE_KEY = 'modelshift.settings.v1';
const PREVIOUS_STORAGE_KEY = 'modelshift-3d.settings.v1';
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

  restorePersistedSettings();

  const controls: Array<HTMLInputElement | HTMLSelectElement> = [formatEl, maxTexEl];
  for (const control of controls) control.addEventListener('change', persistSettings);

  function open() {
    panel.hidden = false;
  }
  function close() {
    panel.hidden = true;
  }
  const togglePanel = () => (panel.hidden ? open() : close());
  openBtn.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', close);

  return {
    read: readControls,
    destroy() {
      for (const control of controls) control.removeEventListener('change', persistSettings);
      openBtn.removeEventListener('click', togglePanel);
      closeBtn.removeEventListener('click', close);
    },
  };
}
