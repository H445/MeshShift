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
import { inspectScene } from '../src/core/inspect.js';

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
});
