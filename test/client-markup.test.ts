import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'client',
  'index.html',
);
const markup = readFileSync(sourcePath, 'utf8');

describe('shipped browser markup contract', () => {
  it('gives every button an explicit non-submit type', () => {
    const untyped = Array.from(markup.matchAll(/<button\b[^>]*>/gi), ([tag]) => tag).filter(
      (tag) => !/\btype\s*=\s*["']button["']/i.test(tag),
    );
    expect(untyped).toEqual([]);
  });

  it('declares both settings surfaces as modal dialogs with labels', () => {
    const dialogs = Array.from(markup.matchAll(/<[^>]+role="dialog"[^>]*>/gi), ([tag]) => tag);
    expect(dialogs).toHaveLength(2);
    expect(dialogs.every((tag) => /aria-modal="true"/i.test(tag))).toBe(true);
    expect(dialogs.every((tag) => /aria-labelledby="[^"]+"/i.test(tag))).toBe(true);
    expect(markup).toContain('aria-label="Close settings"');
    expect(markup).toContain('aria-label="Close profiles"');
  });

  it('declares reduced-motion behavior and avoids default viewer motion', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/client/styles.css'), 'utf8');
    const viewer = readFileSync(resolve(process.cwd(), 'src/client/ui/viewer.ts'), 'utf8');

    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('transition: none !important');
    expect(viewer).toContain("matchMedia?.('(prefers-reduced-motion: reduce)')");
    expect(viewer).toContain('let autoRotateEnabled = !reducedMotion');
  });

  it('exposes queue state changes through labeled live status and progress regions', () => {
    const queue = readFileSync(resolve(process.cwd(), 'src/client/ui/queue.ts'), 'utf8');

    expect(markup).toContain('id="queue-list" aria-label="Conversion queue"');
    expect(queue).toContain("prog.setAttribute('role', 'progressbar')");
    expect(queue).toContain("prog.setAttribute('aria-valuenow'");
    expect(queue).toContain("status.setAttribute('role', 'status')");
    expect(queue).toContain("status.setAttribute('aria-live', 'polite')");
    expect(markup).toContain('aria-label="Include all files in conversion"');
    expect(markup).toContain('aria-label="Choose 3D asset files"');
  });
});
