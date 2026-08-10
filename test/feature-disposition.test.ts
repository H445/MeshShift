import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAsset, inspectGltf, readAssimpScene } from '../src/core/index.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixturesDir, name)));
}

function makeRichGltf(): Uint8Array {
  const position = new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]);
  const normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const tangent = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const color = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0.75]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const morphPosition = new Float32Array(12);
  const arrays = [position, normal, tangent, color, uv, indices, morphPosition];
  const offsets: number[] = [];
  let byteLength = 0;
  for (const array of arrays) {
    offsets.push(byteLength);
    byteLength += array.byteLength;
  }
  const binary = new Uint8Array(byteLength);
  arrays.forEach((array, index) => {
    binary.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offsets[index]);
  });
  const uri = `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}`;
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: 4, type: 'VEC4' },
    { bufferView: 3, componentType: 5126, count: 4, type: 'VEC4' },
    { bufferView: 4, componentType: 5126, count: 4, type: 'VEC2' },
    { bufferView: 5, componentType: 5123, count: 6, type: 'SCALAR' },
    {
      bufferView: 6,
      componentType: 5126,
      count: 4,
      type: 'VEC3',
      min: [0, 0, 0],
      max: [0, 0, 0],
    },
  ];
  const document = {
    asset: { version: '2.0', generator: 'ModelShift fidelity fixture' },
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: {
      KHR_lights_punctual: {
        lights: [{ name: 'AuditLight', type: 'directional', color: [1, 0.8, 0.6], intensity: 2 }],
      },
    },
    buffers: [{ uri, byteLength }],
    bufferViews: arrays.map((array, index) => ({
      buffer: 0,
      byteOffset: offsets[index],
      byteLength: array.byteLength,
    })),
    accessors,
    materials: [
      {
        name: 'RichMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: [0.8, 0.2, 0.1, 0.75],
          metallicFactor: 0.25,
          roughnessFactor: 0.5,
        },
        alphaMode: 'BLEND',
        doubleSided: true,
      },
    ],
    meshes: [
      {
        name: 'RichMesh',
        weights: [0.2],
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, COLOR_0: 3, TEXCOORD_0: 4 },
            indices: 5,
            material: 0,
            mode: 4,
            targets: [{ POSITION: 6 }],
          },
        ],
        extras: { sourceTag: 'fidelity' },
      },
    ],
    nodes: [
      {
        name: 'TranslatedRoot',
        translation: [3, 4, 5],
        children: [1, 2, 3],
        extras: { owner: 'qa' },
      },
      { name: 'RichMeshNode', mesh: 0 },
      { name: 'CameraNode', camera: 0 },
      {
        name: 'LightNode',
        extensions: { KHR_lights_punctual: { light: 0 } },
        extras: { customFlag: 'keep' },
      },
    ],
    cameras: [{ name: 'AuditCamera', type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
    scenes: [{ name: 'RichScene', nodes: [0] }],
    scene: 0,
  };
  return new TextEncoder().encode(JSON.stringify(document));
}

function readGlbJson(data: Uint8Array): Record<string, unknown> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(
        new TextDecoder().decode(data.subarray(offset + 8, offset + 8 + length)),
      ) as Record<string, unknown>;
    }
    offset += 8 + length;
  }
  throw new Error('Rich GLB is missing its JSON chunk.');
}

type JsonObject = Record<string, unknown>;

function jsonObjects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === 'object' && item !== null)
    : [];
}

