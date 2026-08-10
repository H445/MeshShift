# ModelShift

ModelShift is an offline 3D asset converter with a local web UI, a Node.js CLI, and a reusable TypeScript API. Conversion happens locally through the bundled Assimp WebAssembly runtime; no model is uploaded to a remote service.

## Formats

| Direction | Formats                                                             |
| --------- | ------------------------------------------------------------------- |
| Input     | GLB, glTF, FBX, OBJ, STL, PLY, Collada (`.dae`), 3D Studio (`.3ds`) |
| Output    | FBX, GLB, glTF, OBJ, STL, PLY, Collada (`.dae`)                     |

glTF and OBJ companion files are supported. Supply `.bin`, `.mtl`, and referenced textures alongside the primary file. The CLI discovers referenced sidecars automatically; the web app groups sidecars selected or dropped together.

FBX, GLB, and glTF can retain scene hierarchy, materials, skinning, morph targets, and animation where Assimp supports the path. OBJ, STL, PLY, and DAE are exported as static mesh formats. OBJ exports an MTL file and extracts embedded textures when present.

## Quick start

Install dependencies once:

```bash
pnpm install
```

Launch ModelShift from the repository root:

Linux/macOS:

```sh
sh ./start.sh
```

Windows PowerShell:

```powershell
.\start.ps1
```

Both launchers start the local Vite development server at `http://localhost:5173/`. The server exposes a project-scoped endpoint that writes completed browser exports to `exports/`. Additional Vite options are forwarded unchanged:

```sh
sh ./start.sh --port 5180 --host 0.0.0.0 --open
```

```powershell
.\start.ps1 --port 5180 --host 0.0.0.0 --open
```

`pnpm dev` remains available as a package-manager alias for the same shared launcher.

Build every release surface:

```bash
pnpm build
```

The reusable Node API is written to `dist/core/`, the CLI bundle is
`dist/cli/modelshift.mjs`, and the production web app is written to
`dist/client/`. Use `pnpm preview` when testing the production build locally so
the `exports/` writer remains available.

## Export destination

The web app automatically saves every successful conversion directly under the repository’s `exports/` directory instead of using the browser Downloads folder. A single conversion writes its output and companion files at the root of `exports/`. A batch conversion groups each converted asset into its own subdirectory to prevent companion-file name collisions. The **Save again** controls retry the write or overwrite the existing files.

The local writer accepts only relative paths beneath `exports/`, rejects traversal and unsafe path segments, and overwrites an older file with the same path. Generated files are ignored by Git; `exports/.gitkeep` retains the empty directory in a checkout.

## CLI

```bash
# FBX remains the default output for compatibility
modelshift model.glb

# Convert FBX to GLB
modelshift model.fbx --format glb

# Convert OBJ + referenced MTL/textures to FBX
modelshift model.obj --format fbx

# Recursively convert a directory to PLY
modelshift ./models --recursive --format ply --output ./converted

# Package all successful output files
modelshift ./models --recursive --format gltf --output ./converted --zip
```

Run the local bundle with:

```bash
node dist/cli/modelshift.mjs model.obj --format glb
```

Important options:

```text
-f, --format <format>   fbx | glb | gltf | obj | stl | ply | dae
-o, --output <dir>      Output directory
-r, --recursive         Recurse into input directories
--parallel <n>          1–8 concurrent conversions
-V, --version           Print the installed ModelShift version
--json                  Write conversion statistics
--zip                   Package successful outputs
--max-triangles <n>     Mesh triangle cap
--merge-by-material     Merge meshes sharing a material
--generate-lods <n>     Generate additional LOD levels
```

Exit codes are `0` for success, `1` for invalid/no input, `2` when every conversion fails, and `4` for partial success.

## Core API

```ts
import { convertAsset } from 'modelshift';

const result = await convertAsset(
  [
    { name: 'model.obj', data: objBytes },
    { name: 'model.mtl', data: mtlBytes },
    { name: 'albedo.png', data: textureBytes },
  ],
  { outputFormat: 'glb', name: 'model.obj' },
);

result.filename; // model.glb
result.data; // primary output bytes
result.files; // every output file
result.stats;
result.warnings;
```

`convertGltfToFbx()` remains as a backwards-compatible wrapper. `convertBatch()` accepts the same output options and supports companion files through each batch item's `files` property.

Long-running core and optimization calls may receive an `AbortSignal` through
their options. Cancellation is cooperative: the API returns a typed
`AbortError` at the next phase boundary or yield, while a native parser/export
operation already in progress may finish its current operation first.

## Architecture

```text
CLI ──────────┐
              ├─ convertAsset() ─ Assimp WASM ─ native FBX/glTF/GLB writers
Local web UI ─┘                    └──────────── local OBJ/STL/PLY/DAE writers
      │
      └─ project-scoped writer ── exports/
```

