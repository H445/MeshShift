import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertAsset,
  convertPreparedAsset,
  getAssimp,
  OUTPUT_FORMATS,
  type AssetFile,
  type ConvertResult,
} from '../src/core/index.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cube = new Uint8Array(readFileSync(resolve(fixtures, 'cube.glb')));
const encoder = new TextEncoder();

function make3dsTriangle(): Uint8Array {
  const concat = (...parts: Uint8Array[]) => {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  };
  const u16 = (value: number) => {
    const output = new Uint8Array(2);
    new DataView(output.buffer).setUint16(0, value, true);
    return output;
  };
  const f32 = (value: number) => {
    const output = new Uint8Array(4);
    new DataView(output.buffer).setFloat32(0, value, true);
    return output;
  };
  const chunk = (id: number, ...payload: Uint8Array[]) => {
    const body = concat(...payload);
    const output = new Uint8Array(6 + body.length);
    const view = new DataView(output.buffer);
    view.setUint16(0, id, true);
    view.setUint32(2, output.length, true);
    output.set(body, 6);
    return output;
  };
  const vertices = chunk(
    0x4110,
    u16(3),
    f32(0),
    f32(0),
    f32(0),
    f32(1),
    f32(0),
    f32(0),
    f32(0),
    f32(1),
    f32(0),
  );
  const faces = chunk(0x4120, u16(1), u16(0), u16(1), u16(2), u16(0));
  const mesh = chunk(0x4100, vertices, faces);
  const object = chunk(0x4000, encoder.encode('Triangle\0'), mesh);
  return chunk(0x4d4d, chunk(0x3d3d, object));
}

async function expectParseable(result: ConvertResult): Promise<void> {
  const assimp = await getAssimp();
  const files = new assimp.FileList();
  for (const file of result.files) files.AddFile(file.name, file.data);
  const parsed = assimp.ConvertFileList(files, 'assjson');
  expect(parsed.IsSuccess(), parsed.GetErrorCode()).toBe(true);
  const scene = JSON.parse(new TextDecoder().decode(parsed.GetFile(0).GetContent())) as {
    meshes?: unknown[];
  };
  expect(scene.meshes?.length ?? 0).toBeGreaterThan(0);
}

describe('format-agnostic conversion', () => {
  for (const format of OUTPUT_FORMATS) {
    it(`exports a parseable ${format.id.toUpperCase()} asset`, async () => {
      const result = await convertAsset(cube, {
        name: 'cube.glb',
        outputFormat: format.id,
      });
      expect(result.filename).toBe(`cube.${format.extension}`);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.stats.triangles).toBe(12);
      await expectParseable(result);
    });
  }

  it.each(['fbx', 'glb', 'gltf', 'obj', 'stl', 'ply', 'dae'] as const)(
    'directly exports a trusted prepared GLB to %s',
    async (outputFormat) => {
      const result = await convertPreparedAsset(
        { name: 'prepared.glb', data: cube },
        {
          name: 'prepared.glb',
          outputFormat,
          knownStats: {
            meshes: 1,
            materials: 1,
            textures: 0,
            animations: 0,
            bones: 0,
            morphTargets: 0,
            triangles: 12,
            vertices: 24,
            textureMaxSize: 0,
          },
        },
      );

      expect(result.stats.triangles).toBe(12);
      await expectParseable(result);
    },
  );

  it('returns OBJ and MTL as one output bundle', async () => {
    const result = await convertAsset(cube, { name: 'cube.glb', outputFormat: 'obj' });
    expect(result.files.map((file) => file.name)).toEqual(['cube.obj', 'cube.mtl']);
    expect(new TextDecoder().decode(result.data)).toContain('mtllib cube.mtl');
  });

  it('returns glTF JSON with its renamed binary sidecar', async () => {
    const result = await convertAsset(cube, { name: 'cube.glb', outputFormat: 'gltf' });
    expect(result.files.map((file) => file.name)).toEqual(['cube.gltf', 'cube.bin']);
    const document = JSON.parse(new TextDecoder().decode(result.files[0].data)) as {
      buffers?: Array<{ uri?: string }>;
    };
    expect(document.buffers?.[0]?.uri).toBe('cube.bin');
  });

  it('accepts a glTF input bundle with an external .bin', async () => {
    const gltf = await convertAsset(cube, { name: 'cube.glb', outputFormat: 'gltf' });
    const roundTrip = await convertAsset(
      gltf.files.map((file) => ({ name: file.name, data: file.data })),
      { name: 'external.gltf', outputFormat: 'fbx' },
    );
    expect(roundTrip.filename).toBe('external.fbx');
    await expectParseable(roundTrip);
  });

  it.each([
    ['triangle.obj', 'o Triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'],
    [
      'triangle.stl',
      'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n',
    ],
    [
      'triangle.ply',
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
    ],
    [
      'triangle.dae',
      '<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><up_axis>Y_UP</up_axis></asset><library_geometries><geometry id="g"><mesh><source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries><library_visual_scenes><visual_scene id="s"><node><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#s"/></scene></COLLADA>',
    ],
  ])('imports %s', async (name, contents) => {
    const input: AssetFile = { name, data: encoder.encode(contents) };
    const result = await convertAsset(input, { outputFormat: 'glb' });
    expect(result.stats.meshes).toBeGreaterThan(0);
    await expectParseable(result);
  });

  it('imports FBX as a source format', async () => {
    const fbx = await convertAsset(cube, { name: 'cube.glb', outputFormat: 'fbx' });
    const glb = await convertAsset({ name: 'cube.fbx', data: fbx.data }, { outputFormat: 'glb' });
    await expectParseable(glb);
  });

  it('imports 3DS as a source format', async () => {
    const result = await convertAsset(
      { name: 'triangle.3ds', data: make3dsTriangle() },
      { outputFormat: 'glb' },
    );
    expect(result.stats.meshes).toBe(1);
    await expectParseable(result);
  });
});
