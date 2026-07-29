#!/usr/bin/env node
/**
 * Generate small synthetic GLB fixtures for tests.
 * Run with: pnpm make-fixtures
 */
import { NodeIO } from '@gltf-transform/core';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '..', 'test', 'fixtures');

async function makeCube() {
  const io = new NodeIO();
  const doc = new (await import('@gltf-transform/core')).Document();
  doc.createBuffer();
  const positions = new Float32Array([
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
    -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  ]);
  const normals = new Float32Array([
    0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,
    0, 0,  1,  0, 0,  1,  0, 0,  1,  0, 0,  1,
  ]);
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  const mesh = doc.createMesh('cube')
    .addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setArray(positions).setType('VEC3'))
      .setAttribute('NORMAL', doc.createAccessor().setArray(normals).setType('VEC3'))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setArray(uvs).setType('VEC2'))
      .setIndices(doc.createAccessor().setArray(indices).setType('SCALAR')));
  doc.createNode('Cube').setMesh(mesh);
  doc.createScene('Scene').addChild(doc.getRoot().listNodes()[0]);
  const glb = await io.writeBinary(doc);
  return glb;
}

async function makeAnimatedCube() {
  // Same cube + a simple rotation animation
  const io = new NodeIO();
  const Document = (await import('@gltf-transform/core')).Document;
  const doc = new Document();
  doc.createBuffer();
  const positions = new Float32Array([
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
    -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  ]);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3,  4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,  1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,  3, 7, 4, 3, 4, 0,
  ]);
  const mesh = doc.createMesh('cube')
    .addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setArray(positions).setType('VEC3'))
      .setAttribute('NORMAL', doc.createAccessor().setArray(normals).setType('VEC3'))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setArray(uvs).setType('VEC2'))
      .setIndices(doc.createAccessor().setArray(indices).setType('SCALAR')));
  const node = doc.createNode('Cube').setMesh(mesh);
  doc.createScene('Scene').addChild(node);

  // Rotation animation
  const times = new Float32Array([0, 1, 2]);
  const rot = new Float32Array([
    0, 0, 0, 1,
    0, 0.707, 0, 0.707,
    0, 1, 0, 0,
  ]);
  const input = doc.createAccessor().setArray(times).setType('SCALAR');
  const output = doc.createAccessor().setArray(rot).setType('VEC4');
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel()
    .setSampler(sampler)
    .setTargetNode(node)
    .setTargetPath('rotation');
  doc.createAnimation('Rotate').addSampler(sampler).addChannel(channel);

  return io.writeBinary(doc);
}

async function makeSkinnedCube() {
  // Two-bone "stick figure" — simpler version using @gltf-transform's NodeIO with a pre-built glTF JSON.
  // We use the NodeIO with embedded JSON to avoid API mismatches in the higher-level Skin API.
  const io = new NodeIO();

  // Build a minimal glTF 2.0 JSON with skin
  const gltf = {
    asset: { version: '2.0', generator: 'gltf-to-fbx test fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'root', mesh: 0, skin: 0, children: [1] },
      { name: 'tip', translation: [0, 1, 0] },
    ],
    meshes: [{
      name: 'skinned',
      primitives: [{
        attributes: {
          POSITION: 0,
          NORMAL: 1,
          JOINTS_0: 2,
          WEIGHTS_0: 3,
        },
        indices: 4,
      }],
    }],
    skins: [{
      name: 'skin',
      joints: [0, 1],
      inverseBindMatrices: 5,
    }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 * 3 * 4, target: 34962 }, // positions
      { buffer: 0, byteOffset: 96, byteLength: 8 * 3 * 4, target: 34962 }, // normals
      { buffer: 0, byteOffset: 192, byteLength: 8 * 4, target: 34962 },    // joints
      { buffer: 0, byteOffset: 224, byteLength: 8 * 4 * 4, target: 34962 },// weights
      { buffer: 0, byteOffset: 352, byteLength: 36 * 2, target: 34963 },   // indices
      { buffer: 0, byteOffset: 424, byteLength: 2 * 16 * 4 },              // inverseBind
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', max: [0.5, 0.5, 0.5], min: [-0.5, -0.5, -0.5] },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, count: 8, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 8, type: 'VEC4' },
      { bufferView: 4, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 5, componentType: 5126, count: 2, type: 'MAT4' },
    ],
    buffers: [{ byteLength: 552 }],
  };

  // Build the binary blob
  const positions = new Float32Array([
    -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
    -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  ]);
  const normals = new Float32Array(8 * 3); // zeros
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const weights = new Float32Array([
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3,  4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,  1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,  3, 7, 4, 3, 4, 0,
  ]);
  const invBind = new Float32Array([
    1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1,
    1, 0, 0, 0,  0, 1, 0, -1, 0, 0, 1, 0,  0, 0, 0, 1,
  ]);

  const total = positions.byteLength + normals.byteLength + joints.byteLength + weights.byteLength + indices.byteLength + invBind.byteLength;
  const bin = new Uint8Array(total);
  const dv = new DataView(bin.buffer);
  let off = 0;
  bin.set(new Uint8Array(positions.buffer), off); off += positions.byteLength;
  bin.set(new Uint8Array(normals.buffer), off); off += normals.byteLength;
  bin.set(joints, off); off += joints.byteLength;
  bin.set(new Uint8Array(weights.buffer), off); off += weights.byteLength;
  bin.set(new Uint8Array(indices.buffer), off); off += indices.byteLength;
  bin.set(new Uint8Array(invBind.buffer), off); off += invBind.byteLength;
  // Update buffer length
  gltf.buffers[0].byteLength = bin.byteLength;
  // Update bufferView byteLength
  gltf.bufferViews[0].byteLength = positions.byteLength;
  gltf.bufferViews[1].byteLength = normals.byteLength;
  gltf.bufferViews[2].byteLength = joints.byteLength;
  gltf.bufferViews[3].byteLength = weights.byteLength;
  gltf.bufferViews[4].byteLength = indices.byteLength;
  gltf.bufferViews[5].byteLength = invBind.byteLength;

  // Write as GLB
  const jsonStr = JSON.stringify(gltf);
  // Pad JSON to 4-byte alignment with spaces
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadLen = (4 - (jsonBytes.length % 4)) % 4;
  const jsonPadded = new Uint8Array(jsonBytes.length + jsonPadLen);
  jsonPadded.set(jsonBytes);
  for (let i = jsonBytes.length; i < jsonPadded.length; i++) jsonPadded[i] = 0x20;
  const binPadLen = (4 - (bin.byteLength % 4)) % 4;
  const binPadded = new Uint8Array(bin.byteLength + binPadLen);
  binPadded.set(bin);

  const totalLen = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const glb = new Uint8Array(totalLen);
  const glbDV = new DataView(glb.buffer);
  // GLB header
  glbDV.setUint32(0, 0x46546c67, true); // 'glTF'
  glbDV.setUint32(4, 2, true);          // version
  glbDV.setUint32(8, totalLen, true);   // total length
  // JSON chunk
  glbDV.setUint32(12, jsonPadded.length, true);
  glbDV.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonPadded, 20);
  // BIN chunk
  glbDV.setUint32(20 + jsonPadded.length, binPadded.length, true);
  glbDV.setUint32(24 + jsonPadded.length, 0x004e4942, true); // 'BIN\0'
  glb.set(binPadded, 28 + jsonPadded.length);
  return glb;
}

