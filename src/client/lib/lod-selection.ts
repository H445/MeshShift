export function normalizeLodLevels(levels: number[]): number[] {
  return Array.from(
    new Set(
      levels
        .filter((level) => Number.isInteger(level) && level >= 0)
        .map((level) => Math.floor(level)),
    ),
  ).sort((a, b) => a - b);
}

export function lodLevelsThrough(maxLod: number): number[] {
  const maximum = Math.max(0, Math.min(8, Math.floor(maxLod) || 0));
  return Array.from({ length: maximum + 1 }, (_, level) => level);
}

export function sameLodLevels(left: number[], right: number[]): boolean {
  const normalizedLeft = normalizeLodLevels(left);
  const normalizedRight = normalizeLodLevels(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((level, index) => level === normalizedRight[index])
  );
}

/** Preserve existing choices and select newly available generated levels by default. */
export function reconcileLodLevels(
  previousAvailable: number[],
  previousSelected: number[],
  nextAvailable: number[],
): number[] {
  const oldAvailable = new Set(normalizeLodLevels(previousAvailable));
  const selected = new Set(normalizeLodLevels(previousSelected));
  const available = normalizeLodLevels(nextAvailable);
  return available.filter((level) => selected.has(level) || !oldAvailable.has(level));
}
