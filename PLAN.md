# ModelShift — Status

ModelShift replaces the original single-purpose GLB → FBX product.

## Delivered

- Format-agnostic `convertAsset()` API with backwards-compatible GLB → FBX wrapper
- Inputs: GLB, glTF, FBX, OBJ, STL, PLY, DAE, and 3DS
- Outputs: FBX, GLB, glTF, OBJ, STL, PLY, and DAE
- Multi-file input/output bundles for glTF, OBJ, MTL, buffers, and textures
- Native Assimp FBX/glTF/GLB export plus local OBJ/STL/PLY/DAE exporters
- Generic browser previews via a temporary GLB normalization pass
- Output-format selector and format-aware ZIP downloads
- Generic CLI with `--format`, recursive batches, sidecar discovery, stats, and ZIP output
- Cross-format import/export and Assimp round-trip tests

## Design boundaries

- The application remains fully local: static browser app + Node CLI, no backend.
- FBX remains the default output to avoid breaking existing callers.
- Static formats intentionally warn when animation would be omitted.
- Only verified exporters are shown in the UI and CLI.