/**
 * Build a UV sphere with the given number of latitude/longitude
 * segments. A 24×16 sphere has ~768 triangles — dense enough to
 * exercise the decimation and LOD generation paths (the cube's
 * 12 triangles are too sparse for SimplifyModifier to handle).
 */
async function makeSphere(latSegments = 24, lonSegments = 16) {
  const Document = (await import('@gltf-transform/core')).Document;
  const io = new (await import('@gltf-transform/core')).NodeIO();
  const doc = new Document();
  doc.createBuffer();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let lat = 0; lat <= latSegments; lat++) {
    const theta = (lat * Math.PI) / latSegments;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let lon = 0; lon <= lonSegments; lon++) {
      const phi = (lon * 2 * Math.PI) / lonSegments;
      const x = sinT * Math.cos(phi);
      const y = cosT;
      const z = sinT * Math.sin(phi);
      positions.push(x, y, z);
      normals.push(x, y, z);
      uvs.push(lon / lonSegments, lat / latSegments);
    }
  }
  for (let lat = 0; lat < latSegments; lat++) {
    for (let lon = 0; lon < lonSegments; lon++) {
      const a = lat * (lonSegments + 1) + lon;
      const b = a + lonSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const mesh = doc.createMesh('sphere')
    .addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setArray(new Float32Array(positions)).setType('VEC3'))
      .setAttribute('NORMAL', doc.createAccessor().setArray(new Float32Array(normals)).setType('VEC3'))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setArray(new Float32Array(uvs)).setType('VEC2'))
      .setIndices(doc.createAccessor().setArray(new Uint32Array(indices)).setType('SCALAR')));
  doc.createNode('Sphere').setMesh(mesh);
  doc.createScene('Scene').addChild(doc.getRoot().listNodes()[0]);
  return io.writeBinary(doc);
}

async function main() {
  await mkdir(fixturesDir, { recursive: true });

  const cube = await makeCube();
  await writeFile(resolve(fixturesDir, 'cube.glb'), cube);
  console.log('✓ cube.glb');

  const anim = await makeAnimatedCube();
  await writeFile(resolve(fixturesDir, 'animated-cube.glb'), anim);
  console.log('✓ animated-cube.glb');

  const skinned = await makeSkinnedCube();
  await writeFile(resolve(fixturesDir, 'skinned-cube.glb'), skinned);
  console.log('✓ skinned-cube.glb');

  const sphere = await makeSphere(24, 16);
  await writeFile(resolve(fixturesDir, 'sphere.glb'), sphere);
  console.log('✓ sphere.glb (24x16, ~768 triangles — for decimation/LOD testing)');

  console.log(`\nFixtures written to ${fixturesDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
