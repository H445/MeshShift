/**
 * Small progress helper. The `ConvertOptions.onProgress` callback receives
 * (phase, pct) where pct is 0..1. We just normalize and forward.
 */
import type { ConvertPhase, ConvertOptions } from '../shared/options.js';

export function makeProgress(opts: ConvertOptions | undefined) {
  const cb = opts?.onProgress;
  return (phase: ConvertPhase, pct: number) => {
    if (!cb) return;
    const clamped = Math.max(0, Math.min(1, pct));
    try {
      cb(phase, clamped);
    } catch {
      // Never let a user-supplied progress callback throw us off the rails.
    }
  };
}
