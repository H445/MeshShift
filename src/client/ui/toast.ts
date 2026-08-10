/**
 * Non-blocking notifications. Toasts are mounted in the shared host so both
 * short messages and long-running task progress use the same UI surface.
 */
export type ToastKind = 'ok' | 'err' | 'warn' | 'info';

const HOST_ID = 'toast-host';
const FADE_MS = 220;

export interface ProgressToast {
  /** Update the 0..1 progress value and the optional status detail. */
  update(progress: number, detail?: string): void;
  /** Mark the task successful and let the toast fade away. */
  complete(detail?: string, durationMs?: number): void;
  /** Mark the task failed and keep the error visible briefly. */
  fail(detail: string, durationMs?: number): void;
  /** Remove the toast immediately. */
  dismiss(): void;
}

const EMPTY_PROGRESS_TOAST: ProgressToast = {
  update: () => undefined,
  complete: () => undefined,
  fail: () => undefined,
  dismiss: () => undefined,
};

function removeWithFade(el: HTMLElement, transform = 'translateY(20px)'): void {
  el.style.transition = `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`;
  el.style.opacity = '0';
  el.style.transform = transform;
  window.setTimeout(() => el.remove(), FADE_MS);
}

export function toast(message: string, kind: ToastKind = 'info', durationMs = 4000): void {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => removeWithFade(el), Math.max(0, durationMs));
}

/**
 * Create a persistent toast for a long-running operation. The returned
 * controller is intentionally DOM-free so callers can safely update it from
 * async work without needing to know how the notification is rendered.
 */
export function progressToast(title: string, initialProgress = 0): ProgressToast {
  const host = document.getElementById(HOST_ID);
  if (!host) return EMPTY_PROGRESS_TOAST;

  const el = document.createElement('div');
  el.className = 'toast info toast-progress';
  el.setAttribute('role', 'status');

  const titleEl = document.createElement('div');
  titleEl.className = 'toast-title';
  titleEl.textContent = title;
  el.appendChild(titleEl);

  const detailEl = document.createElement('div');
  detailEl.className = 'toast-detail';
  el.appendChild(detailEl);

  const track = document.createElement('div');
  track.className = 'toast-progress-track';
  const bar = document.createElement('div');
  bar.className = 'toast-progress-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', title);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  track.appendChild(bar);
  el.appendChild(track);
  host.appendChild(el);

  let removed = false;
  let removalTimer: number | undefined;

  const update = (progress: number, detail?: string): void => {
    if (removed) return;
    const value = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    bar.style.width = `${value * 100}%`;
    bar.setAttribute('aria-valuenow', `${Math.round(value * 100)}`);
    if (detail !== undefined) detailEl.textContent = detail;
  };

  const scheduleRemoval = (durationMs: number): void => {
    if (removalTimer !== undefined) window.clearTimeout(removalTimer);
    removalTimer = window.setTimeout(
      () => {
        if (removed) return;
        removed = true;
        removeWithFade(el);
      },
      Math.max(0, durationMs),
    );
  };

  const controller: ProgressToast = {
    update,
    complete(detail = 'Complete', durationMs = 2200) {
      if (removed) return;
      el.classList.remove('info', 'warn', 'err');
      el.classList.add('ok');
      update(1, detail);
      scheduleRemoval(durationMs);
    },
    fail(detail, durationMs = 6000) {
      if (removed) return;
      el.classList.remove('info', 'warn', 'ok');
      el.classList.add('err');
      detailEl.textContent = detail;
      scheduleRemoval(durationMs);
    },
    dismiss() {
      if (removed) return;
      if (removalTimer !== undefined) window.clearTimeout(removalTimer);
      removed = true;
      removeWithFade(el);
    },
  };

  update(initialProgress);
  return controller;
}
