# Quality and Performance Budgets

These budgets turn “enterprise grade” into repeatable release criteria. They are
intentionally split into hard safety gates and measurable quality budgets so a
slow CI runner does not turn a correctness failure into a false pass.

## Correctness tolerances

| Area             | Release criterion                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File structure   | Every supported fixture output is non-empty and parseable; malformed inputs fail without an output artifact.                                                                   |
| Index safety     | Every emitted index is an integer within the emitted position range; no NaN or infinite position/normal/UV value is accepted.                                                  |
| Topology safety  | LOD output contains no non-manifold edges introduced by simplification; no inward-facing or degenerate triangles are accepted by the topology tests.                           |
| LOD targets      | An accepted LOD is strictly smaller than its predecessor and is never above its requested target unless the result is explicitly reported as a safe plateau.                   |
| LOD monotonicity | Triangle counts never increase with depth; pinned points remain present from their selected level through deeper levels.                                                       |
| Progress         | Public progress callbacks receive finite values in the inclusive range 0..1; callback exceptions never abort conversion.                                                       |
| Cancellation     | An aborted operation returns `AbortError` at the next cooperative phase boundary and leaves no committed output artifact; CLI `SIGINT`/`SIGTERM` exits 130 after the same cleanup path. |
| Determinism      | Same bytes, options, runtime, and dependency lockfile must produce byte-identical output. Cross-runtime byte identity is not promised where native/WASM serialization differs. |
| Error hygiene    | User-facing errors identify the phase and recovery action without including input bytes, credentials, or environment secrets.                                                  |

`npm run fidelity:verify` validates the committed six-fixture source-to-GLB
feature baseline and FBX structural evidence. It requires exact integer
retention for triangles, animations, bones, and textures where the source
fixture declares them, and applies the `1e-3` bounding-box tolerance below.
FBX animation and skinning behavior remains explicitly dispositioned by the
format matrix rather than being treated as lossless when the native exporter
does not round-trip it.

Floating-point comparisons used by future geometry golden tests must use an
absolute tolerance of `1e-5` for normalized positions and transforms, `1e-4` for
normals and UVs, and `1e-3` for derived bounding-box dimensions. Exact integer
counts, file names, warning codes, and output bundle membership remain exact.

## Resource safety budgets

| Resource                 | Gate                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Aggregate external input | 200 MiB default, configurable only through the documented environment variable.                          |
| Input bundle cardinality | At most 4,096 files; file names at most 4,096 characters.                                                |
| Browser export           | At most 1 GiB per file by default, checked both from `Content-Length` and streamed bytes.                |
| Optimization options     | Public limits are finite, safe integers; LODs, pins, texture size, and triangle budget have hard maxima. |
| Temporary output         | Atomic write; no partial destination survives a failed write.                                            |
| Path boundaries          | No absolute path, traversal, URL, device name, or symlink escape is accepted.                            |

## Fixture performance budgets

The committed fixture baseline is a warm-up-sensitive local reference, not a
cross-machine SLA. The verifier applies the following generous hard ceilings to
each three-sample run:

| Fixture                       |                 Input | Maximum conversion sample | Maximum output |
| ----------------------------- | --------------------: | ------------------------: | -------------: |
| `cube.glb`                    |           1,168 bytes |                    500 ms |          1 MiB |
| `animated-cube.glb`           |           1,612 bytes |                  1,000 ms |          2 MiB |
| `skinned-cube.glb`            |           1,796 bytes |                  1,000 ms |          2 MiB |
| `sphere.glb`                  |          23,664 bytes |                  2,000 ms |          4 MiB |
| `potion.glb`                  |       8,510,352 bytes |                 10,000 ms |         16 MiB |
| `item-bag.glb`                |       7,084,236 bytes |                 10,000 ms |         16 MiB |
| generated 65k-triangle sphere | generated at run time |                 10,000 ms |         32 MiB |
| generated 1M-triangle sphere  | generated at run time |                 45,000 ms |        256 MiB |

The release baseline records duration, CPU time, input/output throughput, peak
RSS and heap deltas, retained RSS and heap deltas, startup probes, and output
size; the generated 1M-triangle workload additionally has a 2 GiB RSS-delta and
512 MiB heap-delta ceiling. The CLI startup probe measures a fresh `--help`
process, while the module-load measurement identifies in-process bootstrap
latency. A production release must additionally qualify one small, medium,
large, and maximum-supported model on the target customer hardware; that
low-resource and hardware-specific test cannot be inferred from repository
fixtures.

## Reliability and concurrency budget

`npm run reliability` runs eight conversions at the declared maximum batch
concurrency, using two copies of each representative fixture. The verifier
requires all eight conversions to succeed within 5 seconds, requires finite and
bounded per-phase progress, and requires duplicate inputs to produce identical
output digests. The report also records RSS and heap deltas for later comparison.
This is a bounded release smoke, not a substitute for maximum-model and
low-resource qualification on customer hardware.

## Build and artifact budgets

- `npm run release:check` must pass before packing.
- `npm run verify:package` must inspect the package dry-run and allow only the
  declared runtime, client, vendor, license, notice, README, documentation, and
  manifest files; caches, fixtures, source, secrets, source maps, and editor
  files are rejected. The unpacked package must remain below 64 MiB.
- `dist/RELEASE-MANIFEST.json` must hash every required runtime artifact.
- SBOM generation and production dependency audit are mandatory CI steps.
- A release must retain the packed artifact, manifest, SBOM, test report, and
  benchmark report for the retention period defined by Release Engineering.
