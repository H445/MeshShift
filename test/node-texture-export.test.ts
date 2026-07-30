import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectGltf } from '../src/core/inspect.js';
import { optimizeGltf } from '../src/core/optimize.js';

interface GlbImage {
  bufferView?: number;
  mimeType?: string;
}

interface GlbBufferView {
  byteOffset?: number;
  byteLength: number;
}

interface GlbDocument {
  images?: GlbImage[];
  bufferViews?: GlbBufferView[];
}

function embeddedImageDigests(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Expected a GLB asset.');

  let document: GlbDocument | undefined;
  let binary: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunk = data.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) {
      document = JSON.parse(new TextDecoder().decode(chunk)) as GlbDocument;
    } else if (chunkType === 0x004e4942) {
      binary = chunk;
    }
    offset += 8 + chunkLength;
  }

  if (!document || !binary) throw new Error('GLB is missing its JSON or binary chunk.');
  return (document.images ?? [])
    .map((image) => {
      if (image.bufferView === undefined) throw new Error('Expected an embedded GLB image.');
      const bufferView = document!.bufferViews?.[image.bufferView];
      if (!bufferView) throw new Error('Embedded image references a missing buffer view.');
      const start = bufferView.byteOffset ?? 0;
      const bytes = binary!.subarray(start, start + bufferView.byteLength);
      return `${image.mimeType ?? ''}:${createHash('sha256').update(bytes).digest('hex')}`;
    })
    .sort();
}

describe('textured GLB optimization in Node', () => {
  it('exports embedded textures without decoding or changing their encoded bytes', async () => {
    const source = new Uint8Array(
      readFileSync(resolve(process.cwd(), 'test', 'fixtures', 'item-bag.glb')),
    );
    const sourceImages = embeddedImageDigests(source);

    const result = await optimizeGltf(source, {
      generateLODs: 1,
      maxTextureSize: 8192,
    });

    expect(result.changes.some((change) => change.kind === 'lod')).toBe(true);
    expect(result.stats.textures).toBe(sourceImages.length);
    expect(embeddedImageDigests(result.data)).toEqual(sourceImages);
    const reparsed = await inspectGltf(result.data);
    expect(reparsed.textures).toBe(sourceImages.length);
    expect(reparsed.textureMaxSize).toBeGreaterThan(0);
  }, 30_000);
});