describe('format feature dispositions', () => {
  it.each([
    ['animated-cube.glb', { animations: 1, bones: 0, textures: 0 }],
    ['skinned-cube.glb', { animations: 0, bones: 2, textures: 0 }],
    ['potion.glb', { animations: 0, bones: 0, textures: 2 }],
  ] as const)('records the declared source features for %s', async (fixture, expected) => {
    const metadata = await inspectGltf(load(fixture));

    expect(metadata.animations).toBe(expected.animations);
    expect(metadata.bones).toBe(expected.bones);
    expect(metadata.textures).toBe(expected.textures);
    expect(metadata.triangles).toBeGreaterThan(0);
    expect(metadata.vertices).toBeGreaterThan(0);
    expect(metadata.bboxSize.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
  });

  it.each(['animated-cube.glb', 'skinned-cube.glb', 'potion.glb'] as const)(
    'preserves the supported feature disposition through GLB output for %s',
    async (fixture) => {
      const input = load(fixture);
      const source = await inspectGltf(input);
      const result = await convertAsset(input, { name: fixture, outputFormat: 'glb' });
      const output = await inspectGltf(result.data);

      expect(output.animations).toBe(result.stats.animations);
      expect(output.bones).toBe(result.stats.bones);
      expect(output.textures).toBe(result.stats.textures);
      expect(output.triangles).toBe(result.stats.triangles);
      expect(output.bboxMin).toEqual(source.bboxMin);
      expect(output.bboxMax).toEqual(source.bboxMax);
    },
  );

  it('makes static-format animation loss explicit while retaining source statistics', async () => {
    const result = await convertAsset(load('animated-cube.glb'), {
      name: 'animated-cube.glb',
      outputFormat: 'obj',
    });

    expect(result.stats.animations).toBe(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'export',
          message: expect.stringContaining('animation is not included'),
        }),
      ]),
    );
    expect(result.files.map((file) => file.name)).toEqual([
      'animated-cube.obj',
      'animated-cube.mtl',
    ]);
  });

  it('qualifies tangents, colors, morph targets, and transformed hierarchy bounds', async () => {
    const input = makeRichGltf();
    const source = await inspectGltf(input);
    const sourceScene = await readAssimpScene([{ name: 'rich.gltf', data: input }]);
    const result = await convertAsset(input, { name: 'rich.gltf', outputFormat: 'glb' });
    const output = await inspectGltf(result.data);
    const outputScene = await readAssimpScene(result.files);
    const outputJson = readGlbJson(result.data);
    const sourceMesh = sourceScene.meshes?.[0];
    const outputMesh = outputScene.meshes?.[0];

    expect(source.morphTargets).toBe(1);
    expect(output.morphTargets).toBe(1);
    expect(source.triangles).toBe(2);
    expect(output.triangles).toBe(2);
    expect(source.bboxMin).toEqual([2, 4, 5]);
    expect(source.bboxMax).toEqual([4, 5, 5]);
    expect(output.bboxMin).toEqual(source.bboxMin);
    expect(output.bboxMax).toEqual(source.bboxMax);
    expect((outputJson.cameras as unknown[] | undefined)?.length ?? 0).toBe(1);
    expect(sourceMesh?.tangents?.length ?? 0).toBeGreaterThan(0);
    expect(sourceMesh?.colors?.[0]?.length ?? 0).toBeGreaterThan(0);
    expect(outputMesh?.tangents?.length ?? 0).toBe(sourceMesh?.tangents?.length ?? 0);
    expect(outputMesh?.colors?.[0]?.length ?? 0).toBe(sourceMesh?.colors?.[0]?.length ?? 0);

    const outputNodes = jsonObjects(outputJson.nodes);
    const translatedRoot = outputNodes.find((node) => node.name === 'TranslatedRoot');
    const lightNode = outputNodes.find((node) => node.name === 'LightNode');
    expect((translatedRoot?.extras as JsonObject | undefined)?.owner).toBe('qa');
    expect((lightNode?.extras as JsonObject | undefined)?.customFlag).toBe('keep');
    const outputExtensions = outputJson.extensions as JsonObject | undefined;
    const punctual = outputExtensions?.KHR_lights_punctual as JsonObject | undefined;
    expect(jsonObjects(punctual?.lights)).toHaveLength(1);
    expect(outputJson.extensionsUsed).toEqual(expect.arrayContaining(['KHR_lights_punctual']));
  });

  it('retains animation channels, interpolation, and timing metadata through GLB output', async () => {
    const input = load('animated-cube.glb');
    const sourceJson = readGlbJson(input);
    const result = await convertAsset(input, {
      name: 'animated-cube.glb',
      outputFormat: 'glb',
    });
    const outputJson = readGlbJson(result.data);
    const sourceAnimation = jsonObjects(sourceJson.animations)[0];
    const outputAnimation = jsonObjects(outputJson.animations)[0];
    const sourceSamplers = jsonObjects(sourceAnimation?.samplers);
    const outputSamplers = jsonObjects(outputAnimation?.samplers);
    const sourceChannels = jsonObjects(sourceAnimation?.channels);
    const outputChannels = jsonObjects(outputAnimation?.channels);

    expect(outputAnimation?.name).toBe(sourceAnimation?.name);
    expect(outputChannels).toHaveLength(sourceChannels.length);
    expect(outputChannels[0]?.target).toEqual(sourceChannels[0]?.target);
    expect(outputSamplers).toHaveLength(sourceSamplers.length);
    expect(outputSamplers[0]?.interpolation).toBe(sourceSamplers[0]?.interpolation);

    const sourceInputAccessor = jsonObjects(sourceJson.accessors)[Number(sourceSamplers[0]?.input)];
    const outputInputAccessor = jsonObjects(outputJson.accessors)[Number(outputSamplers[0]?.input)];
    expect(outputInputAccessor?.count).toBe(sourceInputAccessor?.count);
    expect(outputInputAccessor?.min).toEqual(sourceInputAccessor?.min);
    expect(outputInputAccessor?.max).toEqual(sourceInputAccessor?.max);
  });

  it('retains skin joints and inverse-bind-matrix accessors through GLB output', async () => {
    const input = load('skinned-cube.glb');
    const sourceJson = readGlbJson(input);
    const result = await convertAsset(input, {
      name: 'skinned-cube.glb',
      outputFormat: 'glb',
    });
    const outputJson = readGlbJson(result.data);
    const sourceSkin = jsonObjects(sourceJson.skins)[0];
    const outputSkin = jsonObjects(outputJson.skins)[0];
    const sourceInverseBind = jsonObjects(sourceJson.accessors)[
      Number(sourceSkin?.inverseBindMatrices)
    ];
    const outputInverseBind = jsonObjects(outputJson.accessors)[
      Number(outputSkin?.inverseBindMatrices)
    ];
    const outputNodeNames = jsonObjects(outputJson.nodes)
      .map((node) => node.name)
      .filter((name): name is string => typeof name === 'string');

    expect(jsonObjects(outputJson.skins)).toHaveLength(jsonObjects(sourceJson.skins).length);
    expect(jsonObjects(outputSkin?.joints)).toHaveLength(jsonObjects(sourceSkin?.joints).length);
    expect(outputSkin?.inverseBindMatrices).toEqual(expect.any(Number));
    expect(outputInverseBind?.count).toBe(sourceInverseBind?.count);
    expect(outputInverseBind?.type).toBe(sourceInverseBind?.type);
    expect(outputNodeNames).toEqual(expect.arrayContaining(['root', 'tip']));
  });
});
