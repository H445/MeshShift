export type ConversionTargetStatus = 'queued' | 'converting' | 'done' | 'error';

export interface ConversionTargetCandidate {
  id: string;
  selected: boolean;
  status: ConversionTargetStatus;
}

/**
 * Resolves the rows for a conversion request.
 *
 * Batch conversion keeps the existing queue semantics: only checked rows that
 * have not completed are included. A direct row request intentionally ignores
 * the batch checkbox and may rerun a completed row, but never joins work that
 * is already converting.
 */
export function selectConversionTargets<T extends ConversionTargetCandidate>(
  rows: readonly T[],
  requestedId?: string,
): T[] {
  if (requestedId !== undefined) {
    return rows.filter((row) => row.id === requestedId && row.status !== 'converting');
  }

  return rows.filter((row) => row.selected && row.status !== 'done' && row.status !== 'converting');
}
