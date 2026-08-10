import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  BufferAttribute,
  BufferGeometry,
  IcosahedronGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  SphereGeometry,
} from 'three';
import {
  edgeCollapseDecimate,
  generateLodGeometries,
  meshoptDecimate,
  optimizeGltf,
  restoreCriticalVertices,
} from '../src/core/optimize.js';
import { inspectGltf } from '../src/core/inspect.js';
import { inspectGlbLodCatalog } from '../src/core/lodSelection.js';
import { textureFilterRadius, unwrapLodGeometry } from '../src/core/lod-texture-baker.js';

interface TopologyStats {
  boundaryEdges: number;
  nonManifoldEdges: number;
  inwardFaces: number;
}

function topologyStats(geometry: BufferGeometry): TopologyStats {
  if (!geometry.index) throw new Error('expected indexed geometry');
  const index = geometry.index.array;
  const position = geometry.attributes.position;
  const edgeUse = new Map<string, number>();
  let inwardFaces = 0;

  for (let i = 0; i < index.length; i += 3) {
    const ids = [index[i], index[i + 1], index[i + 2]];
    for (const [a, b] of [
      [ids[0], ids[1]],
      [ids[1], ids[2]],
      [ids[2], ids[0]],
    ]) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }

    const ax = position.getX(ids[0]);
    const ay = position.getY(ids[0]);
    const az = position.getZ(ids[0]);
    const bx = position.getX(ids[1]);
    const by = position.getY(ids[1]);
    const bz = position.getZ(ids[1]);
    const cx = position.getX(ids[2]);
    const cy = position.getY(ids[2]);
    const cz = position.getZ(ids[2]);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const centerX = (ax + bx + cx) / 3;
    const centerY = (ay + by + cy) / 3;
    const centerZ = (az + bz + cz) / 3;
    if (nx * centerX + ny * centerY + nz * centerZ <= 0) inwardFaces++;
  }

  const uses = [...edgeUse.values()];
  return {
    boundaryEdges: uses.filter((count) => count === 1).length,
    nonManifoldEdges: uses.filter((count) => count > 2).length,
    inwardFaces,
  };
}

