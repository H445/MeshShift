import { describe, expect, it } from 'vitest';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector3,
} from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectGltf, inspectScene, installNodeGltfLoaderPolyfills } from '../src/core/inspect.js';

describe('inspectScene', () => {
  it('reuses an embedded geometry bounding box without rescanning vertices', () => {
    const geometry = new BufferGeometry();
    const positions = new BufferAttribute(new Float32Array([-2, -3, -4, 5, -3, -4, 5, 7, 9]), 3);
    geometry.setAttribute('position', positions);
    geometry.boundingBox = new Box3(new Vector3(-2, -3, -4), new Vector3(5, 7, 9));

    // A fallback vertex scan would call these methods and fail the test.
    positions.getX = () => {
      throw new Error('unexpected vertex scan');
    };
    positions.getY = positions.getX;
    positions.getZ = positions.getX;

    const scene = new Scene();
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));

    const result = inspectScene(scene);

    expect(result.triangles).toBe(1);
    expect(result.vertices).toBe(3);
    expect(result.bboxMin).toEqual([-2, -3, -4]);
    expect(result.bboxMax).toEqual([5, 7, 9]);
    expect(result.bboxSize).toEqual([7, 10, 13]);
  });

  it('reports world-space bounds and every material on transformed multi-material meshes', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, 1]), 3),
    );
    geometry.boundingBox = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));

    const mesh = new Mesh(geometry, [new MeshBasicMaterial(), new MeshBasicMaterial()]);
    mesh.position.set(10, 20, 30);
    mesh.scale.set(2, 3, 4);
    const scene = new Scene();
    scene.add(mesh);

    const result = inspectScene(scene);

    expect(result.materials).toBe(2);
    expect(result.bboxMin).toEqual([8, 17, 26]);
    expect(result.bboxMax).toEqual([12, 23, 34]);
    expect(result.bboxSize).toEqual([4, 6, 8]);
  });

  it('counts morph target slots instead of reporting only their presence', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.morphAttributes.position = [
      new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1]), 3),
      new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 0]), 3),
    ];
    const scene = new Scene();
    scene.add(new Mesh(geometry, new MeshBasicMaterial()));

    const result = inspectScene(scene);

    expect(result.hasMorph).toBe(true);
    expect(result.morphTargets).toBe(2);
  });
});

describe('inspectGltf in Node', () => {
  it('loads a GLB with embedded textures without browser globals', async () => {
    // Consumers with their own GLTFLoader path may safely call the installer
    // explicitly, even after inspect.ts has initialized it once.
    installNodeGltfLoaderPolyfills();
    const data = new Uint8Array(
      readFileSync(resolve(process.cwd(), 'test', 'fixtures', 'item-bag.glb')),
    );

    const result = await inspectGltf(data);

    expect(result.meshes).toBeGreaterThan(0);
    expect(result.textures).toBeGreaterThan(0);
  });
});
