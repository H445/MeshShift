/**
 * Typed error classes for the converter.
 * All conversion errors share this base class. The legacy name remains
 * exported so existing consumers do not break after the MeshShift rename.
 */

export class MeshShiftError extends Error {
  override readonly name: string;
  readonly phase?: string;
  constructor(message: string, name = 'MeshShiftError', phase?: string) {
    super(message);
    this.name = name;
    this.phase = phase;
  }
}

/** @deprecated Use MeshShiftError. */
export { MeshShiftError as GltfToFbxError };

export class ParseError extends MeshShiftError {
  constructor(message: string) {
    super(message, 'ParseError', 'parse');
  }
}

export class UnsupportedExtensionError extends MeshShiftError {
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

export class ExportError extends MeshShiftError {
  constructor(message: string) {
    super(message, 'ExportError', 'export');
  }
}

export class PostProcessError extends MeshShiftError {
  constructor(message: string) {
    super(message, 'PostProcessError', 'post');
  }
}

export class InputTooLargeError extends MeshShiftError {
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
