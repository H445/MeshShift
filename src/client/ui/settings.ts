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

  restorePersistedSettings();

  const controls: Array<HTMLInputElement | HTMLSelectElement> = [formatEl, maxTexEl];
  for (const control of controls) control.addEventListener('change', persistSettings);

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
      openBtn.removeEventListener('click', togglePanel);
      closeBtn.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeydown);
    },
  };
}