All import paths are normalized through Assimp. The browser previews every supported source and result by generating a temporary GLB and loading it with three.js. Multi-file outputs retain their companion files in `exports/`.

### Large-model preview loading

Source previews use a staged loading pipeline. The browser first reads the selected primary and companion files while reporting byte progress, then transfers those buffers to a dedicated Web Worker. Assimp source analysis and temporary GLB generation run inside that worker, keeping the page controls and progress animation responsive even for scan-sized meshes. Once normalization finishes, the page parses the temporary GLB, inspects its scene metadata, and sends it to the three.js viewer.

The loading panel reports each of those stages and remains animated during long native Assimp calls, where intermediate percentage data is not available. ModelShift also reuses glTF accessor bounds instead of synchronously rescanning every vertex, caches a row’s normalized preview for later refocusing, cancels obsolete worker jobs when the active asset changes, and only prepares the actively previewed item instead of eagerly processing an entire batch.

**Generate optimized preview** uses the matching progress panel in the output viewer. It reports source preparation, inspection, geometry and LOD work, texture/material processing, preview packaging, parsing, and rendering, then displays the before/after statistics without writing an export.

**Convert all** (or a row’s individual **Convert**/**Retry** action) uses that same output-viewer progress panel for source preparation, optimization, format export, validation, and final rendering. The complete conversion pipeline runs in a dedicated worker, so native Assimp work, Meshopt passes, LOD construction, texture processing, and export serialization do not occupy the page’s UI thread. Batch conversions run one model at a time to keep several large model buffers from accumulating in memory.

When **Generate optimized preview** has already produced a model with the current
geometry, texture, and LOD settings, conversion exports directly from that
cached optimized GLB. ModelShift does not repeat normalization or optimization.
Changing only the output format keeps the cached model valid; changing the
source or an optimization setting invalidates it. The converted output viewer
also renders from this prepared GLB, avoiding a second import round trip through
the exported format.

When more than one LOD is available, every row in the **Files** list shows `LOD0`, `LOD1`, and deeper save toggles. These are per-object: each converted file keeps only its checked levels. The matching controls beside the Files heading toggle a level globally across the full batch. Changing the LOD selection on a completed row returns that row to **Queued** so converting again safely overwrites its export with the new selection.

## How LOD generation works

LOD generation is a geometry-first pipeline. It favors a safe plateau over hitting a triangle target with holes, folded faces, broken UV islands, or a visibly damaged outline.

1. **Prepare the source.** ModelShift normalizes the mesh to indexed geometry and keeps the high-detail source available for feature checks and optional texture projection. Each requested LOD is generated independently from LOD0, not from the previous LOD, so errors do not compound down the chain.
2. **Choose the triangle budget.** Explicit per-level targets take precedence. Automatic targets use 50%, 30%, 20%, and 12% of the source for LOD1–LOD4; automatic LOD4 is additionally capped at 450 triangles. Targets never go below four triangles, and accepted levels must decrease monotonically.
3. **Run progressive Meshopt passes.** The simplifier begins with conservative error tolerances and relaxes them only when necessary. Textured meshes use attribute-aware and UV-safe passes that weight UV continuity, preserve surviving normals and colors, lock severe UV discontinuities, and protect atlas borders. Scan-sized meshes switch to bounded, memory-aware passes and compact only the vertices selected by the new index buffer.
4. **Repair topology.** If aggressive reduction makes an edge belong to more than two faces, ModelShift duplicates the vertices of the exceptional faces. This keeps every triangle visible while removing the non-manifold edge instead of dropping a face and creating a crack or hole.
5. **Audit critical shape features.** The reduced surface is compared with the source using a BVH closest-point search. Missing points are scored by geometric deviation, local curvature, extremity, and silhouette importance. Exact duplicate positions at UV seams are treated as one source point so seams do not receive false curvature weight.
6. **Run silhouette passes.** Three canonical snap views audit the XY, XZ, and YZ envelopes. Another 24 oblique views—eight azimuths at each of three elevations—approximate a free-orbit inspection. High-value missing anchors may be restored by splitting a face or a shared manifold edge.
7. **Validate every repair.** Candidate splits must preserve face orientation and source-normal agreement, avoid degenerate or paper-thin triangles, maintain acceptable triangle quality, and avoid projected-area explosions in the three snap views. Restored anchors are spatially separated and bounded by a repair budget so the LOD remains meaningfully reduced.
8. **Accept or safely plateau.** A level is accepted only when it is smaller than the preceding level and passes the safety checks. If no safe reduction is available, ModelShift clones the last safe geometry and reports a `safe plateau`; it does not substitute a destructive fallback.
9. **Rebuild UVs and bake textures when available.** In the browser, textured LODs receive a new non-overlapping xatlas/watlas UV atlas. Atlas resolution scales with the LOD, while dense scans use a topology-based high-detail budget. Every atlas pixel is projected back to the intact source with a reusable BVH, closest-surface lookup, and forward/backward ray fallback.
10. **Verify and finish the bake.** Projection coverage must touch enough distinct source faces and span the model on its active axes. Bounded dilation fills chart padding and missed samples, then material texture slots are resampled with the source transforms, wrapping modes, and bilinear filtering. If unwrapping, projection, validation, or baking fails, the simplified geometry keeps its safe source material/UV path.
11. **Assemble the scene.** Generated meshes are named `_LOD1`, `_LOD2`, and so on and are added as siblings of LOD0 with the same transform. Keeping them as siblings lets an engine or viewer switch their visibility independently.

For very large meshes, the same policy is applied with bounded repair and texture proxies, compact geometry allocation, and periodic browser yields to prevent the LOD job from monopolizing memory or the main thread.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm release:check
```

Set `MODELSHIFT_MAX_FILE_MB` to change the default 200 MB aggregate input limit. The legacy `G2F_MAX_FILE_MB` variable is still recognized.

## Safety limits and local configuration

The converter applies defensive limits at every public entry point:

- External input bundles default to 200 MB total. Configure the limit with `MODELSHIFT_MAX_FILE_MB`.
- Local browser exports default to 1 GB per file. Configure the limit with `MODELSHIFT_MAX_EXPORT_MB`.
- An input bundle may contain at most 4,096 files, and public optimization options are validated before parsing.
- Companion files must be local, relative resources inside the selected input directory. Absolute paths, traversal, URL resources, and symlink escapes are rejected by the CLI.
- CLI outputs are written atomically beneath the requested output directory; symlinked output parents and unsafe generated names are rejected.

Both environment variables accept non-negative megabytes. Invalid or overflowing values fall back to the documented defaults. These controls are intended for local deployments and should be set to match the host's available memory and disk budget.

## Release verification

Run the complete release gate with:

```sh
npm run release:check
```

This performs type checking, linting, formatting verification, the full test suite, the production build, and distributable-artifact verification. The verifier checks the core API, CLI, browser client, vendor WASM/runtime files, third-party notices, package engine requirement, and executable metadata.

Run `npm run benchmark` after a production build to generate a repeatable fixture baseline at `artifacts/benchmark-baseline.json`. The baseline records input/output sizes, three conversion-duration and CPU samples, throughput, peak/retained memory deltas, and startup probes per representative fixture; `npm run benchmark:verify` compares those measurements against release-specific performance budgets.

The package declares `pnpm@10.30.1` as its package manager. Use `pnpm install --frozen-lockfile` in CI or release environments. npm can run project scripts when dependencies are already installed, but the lockfile should be resolved with the declared package manager.

## Enterprise release evidence

The versioned release contract and audit evidence live in:

- [Release contract](docs/RELEASE_CONTRACT.md)
- [Format and feature matrix](docs/FORMAT_FEATURE_MATRIX.md)
- [Quality and performance budgets](docs/QUALITY_BUDGETS.md)
- [Browser compatibility matrix](docs/BROWSER_COMPATIBILITY_MATRIX.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Operations and release runbook](docs/OPERATIONS_RUNBOOK.md)
- [Release approval record](docs/RELEASE_APPROVAL_RECORD.md)
- [Ship-readiness plan](SHIP_READINESS_PLAN.md)
- [Ship-readiness evidence report](SHIP_READINESS_REPORT.md)

`npm run benchmark` writes the current machine's measurements to
`artifacts/benchmark-baseline.json`; `npm run benchmark:verify` enforces the
versioned fixture ceilings in `docs/performance-budgets.json`.

`npm run test:report` writes the machine-readable Vitest result used as retained
CI release evidence at `artifacts/test-results.json`.

`npm run reliability` and `npm run reliability:verify` retain the bounded
concurrency evidence at `artifacts/reliability-baseline.json`.

## Limitations

- Format conversion cannot create features the destination format does not support.
- OBJ, STL, PLY, and the current DAE writer do not contain skeletal animation or morph animation.
- Assimp has partial support for some animation/material combinations; verify production assets in the target engine or DCC.
- Texture resizing and LOD texture baking require the browser canvas pipeline. The Node API and CLI preserve unchanged embedded PNG/JPEG bytes.
- Draco and KTX2/Basis inputs are not decoded by the current preprocessing path.
- USD/USDZ are not exposed because this bundled Assimp build does not provide a verified import/export path for them.
- Direct browser saving requires the local ModelShift dev or preview server; a separately hosted static build cannot write to the repository filesystem.

## License

ModelShift is MIT licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the licenses and exact checksums of the redistributed Assimp WebAssembly
runtime.
