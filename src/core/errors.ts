/**
 * Typed error classes for the converter.
 * All errors thrown by `convertGltfToFbx` and friends are subclasses of `GltfToFbxError`.
 */

export class GltfToFbxError extends Error {
  override readonly name: string;
  readonly phase?: string;
  constructor(message: string, name = 'GltfToFbxError', phase?: string) {
    super(message);
    this.name = name;
    this.phase = phase;
  }
}

export class ParseError extends GltfToFbxError {
  constructor(message: string) {
    super(message, 'ParseError', 'parse');
  }
}

export class UnsupportedExtensionError extends GltfToFbxError {
  readonly extension: string;
  constructor(extension: string) {
    super(
      `Unsupported GLTF extension: ${extension}. See README for supported extensions.`,
      'UnsupportedExtensionError',
      'parse',
    );
    this.extension = extension;
  }
}

export class ExportError extends GltfToFbxError {
  constructor(message: string) {
    super(message, 'ExportError', 'export');
  }
}

export class PostProcessError extends GltfToFbxError {
  constructor(message: string) {
    super(message, 'PostProcessError', 'post');
  }
}

export class InputTooLargeError extends GltfToFbxError {
  readonly sizeBytes: number;
  readonly maxBytes: number;
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `Input is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB, exceeds limit of ${(maxBytes / 1024 / 1024).toFixed(1)} MB.`,
      'InputTooLargeError',
      'parse',
    );
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}
