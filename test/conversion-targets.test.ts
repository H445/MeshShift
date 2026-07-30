import { describe, expect, it } from 'vitest';
import {
  selectConversionTargets,
  type ConversionTargetCandidate,
} from '../src/client/lib/conversion-targets.js';

function row(
  id: string,
  status: ConversionTargetCandidate['status'],
  selected = true,
): ConversionTargetCandidate {
  return { id, status, selected };
}

describe('selectConversionTargets', () => {
  it('selects only checked, unfinished rows for a batch', () => {
    const rows = [
      row('queued', 'queued'),
      row('retry', 'error'),
      row('unchecked', 'queued', false),
      row('done', 'done'),
      row('working', 'converting'),
    ];

    expect(selectConversionTargets(rows).map(({ id }) => id)).toEqual(['queued', 'retry']);
  });

  it('selects only the requested row regardless of its batch checkbox', () => {
    const rows = [row('first', 'queued'), row('target', 'queued', false), row('third', 'error')];

    expect(selectConversionTargets(rows, 'target')).toEqual([rows[1]]);
  });

  it('allows a completed row to be converted again', () => {
    const completed = row('completed', 'done', false);

    expect(selectConversionTargets([completed], completed.id)).toEqual([completed]);
  });

  it('does not select missing or already-converting direct requests', () => {
    const working = row('working', 'converting');

    expect(selectConversionTargets([working], working.id)).toEqual([]);
    expect(selectConversionTargets([working], 'missing')).toEqual([]);
  });

  it('does not mutate rows or their selection state', () => {
    const rows = [row('unchecked', 'error', false), row('done', 'done')];
    const before = structuredClone(rows);

    selectConversionTargets(rows);
    selectConversionTargets(rows, 'unchecked');

    expect(rows).toEqual(before);
  });
});
