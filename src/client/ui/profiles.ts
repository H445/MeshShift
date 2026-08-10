/**
 * Optimization profile panel. Profiles own the mesh/LOD controls so the
 * preview and export paths always consume one shared setup.
 */
import { DEFAULT_LOD_TRIANGLE_RATIOS, type ConvertOptions } from '../../shared/options.js';

const PROFILE_STORAGE_KEY = 'modelshift.profile.v1';
const PREVIOUS_PROFILE_STORAGE_KEY = 'modelshift-3d.profile.v1';
const LEGACY_PROFILE_STORAGE_KEY = 'gltf-to-fbx.profile.v1';
const LEGACY_SETTINGS_STORAGE_KEY = 'gltf-to-fbx.settings.v1';
export interface ProfilesHandle {
  read(): ConvertOptions;
  onChange(callback: (options: ConvertOptions) => void): () => void;
  destroy(): void;
}

export function createProfiles(): ProfilesHandle {
  const panel = document.getElementById('profiles-panel') as HTMLElement;
  const openBtn = document.getElementById('profiles-btn') as HTMLButtonElement;
  const closeBtn = document.getElementById('profiles-close-btn') as HTMLButtonElement;
  const maxTrisEl = document.getElementById('profile-max-tris') as HTMLInputElement;
  const mergeEl = document.getElementById('profile-merge') as HTMLInputElement;
  const lodsEl = document.getElementById('profile-lods') as HTMLSelectElement;
  const lodTargetEls = Array.from(
    { length: 4 },
    (_, index) => document.getElementById(`profile-lod-target-${index + 1}`) as HTMLInputElement,
  );
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'profiles-title');
  let returnFocus: HTMLElement | null = null;
  const changeHandlers = new Set<(options: ConvertOptions) => void>();

  function readTargets(): number[] {
    return lodTargetEls.map((input) => Math.max(0, Math.floor(Number(input.value) || 0)));
  }

  function readControls(): ConvertOptions {
    const targets = readTargets();
    return {
      maxTriangles: Math.max(0, Math.floor(Number(maxTrisEl.value) || 0)),
      mergeByMaterial: mergeEl.checked,
      generateLODs: Math.max(0, Math.min(4, Number(lodsEl.value) || 0)),
      lodTriangleTargets: targets.some((target) => target > 0) ? targets : [],
    };
  }

  function restorePersistedProfile(): void {
    try {
      // Read the new profile key first, then migrate the optimization fields
      // from the previous Settings storage used by older builds.
      const raw =
        localStorage.getItem(PROFILE_STORAGE_KEY) ??
        localStorage.getItem(PREVIOUS_PROFILE_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_PROFILE_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<ConvertOptions> | null;
      if (!saved || typeof saved !== 'object') return;

      if (
        typeof saved.maxTriangles === 'number' &&
        Number.isFinite(saved.maxTriangles) &&
        saved.maxTriangles >= 0
      ) {
        maxTrisEl.value = String(Math.floor(saved.maxTriangles));
      }
      if (typeof saved.mergeByMaterial === 'boolean') mergeEl.checked = saved.mergeByMaterial;
      if (
        typeof saved.generateLODs === 'number' &&
        Number.isInteger(saved.generateLODs) &&
        saved.generateLODs >= 0 &&
        saved.generateLODs <= 4
      ) {
        lodsEl.value = String(saved.generateLODs);
      }
      if (Array.isArray(saved.lodTriangleTargets)) {
        saved.lodTriangleTargets.slice(0, lodTargetEls.length).forEach((target, index) => {
          if (typeof target === 'number' && Number.isFinite(target) && target > 0) {
            lodTargetEls[index].value = String(Math.floor(target));
          }
        });
      }
    } catch {
      // Local storage can be unavailable in private/locked-down contexts.
    }
  }

  function persistProfile(): void {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(readControls()));
    } catch {
      // Optimization still works when browser storage is unavailable.
    }
  }

  function emitChange(): void {
    persistProfile();
    const options = readControls();
    for (const handler of changeHandlers) handler(options);
  }

  function updateTargetPlaceholders(): void {
    const ratios = DEFAULT_LOD_TRIANGLE_RATIOS;
    lodTargetEls.forEach((input, index) => {
      input.placeholder = `auto (${Math.round((ratios[index] ?? 0.1) * 100)}%)`;
    });
  }

  restorePersistedProfile();
  updateTargetPlaceholders();

  const controls: Array<HTMLInputElement | HTMLSelectElement> = [
    maxTrisEl,
    mergeEl,
    lodsEl,
    ...lodTargetEls,
  ];
  for (const control of controls) {
    control.addEventListener('change', emitChange);
  }
  maxTrisEl.addEventListener('input', emitChange);
  for (const input of lodTargetEls) input.addEventListener('input', emitChange);

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
    onChange(callback) {
      changeHandlers.add(callback);
      callback(readControls());
      return () => changeHandlers.delete(callback);
    },
    destroy() {
      for (const control of controls) control.removeEventListener('change', emitChange);
      maxTrisEl.removeEventListener('input', emitChange);
      for (const input of lodTargetEls) input.removeEventListener('input', emitChange);
      openBtn.removeEventListener('click', togglePanel);
      closeBtn.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeydown);
      changeHandlers.clear();
    },
  };
}
