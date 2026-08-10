#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { convertAsset, inspectGltf, readAssimpScene, statsFromAssimpScene } = await import(
  pathToFileURL(resolve(root, 'dist/core/index.js')).href
);

const fixtures = [
  { name: 'cube.glb', animations: 0, bones: 0, textures: 0 },
  { name: 'animated-cube.glb', animations: 1, bones: 0, textures: 0 },
  { name: 'skinned-cube.glb', animations: 0, bones: 2, textures: 0 },
  { name: 'sphere.glb', animations: 0, bones: 0, textures: 0 },
  { name: 'potion.glb', animations: 0, bones: 0, textures: 2 },
  { name: 'item-bag.glb', animations: 0, bones: 0, textures: 2 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteArray(values, label) {
  assert(values.every(Number.isFinite), `${label} contains a non-finite value.`);
}

function finiteScene(scene, label) {
  for (const [meshIndex, mesh] of (scene.meshes ?? []).entries()) {
    for (const [field, values] of Object.entries({
      vertices: mesh.vertices ?? [],
      normals: mesh.normals ?? [],
      tangents: mesh.tangents ?? [],
    })) {
      finiteArray(values, `${label} mesh ${meshIndex} ${field}`);
    }
    for (const [channel, values] of (mesh.texturecoords ?? []).entries()) {
      finiteArray(values, `${label} mesh ${meshIndex} UV${channel}`);
    }
  }
}

function metadataShape(metadata) {
  return {
    meshes: metadata.meshes,
    materials: metadata.materials,
    textures: metadata.textures,
    animations: metadata.animations,
    bones: metadata.bones,
    morphTargets: metadata.morphTargets,
    triangles: metadata.triangles,
    vertices: metadata.vertices,
    textureMaxSize: metadata.textureMaxSize,
    bboxMin: metadata.bboxMin,
    bboxMax: metadata.bboxMax,
    bboxSize: metadata.bboxSize,
  };
}

const rows = [];
for (const fixture of fixtures) {
  const data = new Uint8Array(await readFile(resolve(root, 'test/fixtures', fixture.name)));
  const source = await inspectGltf(data);
  assert(source.animations === fixture.animations, `${fixture.name}: animation baseline changed.`);
  assert(source.bones === fixture.bones, `${fixture.name}: bone baseline changed.`);
  assert(source.textures === fixture.textures, `${fixture.name}: texture baseline changed.`);
  assert(source.triangles > 0 && source.vertices > 0, `${fixture.name}: empty source geometry.`);
  finiteArray(source.bboxMin, `${fixture.name} bboxMin`);
  finiteArray(source.bboxMax, `${fixture.name} bboxMax`);

  const glb = await convertAsset(data, { name: fixture.name, outputFormat: 'glb' });
  const glbMetadata = await inspectGltf(glb.data);
  assert(glbMetadata.animations === source.animations, `${fixture.name}: GLB animation drift.`);
  assert(glbMetadata.bones === source.bones, `${fixture.name}: GLB skin drift.`);
  assert(glbMetadata.textures === source.textures, `${fixture.name}: GLB texture drift.`);
  assert(glbMetadata.triangles === source.triangles, `${fixture.name}: GLB topology drift.`);
  finiteArray(glbMetadata.bboxMin, `${fixture.name} GLB bboxMin`);
  finiteArray(glbMetadata.bboxMax, `${fixture.name} GLB bboxMax`);

  const fbx = await convertAsset(data, { name: fixture.name, outputFormat: 'fbx' });
  const fbxScene = await readAssimpScene(fbx.files);
  finiteScene(fbxScene, `${fixture.name} FBX`);
  const fbxStats = statsFromAssimpScene(fbxScene, data.byteLength);
  assert(fbx.data.byteLength > 64, `${fixture.name}: FBX output is empty.`);
  assert(fbxStats.meshes > 0 && fbxStats.triangles > 0, `${fixture.name}: FBX has no geometry.`);

  rows.push({
    name: fixture.name,
    inputBytes: data.byteLength,
    source: metadataShape(source),
    glb: {
      bytes: glb.data.byteLength,
      metadata: metadataShape(glbMetadata),
    },
    fbx: {
      bytes: fbx.data.byteLength,
      stats: fbxStats,
      meshCardinality: (fbxScene.meshes ?? []).map((mesh) => ({
        vertices: mesh.vertices?.length ?? 0,
        normals: mesh.normals?.length ?? 0,
        tangents: mesh.tangents?.length ?? 0,
        textureCoordinates: (mesh.texturecoords ?? []).map((channel) => channel.length),
        faces: (mesh.faces ?? []).map((face) => face.length),
      })),
      animationCount: fbxScene.animations?.length ?? 0,
      boneCount: (fbxScene.meshes ?? []).reduce((sum, mesh) => sum + (mesh.bones?.length ?? 0), 0),
      morphTargetCount: (fbxScene.meshes ?? []).reduce(
        (sum, mesh) => sum + (mesh.animmeshes?.length ?? 0),
        0,
      ),
    },
  });
}

const outputPath = resolve(root, 'artifacts', 'fidelity-baseline.json');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      bboxTolerance: 1e-3,
      fixtures: rows,
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote fidelity baseline for ${rows.length} fixtures to ${outputPath}.`);
