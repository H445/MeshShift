# GLB → FBX

Convert **GLB/GLTF** to **FBX 7.4** binary. Preserves PBR materials, textures, and skinning.

- **Static web UI** — pure static SPA, no server. Open `dist/client/index.html` in any modern browser.
- **Node CLI** — `pnpm dlx gltf-to-fbx model.glb` or bulk convert a directory.
- **Tiny footprint** — vendored `assimpjs` (WebAssembly port of assimp with FBX export) does the heavy lifting. Same fidelity as native assimp.

## How it works

The conversion is a single hop through the vendored **assimpjs** (repalash fork, FBX export enabled):

```
GLB/GLTF  →  assimpjs (wasm)  →  FBX 7.4 binary
```

assimp is the industry-standard 3D format converter; the WebAssembly port is loaded once (~4 MB) and cached. PBR materials, textures, and skinning are all preserved by assimp's native GLB importer + FBX exporter. Skeletal animation is partially supported (see Limitations).

## Features

| Asset          | Support                                                                |
| -------------- | ---------------------------------------------------------------------- |
| Meshes         | position, normal, UV0-1, vertex color, tangents                       |
| PBR materials  | baseColor, metallic, roughness, normal, emissive, occlusion            |
| Textures       | embedded inside the FBX (toggle to reference by path)                  |
| Skeletal anim  | bone hierarchy + skin weights                                          |
| Animation      | partially supported (some glTF animation channels may not round-trip)  |
| Bulk convert   | web multi-file (with zip download) + CLI recursive directory walk      |

## Quick start

### Web UI

```bash
pnpm install
pnpm dev           # Vite dev server with HMR (dev only)
pnpm build         # → dist/client/index.html (open directly in browser)
```

### CLI

```bash
# Single file
pnpm dlx gltf-to-fbx path/to/model.glb

# Bulk: a whole directory
pnpm dlx gltf-to-fbx ./models/ -o ./out/ -r

# With zip output
pnpm dlx gltf-to-fbx ./models/ -o ./out/ -r --zip

# Local (no publish)
pnpm install
node dist/cli/gltf-to-fbx.mjs path/to/model.glb
```

## CLI reference

```
Usage: gltf-to-fbx [options] <inputs...>

Arguments:
  inputs               One or more input .glb/.gltf files or directories

Options:
  -o, --output <dir>   Output directory (default: same dir as input for single files)
  -r, --recursive      Recurse into subdirectories
  --parallel <n>       Concurrent conversions (default: CPU count - 1, max 8)
  --no-embed-textures  Reference textures by path instead of embedding (passed to assimp)
  --scale <n>          Apply uniform scale (default: 1)
  --axis <axis>        Output axis (y-up|z-up) (default: "y-up")
  --json               Emit a JSON sidecar per file with stats
  --zip                Pack all outputs into a single .zip (bulk mode)
  -v, --verbose        Verbose per-file progress to stderr
```

**Exit codes:** 0 ok, 1 input error, 2 conversion error, 4 partial success (some files failed).

## Architecture

```
src/
├── core/                 (framework-free converter — runs in Node AND browser)
│   ├── index.ts          Public API: convertGltfToFbx(), convertBatch()
│   ├── exportFbx.ts      GLB → assimpjs → FBX
│   ├── assimpLoader.ts   Platform-agnostic types + impl re-export
│   ├── assimpLoaderImpl.ts  __IS_BROWSER__-gated Node/browser loaders
│   ├── parseGltf.ts      (web only) three.js GLTFLoader for preview
│   ├── progress.ts       Progress callback normalizer
│   └── errors.ts         Typed error classes
├── client/               Vite SPA (static, no backend)
│   ├── ui/         dropzone, viewers, queue, settings, toasts
│   ├── lib/        zip helper (JSZip)
│   └── main.ts     app entry
├── cli/                  Commander-based CLI
└── shared/               types + options
public (vendored):
├── assimpjs.js           Emscripten loader (~130 KB)
└── assimpjs.wasm         Assimp core with FBX export (~4 MB)
```

The vendored assimpjs files live in `src/client/public/` and are copied to `dist/cli/` for the CLI build, and to `dist/client/` for the web build (served as `/assimpjs.js` and `/assimpjs.wasm`).

## Limitations (v1)

- **Draco-compressed GLBs:** not supported (decompress with `gltf-transform` first).
- **KTX2 / Basis textures:** not supported.
- **FBX → GLTF:** not supported (one-way only).
- **Animation:** assimp's FBX exporter has partial glTF-animation support. Some animation channels may not round-trip perfectly. Open the FBX in Blender/Maya/Unity to verify.
- **Output details:** the FBX version, material model, and texture embedding strategy are chosen by assimp. If you need different output, use the assimp CLI directly on the converted file.

## Testing

```bash
pnpm test               # Vitest, 13 tests, ~1s
```

The test suite covers: single-file conversion, bulk conversion with partial failures, error cases (oversized input, garbage input), progress callbacks, and round-trip validation (FBX → assjson via the same assimp engine).

## License

MIT.
