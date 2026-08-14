import { describe, expect, it } from 'vitest';
import { DESKTOP_CONTENT_SECURITY_POLICY } from '../src/desktop/contentSecurityPolicy.js';

function directive(name: string): string[] {
  const match = DESKTOP_CONTENT_SECURITY_POLICY.split('; ')
    .map((value) => value.trim().split(/\s+/))
    .find(([candidate]) => candidate === name);
  return match?.slice(1) ?? [];
}

describe('desktop content security policy', () => {
  it('allows Three.js to fetch embedded model textures for ImageBitmap decoding', () => {
    expect(directive('img-src')).toEqual(expect.arrayContaining(['data:', 'blob:']));
    expect(directive('connect-src')).toEqual(expect.arrayContaining(['data:', 'blob:']));
  });
});
