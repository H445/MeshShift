# Architecture

```text
CLI ──────────┐
              ├─ convertAsset() ─ Assimp WASM ─ native FBX/glTF/GLB writers
Local web UI ─┘                    └──────────── local OBJ/STL/PLY/DAE writers
      │
      └─ project-scoped writer ── exports/
```

The desktop distribution adds a small Electron main process around the same
renderer bundle:

```text
Electron main process ── meshshift://app ── packaged Vite renderer + workers
          │
          └─ validated IPC save request ── Documents/MeshShift/exports/
```

The renderer has context isolation, no Node integration, and a sandbox. The
main process owns filesystem writes and rejects untrusted IPC senders and
navigation. Development may use the local Vite server; packaged builds serve
only the embedded renderer through the registered `meshshift://app` protocol.

All import paths are normalized through Assimp. The browser previews every
supported source and result by generating a temporary GLB and loading it with
three.js. Multi-file outputs retain their companion files in `exports/`.

## Large-model preview loading

Source previews use a staged loading pipeline. The browser first reads the
selected primary and companion files while reporting byte progress, then
transfers those buffers to a dedicated Web Worker. Assimp source analysis and
temporary GLB generation run inside that worker, keeping the page controls and
progress animation responsive even for scan-sized meshes.

Once normalization finishes, the page parses the temporary GLB, inspects its
scene metadata, and sends it to the three.js viewer. MeshShift reuses glTF
accessor bounds instead of synchronously rescanning every vertex, caches a row’s
normalized preview for later refocusing, cancels obsolete worker jobs when the
active asset changes, and prepares only the actively previewed item instead of
eagerly processing an entire batch.

**Generate optimized preview** uses the matching progress panel in the output
viewer. It reports source preparation, inspection, geometry and LOD work,
texture/material processing, preview packaging, parsing, and rendering.

**Convert all** and each row’s **Convert** or **Retry** action use that same
output-viewer progress panel for source preparation, optimization, format
export, validation, and final rendering. The complete conversion pipeline runs
in a dedicated worker, so native Assimp work, Meshopt passes, LOD construction,
texture processing, and export serialization do not occupy the page’s UI
thread. Batch conversions run one model at a time to keep several large model
buffers from accumulating in memory.

When **Generate optimized preview** has already produced a model with the
current geometry, texture, and LOD settings, conversion exports directly from
that cached optimized GLB. Changing only the output format keeps the cached
model valid; changing the source or an optimization setting invalidates it.
The converted output viewer also renders from this prepared GLB, avoiding a
second import round trip through the exported format.

When more than one LOD is available, every row in the **Files** list shows
`LOD0`, `LOD1`, and deeper save toggles. These are per-object: each converted
file keeps only its checked levels. The matching controls beside the Files
heading toggle a level globally across the full batch. Changing the LOD
selection on a completed row returns that row to **Queued** so converting again
safely overwrites its export with the new selection.
