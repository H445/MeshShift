/**
 * LOD (Level of Detail) detection and selection helpers.
 *
 * When the optimize pass generates LODs, the resulting glTF has the
 * original mesh (LOD0) plus child meshes named like `mesh_LOD1`,
 * `mesh_LOD2`, etc. This module detects those, groups them by LOD
 * level, and provides a function to toggle visibility based on the
 * selected level.
 */

/** Regex matching the `_LOD\d+` suffix that optimize.ts produces. */
const LOD_RE = /_LOD(\d+)$/i;

/** Extract the LOD level from a mesh name. 0 if no suffix. */
export function parseLodLevel(name: string | undefined | null): number {
  if (!name) return 0;
  const m = LOD_RE.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

/** Format a triangle count for display beside the slider: 1.2k, 600, etc. */
function formatTris(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function countTriangles(mesh: {
  geometry: {
    index: { count: number } | null;
    attributes: { position?: { count: number } };
  } | null;
}): number {
  const geo = mesh.geometry;
  if (!geo) return 0;
  if (geo.index) return geo.index.count / 3;
  return geo.attributes.position?.count ?? 0;
}

/** Result of scanning a scene for LODs. */
export interface LodInfo {
  /** Map of LOD level → list of meshes at that level. */
  meshesByLod: Map<number, unknown[]>;
  /** Highest LOD level found (0 means no LODs). */
  maxLod: number;
  /** Triangle count per level (index 0 = LOD0, 1 = LOD1, ...). */
  perLodTris: number[];
  /** Total triangles if all LODs were rendered together. */
  totalTris: number;
}

/**
 * Walk the scene and group meshes by their LOD level. Returns null
 * if no LODs are present (maxLod === 0 means only LOD0).
 */
export function detectLods(scene: { traverse: (cb: (obj: unknown) => void) => void }): LodInfo {
  const meshesByLod = new Map<number, unknown[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene.traverse((obj: any) => {
    if (obj?.isMesh) {
      const lvl = parseLodLevel(obj.name);
      if (!meshesByLod.has(lvl)) meshesByLod.set(lvl, []);
      meshesByLod.get(lvl)!.push(obj);
    }
  });
  const maxLod = meshesByLod.size > 0 ? Math.max(...meshesByLod.keys()) : 0;
  const perLodTris: number[] = [];
  let totalTris = 0;
  for (let i = 0; i <= maxLod; i++) {
    const meshes = meshesByLod.get(i) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tris = meshes.reduce((sum: number, m: any) => sum + countTriangles(m), 0);
    const rounded = Math.round(tris);
    perLodTris.push(rounded);
    totalTris += rounded;
  }
  return { meshesByLod, maxLod, perLodTris, totalTris };
}

/**
 * Show only the given LOD level. Other levels are hidden.
 * Every preview has exactly one active LOD level. This prevents overlapping
 * geometry when an asset contains multiple generated levels.
 */
export function selectLod(info: LodInfo, level: number): void {
  const selected = Math.max(0, Math.min(info.maxLod, Math.floor(level)));
  for (const [lvl, meshes] of info.meshesByLod) {
    const visible = lvl === selected;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of meshes as any[]) m.visible = visible;
  }
}

/**
 * Render the discrete LOD slider into a host element. Each stop maps directly
 * to LOD0 through the deepest generated level. Native range keyboard controls
 * make every level directly reachable without an overlapping "All" state.
 * Returns the current selection. The onChange callback is called whenever the
 * user picks a different level.
 */
export function renderLodSelector(
  host: HTMLElement,
  sliderHost: HTMLElement,
  info: LodInfo,
  onChange: (level: number) => void,
  allowedLevels?: number[],
): { selected: () => number } {
  host.hidden = false;
  sliderHost.innerHTML = '';
  const requested = allowedLevels
    ? Array.from(new Set(allowedLevels)).sort((a, b) => a - b)
    : Array.from(info.meshesByLod.keys()).sort((a, b) => a - b);
  const levels = requested.filter((level) => (info.meshesByLod.get(level)?.length ?? 0) > 0);
  if (levels.length === 0) levels.push(0);

  let current = levels[0];

  const slider = document.createElement('input');
  slider.id = 'lod-slider';
  slider.className = 'lod-slider';
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(levels.length - 1);
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', 'Preview level of detail');

  const value = document.createElement('output');
  value.className = 'lod-slider-value';
  value.htmlFor = slider.id;

  const update = (notify: boolean): void => {
    const index = Math.max(0, Math.min(levels.length - 1, Number(slider.value) || 0));
    current = levels[index];
    const triangles = info.perLodTris[current] ?? 0;
    const name = `LOD${current}`;
    const description = `${name}, ${formatTris(triangles)} triangles`;
    value.textContent = `${name} · ${formatTris(triangles)}`;
    slider.title = `Show only ${name} (${formatTris(triangles)} tris)`;
    slider.setAttribute('aria-valuetext', description);
    const progress = levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0;
    slider.style.setProperty('--lod-progress', `${progress}%`);
    if (notify) onChange(current);
  };

  slider.addEventListener('input', () => update(true));
  sliderHost.append(slider, value);
  update(false);
  return { selected: () => current };
}

export function hideLodSelector(host: HTMLElement, sliderHost: HTMLElement): void {
  host.hidden = true;
  sliderHost.innerHTML = '';
}
