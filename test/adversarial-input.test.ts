import { describe, expect, it } from 'vitest';
import { convertAsset } from '../src/core/index.js';

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const malformedInputs: Array<[string, Uint8Array]> = [
  ['empty', bytes([])],
  ['truncated GLB header', bytes([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])],
  [
    'truncated GLB chunk',
    bytes([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 20, 0, 0, 0, 0x4e, 0x4f, 0x53, 0x4a]),
  ],
  ['invalid JSON document', new TextEncoder().encode('{"asset":{"version":"2.0"}')],
  ['non-model binary', bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])],
];

describe('adversarial input boundaries', () => {
  it.each(malformedInputs)('rejects %s without producing output', async (_label, input) => {
    await expect(
      convertAsset(input, { name: 'malformed.glb', outputFormat: 'fbx' }),
    ).rejects.toThrow();
  });

  it('rejects unsafe names before invoking the parser', async () => {
    await expect(
      convertAsset({ name: 'folder/../model.glb', data: bytes([1]) }, { outputFormat: 'glb' }),
    ).rejects.toThrow('safe relative path');
    await expect(
      convertAsset(
        { name: 'https://example.invalid/model.glb', data: bytes([1]) },
        {
          outputFormat: 'glb',
        },
      ),
    ).rejects.toThrow('safe relative path');
  });

  it('rejects non-finite and overflowing resource options at the public boundary', async () => {
    await expect(
      convertAsset(bytes([1]), { outputFormat: 'glb', maxTriangles: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow('maxTriangles must be an integer');
    await expect(
      convertAsset(bytes([1]), { outputFormat: 'glb', maxTextureSize: 1.5 }),
    ).rejects.toThrow('maxTextureSize must be an integer');
  });
});
