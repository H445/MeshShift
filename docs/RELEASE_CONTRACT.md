# ModelShift Release Contract

This is the compatibility and acceptance contract for ModelShift 0.2.x. A
release is supported only for the surfaces and limits declared here. Features
outside the contract may still work, but are not enterprise support promises.

## Runtime and deployment matrix

| Surface          | Supported contract                                                                                                                  | Qualification requirement                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CLI and Node API | Node.js 20 LTS and 22 LTS; x64 and arm64 where the host can run the bundled WASM runtime                                            | CI typecheck, tests, build, package smoke test, and production dependency audit on Node 20 and 22 |
| Windows          | Windows 10/11 x64; PowerShell and a regular writable output directory                                                               | Release smoke test on a clean Windows runner                                                      |
| Linux            | Ubuntu 22.04/24.04 x64; regular writable output directory                                                                           | Release smoke test on a clean Linux runner                                                        |
| macOS            | macOS 13 or newer, x64 or arm64                                                                                                     | Release smoke test on one Intel and one Apple Silicon runner before broad customer support        |
| Browser UI       | Current and previous stable Chromium, Firefox, and Safari releases; keyboard and non-pointer interaction are required               | Browser matrix run against the built static client and the local export writer                    |
| Hosting          | Local Vite development/preview server for filesystem exports; any static host for conversion and preview without filesystem exports | HTTP 200, asset loading, WASM loading, and export behavior are checked separately                 |

The CI workflow currently proves Node 20 and 22 on Ubuntu and runs a Node 22
platform smoke on the latest Ubuntu, Windows, and macOS hosted runners.
Browser-version, high-DPI, and screen-reader qualification are still
release-checkpoint evidence requirements, not claims that can be inferred from
the local test run.

## Supported formats and guarantees

The authoritative feature disposition is [FORMAT_FEATURE_MATRIX.md](FORMAT_FEATURE_MATRIX.md).

- Inputs: GLB, glTF, FBX, OBJ, STL, PLY, Collada (`.dae`), and 3D Studio
  (`.3ds`).
- Outputs: FBX, GLB, glTF, OBJ, STL, PLY, and Collada (`.dae`).
- glTF and OBJ companion resources must be local files within the selected
  input directory and are subject to the path and aggregate-size limits below.
- Static mesh formats do not preserve skeletal or morph animation.
- A self-contained GLB or glTF input exported to GLB uses the scene-native
  exporter and retains the declared glTF attributes, camera/light extension
  data, morph slots, skin/inverse-bind structure, animation channel timing,
  names, supported extras, and hierarchy covered by the fidelity fixtures;
  multi-file glTF and non-glTF source imports remain importer-dependent and
  follow the matrix's partial dispositions.
- Draco and KTX2/Basis preprocessing, USD/USDZ, remote URLs, and arbitrary
  plugin formats are outside the contract.

## Limits

| Limit                          |                     Default or maximum | Configuration                      |
| ------------------------------ | -------------------------------------: | ---------------------------------- |
| Aggregate external input bytes |                        200 MiB default | `MODELSHIFT_MAX_FILE_MB`           |
| Browser export file bytes      |                          1 GiB default | `MODELSHIFT_MAX_EXPORT_MB`         |
| Input bundle file count        |                          4,096 maximum | Not configurable                   |
| Generated LOD levels           |                              8 maximum | `generateLODs` / `--generate-lods` |
| Explicit LOD targets           |                              8 maximum | `lodTriangleTargets`               |
| Detail pins                    |                            256 maximum | `detailPins`                       |
| Texture dimension option       |                             1–8,192 px | `maxTextureSize`                   |
| Triangle option                | 0–1,000,000,000; zero disables the cap | `maxTriangles` / `--max-triangles` |
| CLI parallel conversions       |                                    1–8 | `--parallel`                       |

Invalid, non-finite, overflowing, absolute, traversal, URL, and symlink-escape
inputs are rejected. The defaults are safety limits, not a promise that every
model at the limit will fit a particular machine's available memory.

## Public interface contract

- The package name is `modelshift`, with the Node engine requirement `>=20`.
- The public package export is the reusable core API. `convertGltfToFbx` remains
  a compatibility wrapper and defaults to FBX.
- The CLI executable is `modelshift`.
- Exit code `0` means all requested conversions succeeded; `1` means invalid or
  missing input; `2` means every conversion failed; `4` means partial success.
- Core conversion and optimization APIs accept an optional `AbortSignal`. The
  signal is honored cooperatively at phase boundaries and yields, returning a
  typed `AbortError`; native parser/export calls may finish their current
  synchronous operation before cancellation is observed.
- The CLI translates `SIGINT` and `SIGTERM` into cooperative cancellation,
  exits with status 130 after an interrupted operation, and does not commit
  partial output artifacts; hard process termination and native host signal
  delivery remain environment-dependent.
- CLI output is written atomically beneath the requested output directory.
- JSON sidecars and export responses contain conversion statistics and warnings
  but must not include source bytes, credentials, or host secrets.

## Privacy, network, and data handling

Conversion is local. ModelShift does not upload model data, require a remote
conversion service, or emit telemetry by default. The browser export endpoint
is a project-scoped local writer and must not be exposed as an internet-facing
upload service without a separate authentication and deployment review.

Temporary files are created beneath the selected output/export root and are
removed on failure. Operators must provide a writable directory with retention
and backup behavior appropriate to the sensitivity of the models being handled.

## Accessibility and interaction

The target is WCAG 2.2 AA-oriented behavior for the supported UI flows:
keyboard-operable controls, visible focus, modal dialog semantics, focus return,
Escape close, focus trapping, meaningful status/error text, and no workflow that
requires a pointer. Formal screen-reader and browser-matrix qualification is a
release checkpoint requirement.

## Production-debuggability and source maps

Production packages ship compiled runtime artifacts without source maps by
default. This avoids exposing repository paths and source comments in customer
distributions. CI retains test, manifest, SBOM, and benchmark evidence; if a
future support process needs source maps, they must be stored as access-controlled
release evidence rather than added to the public package without review.

## Ship/no-ship gates

The release candidate may ship only when:

1. No P0 or unresolved P1 findings remain.
2. `pnpm install --frozen-lockfile`, `pnpm audit --prod --audit-level=high`,
   `pnpm run sbom`, and `pnpm run release:check` pass on every required CI
   runtime.
3. The exact packed artifact passes installation, CLI smoke conversion, static
   browser loading, manifest verification, and rollback checks.
4. Fidelity, adversarial-input, performance, accessibility, and documentation
   evidence meets the declared thresholds in the linked quality documents.
5. Release Engineering, Security, and Product/Support record approval of any
   remaining accepted risks with an owner and review date.

## Compatibility and change policy

Patch releases may fix defects without changing the declared API or limits.
Minor releases may add formats or options while retaining existing defaults and
exit codes. Removing a supported format, changing output semantics, or lowering
a limit requires a migration note and a major-version decision.
