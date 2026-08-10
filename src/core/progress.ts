/**
 * Small progress helper. The `ConvertOptions.onProgress` callback receives
 * (phase, pct) where pct is 0..1. We just normalize and forward.
 */
import type { ConvertPhase, ConvertOptions } from '../shared/options.js';

/** Throw a stable, typed error when cooperative cancellation was requested. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  const message =
    reason instanceof Error && reason.message
      ? reason.message
      : typeof reason === 'string' && reason.length > 0
        ? reason
        : 'Operation was cancelled.';
  const error = new Error(message);
  error.name = 'AbortError';
  throw error;
}

export function makeProgress(opts: ConvertOptions | undefined) {
  const cb = opts?.onProgress;
  return (phase: ConvertPhase, pct: number) => {
    throwIfAborted(opts?.signal);
    if (!cb) return;
    const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : 0;
    try {
      cb(phase, clamped);
    } catch {
      // Never let a user-supplied progress callback throw us off the rails.
    }
  };
}
