export const INPUT_FORMATS = [
  { extension: 'glb', label: 'Binary glTF' },
  { extension: 'gltf', label: 'glTF' },
  { extension: 'fbx', label: 'FBX' },
  { extension: 'obj', label: 'Wavefront OBJ' },
  { extension: 'stl', label: 'STL' },
  { extension: 'ply', label: 'PLY' },
  { extension: 'dae', label: 'Collada' },
  { extension: '3ds', label: '3D Studio' },
] as const;

export type InputFormat = (typeof INPUT_FORMATS)[number]['extension'];

export const OUTPUT_FORMATS = [
  {
    id: 'fbx',
    label: 'FBX',
    extension: 'fbx',
    assimpId: 'fbx',
    mimeType: 'application/octet-stream',
  },
  {
    id: 'glb',
    label: 'Binary glTF (.glb)',
    extension: 'glb',
    assimpId: 'glb2',
    mimeType: 'model/gltf-binary',
  },
  {
    id: 'gltf',
    label: 'glTF + resources',
    extension: 'gltf',
    assimpId: 'gltf2',
    mimeType: 'model/gltf+json',
  },
  {
    id: 'obj',
    label: 'Wavefront OBJ',
    extension: 'obj',
    assimpId: null,
    mimeType: 'model/obj',
  },
  {
    id: 'stl',
    label: 'STL (binary)',
    extension: 'stl',
    assimpId: null,
    mimeType: 'model/stl',
  },
  {
    id: 'ply',
    label: 'PLY',
    extension: 'ply',
    assimpId: null,
    mimeType: 'application/octet-stream',
  },
  {
    id: 'dae',
    label: 'Collada (.dae)',
    extension: 'dae',
    assimpId: null,
    mimeType: 'model/vnd.collada+xml',
  },
] as const;

export type OutputFormatDefinition = (typeof OUTPUT_FORMATS)[number];

const inputExtensions = new Set<string>(INPUT_FORMATS.map((format) => format.extension));

export function extensionOf(name: string): string {
  const leaf = name.replace(/\\/g, '/').split('/').pop() ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : '';
}

export function isSupportedInputName(name: string): boolean {
  return inputExtensions.has(extensionOf(name));
}

export function getOutputFormat(id: string): OutputFormatDefinition | undefined {
  return OUTPUT_FORMATS.find((format) => format.id === id);
}

export function requireOutputFormat(id: string): OutputFormatDefinition {
  const format = getOutputFormat(id);
  if (!format) {
    throw new RangeError(
      `Unsupported output format "${id}". Choose ${OUTPUT_FORMATS.map((item) => item.id).join(', ')}.`,
    );
  }
  return format;
}

export function outputFilename(sourceName: string, format: OutputFormat): string {
  const definition = requireOutputFormat(format);
  const leaf = sourceName.replace(/\\/g, '/').split('/').pop() ?? sourceName;
  const dot = leaf.lastIndexOf('.');
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  return `${base || 'model'}.${definition.extension}`;
}

export const INPUT_ACCEPT = INPUT_FORMATS.map((format) => `.${format.extension}`).join(',');
import type { OutputFormat } from '../shared/options.js';
