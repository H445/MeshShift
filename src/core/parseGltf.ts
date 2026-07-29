/**
 * GLTF parse for the **preview** pipeline (web UI only).
 * The actual conversion doesn't need this — assimpjs handles GLB input directly.
 *
 * Kept minimal: just enough to load the scene into three.js for the 3D viewer.
 * No DOM shim needed because the web UI always has a browser context.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ParseError } from './errors.js';

export interface ParsedGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export async function parseGltf(data: ArrayBuffer | Uint8Array): Promise<ParsedGltf> {
  const buffer =
    data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data;
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      buffer as ArrayBuffer,
      '',
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      (err) => reject(new ParseError(err?.message ?? 'GLTF parse error')),
    );
  });
}