describe('topology-safe LOD decimation', () => {
  it('stops optimization at a cooperative phase boundary after cancellation', async () => {
    const controller = new AbortController();
    await expect(
      optimizeGltf(
        new Uint8Array(readFileSync(resolve(process.cwd(), 'test/fixtures/sphere.glb'))),
        {
          generateLODs: 2,
          maxTextureSize: 8192,
          signal: controller.signal,
          onProgress: (phase) => {
            if (phase === 'optimize') controller.abort('optimization cancelled');
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'optimization cancelled' });
  });

  it('keeps generated LOD levels separate when merging by material', async () => {
    const document = new Document();
    document.createBuffer();
    const positions = document
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const indices = document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2]));
    const material = document.createMaterial('shared');
    const scene = document.createScene('Scene');
    for (const name of ['left', 'right']) {
      const primitive = document
        .createPrimitive()
        .setAttribute('POSITION', positions)
        .setIndices(indices)
        .setMaterial(material);
      const mesh = document.createMesh(name).addPrimitive(primitive);
      scene.addChild(document.createNode(name).setMesh(mesh));
    }

    const source = await new NodeIO().writeBinary(document);
    const optimized = await optimizeGltf(source, {
      generateLODs: 1,
      mergeByMaterial: true,
      maxTextureSize: 8192,
    });
    const catalog = inspectGlbLodCatalog({ name: 'merged.glb', data: optimized.data });

    expect(catalog.availableLods).toEqual([0, 1]);
    expect(catalog.levels.map((level) => level.meshes)).toEqual([1, 1]);
    expect(optimized.changes.filter((change) => change.kind === 'merge')).toHaveLength(2);
  });

  it('preserves animations through an optimization export', async () => {
    const document = new Document();
    document.createBuffer();
    const positions = document
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const indices = document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2]));
    const mesh = document
      .createMesh('animated')
      .addPrimitive(
        document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices),
      );
    const node = document.createNode('animated').setMesh(mesh);
    document.createScene('Scene').addChild(node);
    const sampler = document
      .createAnimationSampler()
      .setInput(
        document
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Float32Array([0, 1])),
      )
      .setOutput(
        document
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0])),
      );
    const channel = document
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(node)
      .setTargetPath('translation');
    document.createAnimation('Move').addSampler(sampler).addChannel(channel);
    const source = await new NodeIO().writeBinary(document);
    const optimized = await optimizeGltf(source, {
      generateLODs: 1,
      maxTextureSize: 8192,
    });

    expect((await inspectGltf(optimized.data)).animations).toBe(1);
  });

  it('adds bounded source-footprint filtering only when an LOD atlas downsamples a texture', () => {
    expect(textureFilterRadius(1024, 1024, 1024, 1024)).toBe(0);
    expect(textureFilterRadius(2048, 2048, 1024, 1024)).toBe(0.5);
    expect(textureFilterRadius(4096, 2048, 512, 512)).toBe(3.5);
    expect(textureFilterRadius(16384, 16384, 256, 256)).toBe(4);
  });

  it('does not widen boundaries or turn faces inside-out at aggressive targets', () => {
    const source = new SphereGeometry(1, 32, 20);
    const beforeTriangles = source.index!.count / 3;
    const before = topologyStats(source);
    const result = edgeCollapseDecimate(source, 50);

    expect(result).not.toBeNull();
    expect(result!.triangleCount).toBeLessThan(beforeTriangles);
    // Safety takes priority over hitting a destructive target exactly.
    expect(result!.triangleCount).toBeGreaterThanOrEqual(50);

    const after = topologyStats(result!.geometry);
    expect(after.boundaryEdges).toBeLessThanOrEqual(before.boundaryEdges);
    expect(after.nonManifoldEdges).toBe(0);
    expect(after.inwardFaces).toBe(0);
  });

  it('emits every requested level for a small mesh, including safe plateaus', async () => {
    const source = new SphereGeometry(1, 4, 2);
    const sourceTriangles = source.index!.count / 3;
    const levels = await generateLodGeometries(source, 4);

    expect(levels.map((level) => level.level)).toEqual([1, 2, 3, 4]);
    expect(levels.every((level) => level.triangleCount <= sourceTriangles)).toBe(true);
    expect(levels.some((level) => level.safePlateau)).toBe(true);
  });

  it('preserves interleaved position, normal, and UV attributes in compact LODs', async () => {
    const regular = new SphereGeometry(1, 16, 8);
    const position = regular.attributes.position;
    const normal = regular.attributes.normal;
    const uv = regular.attributes.uv;
    const values = new Float32Array(position.count * 8);
    for (let vertex = 0; vertex < position.count; vertex++) {
      const offset = vertex * 8;
      values[offset] = position.getX(vertex);
      values[offset + 1] = position.getY(vertex);
      values[offset + 2] = position.getZ(vertex);
      values[offset + 3] = normal.getX(vertex);
      values[offset + 4] = normal.getY(vertex);
      values[offset + 5] = normal.getZ(vertex);
      values[offset + 6] = uv.getX(vertex);
      values[offset + 7] = uv.getY(vertex);
    }

    const interleaved = new InterleavedBuffer(values, 8);
    const source = new BufferGeometry();
    source.setAttribute('position', new InterleavedBufferAttribute(interleaved, 3, 0));
    source.setAttribute('normal', new InterleavedBufferAttribute(interleaved, 3, 3));
    source.setAttribute('uv', new InterleavedBufferAttribute(interleaved, 2, 6));
    source.setIndex(regular.index!.clone());

    const levels = await generateLodGeometries(source, 2, [100, 50]);
    expect(levels).toHaveLength(2);
    for (const level of levels) {
      expect(level.geometry.attributes.position).toBeDefined();
      expect(level.geometry.attributes.normal).toBeDefined();
      expect(level.geometry.attributes.uv).toBeDefined();
      expect(level.geometry.attributes.position.count).toBeGreaterThan(0);
      expect(level.geometry.attributes.normal.count).toBe(level.geometry.attributes.position.count);
      expect(level.geometry.attributes.uv.count).toBe(level.geometry.attributes.position.count);
      expect('data' in level.geometry.attributes.position).toBe(false);
    }
  });

  it('keeps a pinned LOD1 vertex in every deeper generated level', async () => {
    const source = new SphereGeometry(1, 16, 8);
    const baseline = await generateLodGeometries(source, 1, [100]);
    const baselinePosition = baseline[0].geometry.attributes.position;
    const pin: [number, number, number] = [
      baselinePosition.getX(0),
      baselinePosition.getY(0),
      baselinePosition.getZ(0),
    ];
    baseline[0].geometry.dispose();

    const levels = await generateLodGeometries(source, 4, [100, 50, 24, 12], undefined, [
      { lodLevel: 1, position: pin },
    ]);
    for (const level of levels) {
      const position = level.geometry.attributes.position;
      const containsPin = Array.from({ length: position.count }, (_, vertex) => vertex).some(
        (vertex) =>
          Math.abs(position.getX(vertex) - pin[0]) < 1e-7 &&
          Math.abs(position.getY(vertex) - pin[1]) < 1e-7 &&
          Math.abs(position.getZ(vertex) - pin[2]) < 1e-7,
      );
      expect(containsPin, `LOD${level.level} should retain the pinned point`).toBe(true);
      level.geometry.dispose();
    }
  });

  it('reduces a low-poly closed mesh all the way to a four-triangle target', () => {
    const source = new IcosahedronGeometry(1, 1);
    const result = edgeCollapseDecimate(source, 4);

    expect(result).not.toBeNull();
    expect(result!.triangleCount).toBe(4);
    expect(topologyStats(result!.geometry).nonManifoldEdges).toBe(0);
    expect(topologyStats(result!.geometry).inwardFaces).toBe(0);
  });

  it('restores a collapsed critical peak by subdividing one face without topology damage', () => {
    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, 0, 1]), 3),
    );
    source.setIndex([0, 1, 3, 1, 2, 3, 2, 0, 3]);

    const collapsed = new BufferGeometry();
    collapsed.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3),
    );
    collapsed.setIndex([0, 1, 2]);

    const before = topologyStats(collapsed);
    const result = restoreCriticalVertices(source, collapsed, 100);

    expect(result).not.toBeNull();
    expect(result!.restoredVertices).toBe(1);
    expect(result!.triangleCount).toBe(3);
    const restoredPosition = result!.geometry.attributes.position;
    expect(
      Array.from({ length: restoredPosition.count }, (_, vertex) => [
        restoredPosition.getX(vertex),
        restoredPosition.getY(vertex),
        restoredPosition.getZ(vertex),
      ]),
    ).toContainEqual([0, 0, 1]);
    const after = topologyStats(result!.geometry);
    expect(after.boundaryEdges).toBe(before.boundaryEdges);
    expect(after.nonManifoldEdges).toBe(0);
  });

  it('restores a silhouette anchor by splitting both faces of a manifold edge', () => {
    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1, 0, 0, -1]), 3),
    );
    source.setIndex([0, 4, 2, 4, 1, 2, 1, 4, 3, 4, 0, 3, 0, 2, 3, 1, 3, 2]);

    const collapsed = new BufferGeometry();
    collapsed.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1]), 3),
    );
    collapsed.setIndex([0, 1, 2, 1, 0, 3, 0, 2, 3, 1, 3, 2]);

    const result = restoreCriticalVertices(source, collapsed, 100);

    expect(result).not.toBeNull();
    expect(result!.restoredVertices).toBe(1);
    expect(result!.triangleCount).toBe(6);
    expect(topologyStats(result!.geometry).boundaryEdges).toBe(0);
    expect(topologyStats(result!.geometry).nonManifoldEdges).toBe(0);
  });

  it('interpolates a restored UV when every source duplicate is on another atlas island', () => {
    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 0.7, 0.7, 1, 0.7, 0.7, 1]),
        3,
      ),
    );
    source.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 1]), 2),
    );
    source.setIndex([0, 1, 3, 1, 2, 3, 2, 0, 3]);

    const collapsed = new BufferGeometry();
    collapsed.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), 3),
    );
    collapsed.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    collapsed.setIndex([0, 1, 2]);

    const result = restoreCriticalVertices(source, collapsed, 100);
    expect(result).not.toBeNull();
    expect(result!.restoredVertices).toBe(1);
    const uv = result!.geometry.attributes.uv;
    const restored = uv.count - 1;
    // The source duplicates are (0,0) and (1,1), so copying either one would
    // jump to a different island. The safe value is the face interpolation.
    expect(uv.getX(restored)).toBeCloseTo(0.35, 5);
    expect(uv.getY(restored)).toBeCloseTo(0.35, 5);
  });

  it('rejects a distant edge anchor that would create a paper-thin fin', () => {
    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1, 0, 0, -8]), 3),
    );
    source.setIndex([0, 4, 2, 4, 1, 2, 1, 4, 3, 4, 0, 3, 0, 2, 3, 1, 3, 2]);

    const collapsed = new BufferGeometry();
    collapsed.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1]), 3),
    );
    collapsed.setIndex([0, 1, 2, 1, 0, 3, 0, 2, 3, 1, 3, 2]);

    expect(restoreCriticalVertices(source, collapsed, 100)).toBeNull();
  });

  it('bounds critical-vertex repair work for scan-sized meshes', () => {
    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3),
    );
    const sourceIndices = new Uint32Array(250_001 * 3);
    for (let i = 0; i < sourceIndices.length; i += 3) {
      sourceIndices[i] = 0;
      sourceIndices[i + 1] = 1;
      sourceIndices[i + 2] = 2;
    }
    source.setIndex(new BufferAttribute(sourceIndices, 1));

    const simplified = new BufferGeometry();
    simplified.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3),
    );
    simplified.setIndex([0, 1, 2]);

    // The large-mesh guard must return before building the source-point map;
    // this mirrors the million-triangle browser case without allocating a
    // million unique vertices in the test fixture.
    expect(restoreCriticalVertices(source, simplified, 100)).toBeNull();
  });

  it('creates smooth projection normals without mutating a source that omits them', async () => {
    const source = new SphereGeometry(1, 16, 8);
    source.deleteAttribute('normal');

    const atlas = await unwrapLodGeometry(source, 256);

    expect(source.attributes.normal).toBeUndefined();
    expect(atlas).not.toBeNull();
    expect(atlas!.geometry.attributes.normal).toBeDefined();
    expect(atlas!.geometry.attributes.normal.count).toBe(atlas!.geometry.attributes.position.count);
    atlas!.geometry.dispose();
  });

  it('continues reducing the item-bag asset after LOD1', async () => {
    const path = resolve(process.cwd(), 'test', 'fixtures', 'item-bag.glb');
    const doc = await new NodeIO().readBinary(new Uint8Array(readFileSync(path)));
    const primitive = doc.getRoot().listMeshes()[0]?.listPrimitives()[0];
    const positions = primitive?.getAttribute('POSITION');
    const indices = primitive?.getIndices();
    const texcoords = primitive?.getAttribute('TEXCOORD_0');
    if (!positions || !indices || !texcoords)
      throw new Error('item-bag fixture has no indexed POSITION primitive');

    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(positions.getArray(), positions.getElementSize()),
    );
    source.setAttribute(
      'uv',
      new BufferAttribute(texcoords.getArray(), texcoords.getElementSize()),
    );
    source.setIndex(new BufferAttribute(indices.getArray(), 1));

    // The same repair must run when callers request a one-off triangle cap,
    // not only when the LOD generator happens to invoke the simplifier.
    const direct = await meshoptDecimate(source, 750);
    expect(direct).not.toBeNull();
    expect(direct!.restoredVertices).toBeGreaterThan(0);
    expect(topologyStats(direct!.geometry).nonManifoldEdges).toBe(0);
    direct!.geometry.dispose();

    const levels = await generateLodGeometries(source, 4);
    expect(levels.map((level) => level.triangleCount)).toEqual([1500, 940, 666, 442]);
    expect(levels.map((level) => level.restoredVertices)).toEqual([0, 20, 33, 41]);
    expect(levels.every((level) => level.safePlateau === false)).toBe(true);
    for (const level of levels) {
      expect(topologyStats(level.geometry).nonManifoldEdges).toBe(0);
      const uv = level.geometry.attributes.uv;
      expect(uv).toBeDefined();
      expect(uv.count).toBeLessThanOrEqual(source.attributes.uv.count);
      for (let i = 0; i < uv.count * uv.itemSize; i++) {
        expect(Number.isFinite(uv.array[i])).toBe(true);
      }
    }
  }, 30000);

  it('continues reducing the potion asset through every requested LOD', async () => {
    const path = resolve(process.cwd(), 'test', 'fixtures', 'potion.glb');
    const doc = await new NodeIO().readBinary(new Uint8Array(readFileSync(path)));
    const primitive = doc.getRoot().listMeshes()[0]?.listPrimitives()[0];
    const positions = primitive?.getAttribute('POSITION');
    const normals = primitive?.getAttribute('NORMAL');
    const indices = primitive?.getIndices();
    const texcoords = primitive?.getAttribute('TEXCOORD_0');
    if (!positions || !indices || !texcoords) {
      throw new Error('potion fixture has no indexed POSITION/UV primitive');
    }

    expect(normals).toBeNull();
    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(positions.getArray(), positions.getElementSize()),
    );
    source.setAttribute(
      'uv',
      new BufferAttribute(texcoords.getArray(), texcoords.getElementSize()),
    );
    source.setIndex(new BufferAttribute(indices.getArray(), 1));

    const levels = await generateLodGeometries(source, 4);
    expect(levels.map((level) => level.triangleCount)).toEqual([1500, 948, 666, 440]);
    expect(levels.map((level) => level.restoredVertices)).toEqual([0, 24, 33, 41]);
    expect(levels[3].restoredVertices).toBeGreaterThanOrEqual(40);
    expect(levels.every((level) => level.safePlateau === false)).toBe(true);
    expect(levels.every((level) => topologyStats(level.geometry).nonManifoldEdges === 0)).toBe(
      true,
    );

    const atlas = await unwrapLodGeometry(levels[3].geometry, 512);
    expect(atlas).not.toBeNull();
    expect(atlas!.geometry.attributes.normal).toBeDefined();
    atlas!.geometry.dispose();
  }, 30000);

  it('builds a unique, non-degenerate bake atlas for the deepest item-bag LOD', async () => {
    const path = resolve(process.cwd(), 'test', 'fixtures', 'item-bag.glb');
    const doc = await new NodeIO().readBinary(new Uint8Array(readFileSync(path)));
    const primitive = doc.getRoot().listMeshes()[0]?.listPrimitives()[0];
    const positions = primitive?.getAttribute('POSITION');
    const normals = primitive?.getAttribute('NORMAL');
    const indices = primitive?.getIndices();
    const texcoords = primitive?.getAttribute('TEXCOORD_0');
    if (!positions || !indices || !texcoords) {
      throw new Error('item-bag fixture has no indexed POSITION/UV primitive');
    }

    const source = new BufferGeometry();
    source.setAttribute(
      'position',
      new BufferAttribute(positions.getArray(), positions.getElementSize()),
    );
    if (normals) {
      source.setAttribute(
        'normal',
        new BufferAttribute(normals.getArray(), normals.getElementSize()),
      );
    }
    source.setAttribute(
      'uv',
      new BufferAttribute(texcoords.getArray(), texcoords.getElementSize()),
    );
    source.setIndex(new BufferAttribute(indices.getArray(), 1));

    const lod4 = (await generateLodGeometries(source, 4))[3];
    const atlas = await unwrapLodGeometry(lod4.geometry, 512);
    expect(atlas).not.toBeNull();
    expect(atlas!.geometry.index!.count).toBe(lod4.geometry.index!.count);
    expect(atlas!.geometry.attributes.uv.count).toBe(atlas!.geometry.attributes.position.count);
    expect(atlas!.width).toBeGreaterThan(0);
    expect(atlas!.height).toBeGreaterThan(0);

    const uv = atlas!.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }
    const atlasIndices = atlas!.geometry.index!;
    for (let i = 0; i < atlasIndices.count; i += 3) {
      const a = atlasIndices.getX(i);
      const b = atlasIndices.getX(i + 1);
      const c = atlasIndices.getX(i + 2);
      const twiceArea =
        (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) -
        (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
      expect(Math.abs(twiceArea)).toBeGreaterThan(1e-10);
    }
  }, 30000);
});
