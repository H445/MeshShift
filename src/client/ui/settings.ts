/**
 * Settings panel — reads/writes ConvertOptions to/from the side panel.
 * Applies engine presets and persists the user's choices across reloads.
 */
import { type ConvertOptions } from '../../shared/options.js';

const SETTINGS_STORAGE_KEY = 'gltf-to-fbx.settings.v1';
const AXES = ['y-up', 'z-up'] as const;
const ANIMATION_FILTERS = ['all', 'skeletal', 'none'] as const;

export interface SettingsHandle {
  read(): ConvertOptions;
  destroy(): void;
}

export function createSettings(): SettingsHandle {
  const panel = document.getElementById('settings-panel') as HTMLElement;
  const openBtn = document.getElementById('settings-btn') as HTMLButtonElement;
  const closeBtn = document.getElementById('settings-close-btn') as HTMLButtonElement;
  const embedEl = document.getElementById('opt-embed') as HTMLInputElement;
  const maxTexEl = document.getElementById('opt-max-tex') as HTMLSelectElement;
  const scaleEl = document.getElementById('opt-scale') as HTMLInputElement;
  const axisEl = document.getElementById('opt-axis') as HTMLSelectElement;
  const animEl = document.getElementById('opt-anim') as HTMLSelectElement;
  const morphEl = document.getElementById('opt-morph') as HTMLInputElement;

  function readControls(): ConvertOptions {
    return {
      embedTextures: embedEl.checked,
      maxTextureSize: Number(maxTexEl.value) || 2048,
      scale: Number(scaleEl.value) || 1,
      axis: (axisEl.value as 'y-up' | 'z-up') || 'y-up',
      animationFilter: (animEl.value as 'all' | 'skeletal' | 'none') || 'all',
      morphTargets: morphEl.checked,
    };
  }

  function selectHasValue(select: HTMLSelectElement, value: string): boolean {
    return Array.from(select.options).some((option) => option.value === value);
  }

  function restorePersistedSettings(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<ConvertOptions> | null;
      if (!saved || typeof saved !== 'object') return;

      if (typeof saved.embedTextures === 'boolean') embedEl.checked = saved.embedTextures;
      if (
        typeof saved.maxTextureSize === 'number' &&
        selectHasValue(maxTexEl, String(saved.maxTextureSize))
      ) {
        maxTexEl.value = String(saved.maxTextureSize);
      }
      if (typeof saved.scale === 'number' && Number.isFinite(saved.scale) && saved.scale > 0) {
        scaleEl.value = String(saved.scale);
      }
      if (typeof saved.axis === 'string' && AXES.includes(saved.axis as (typeof AXES)[number])) {
        axisEl.value = saved.axis;
      }
      if (
        typeof saved.animationFilter === 'string' &&
        ANIMATION_FILTERS.includes(saved.animationFilter as (typeof ANIMATION_FILTERS)[number])
      ) {
        animEl.value = saved.animationFilter;
      }
      if (typeof saved.morphTargets === 'boolean') morphEl.checked = saved.morphTargets;
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

  const controls: Array<HTMLInputElement | HTMLSelectElement> = [
    embedEl,
    maxTexEl,
    scaleEl,
    axisEl,
    animEl,
    morphEl,
  ];
  for (const control of controls) control.addEventListener('change', persistSettings);
  scaleEl.addEventListener('input', persistSettings);

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
      scaleEl.removeEventListener('input', persistSettings);
      openBtn.removeEventListener('click', togglePanel);
      closeBtn.removeEventListener('click', close);
    },
  };
}
