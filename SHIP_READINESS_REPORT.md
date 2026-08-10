# ModelShift Ship-Readiness Evidence Report

Date: 2026-08-09

## Baseline identity

- Repository: `G:/Visual Studio/2026/gltf-to-fbx`
- Branch: `master`
- Base `HEAD`: `cccbb974fa0d81d33ab1b2cc46152c741fa8f164`
- Worktree: uncommitted changes are the audited candidate; the final release
  must be rebuilt from a frozen, approved commit.
- Host: Windows `10.0.26100.0`, AMD64
- Local toolchain: Node.js `v24.13.1`, npm `11.8.0`; the release contract is
  qualified on Node.js 20 and 22 through CI.
- Declared package manager: `pnpm@10.30.1`; the workstation Corepack cache is
  permission-restricted, while the hosted workflow installs the declared
  version explicitly.
- `pnpm-lock.yaml` SHA-256: `EA030C891DE9D81E4A4C024DB396F41CE50FC1EABED6D58F0694DA78A29C86E1`
- `package.json` SHA-256: `AEC03083296ED4E0EFB487B096186305ED821CAA60F59B2036127A55F2FA2BDA`
- The packed-consumer smoke is recorded in the evidence table; the exact
  candidate package hash belongs in the completed release approval record for
  the frozen release artifact, not inside the package that contains this
  report.

## Decision

**Conditional release readiness.** The implemented product changes and local release candidate pass the automated, security, CLI, static-browser, and interactive-browser checks listed below. Final enterprise sign-off still requires CI execution of the committed workflow and explicit approval of the residual policy items in the findings register.

## Implemented hardening

- Public conversion options now reject unsafe or non-finite values instead of silently clamping them.
- Input bundles enforce safe relative names, a 4,096-file cap, and bounded filename length.
- The browser’s direct-GLB preview path now enforces the same input-size limit as other conversion paths.
- CLI companion loading rejects URL resources, traversal, absolute paths, and symlink escapes outside the selected input directory.
- CLI output paths reject traversal, device names, symlinked parents, and unsafe targets; generated files are written atomically.
- Local export writes enforce configurable `Content-Length` and streaming limits and return `nosniff` JSON responses.
- Settings and Profiles now use real modal-dialog semantics with focus return, Escape handling, and keyboard focus trapping.
- Hidden settings panels no longer remain exposed in the accessibility tree.
- Release builds now emit and verify `dist/RELEASE-MANIFEST.json` with SHA-256 hashes for runtime and evidence documentation.
- Release checks now inspect the exact npm pack file list, enforce the declared package allowlist and size ceiling, require runtime/evidence files, and reject caches, fixtures, source, secrets, source maps, and editor material.
- CI now performs locked installation, production dependency audit, CycloneDX SBOM generation, machine-readable test reporting, artifact upload, performance-budget verification, and release gates on Node 20 and 22.
- CI now installs the pinned pnpm version before enabling setup-node caching and includes a Node 22 platform-smoke matrix for hosted Ubuntu, Windows, and macOS runners; hosted execution remains required evidence.
- Release gates now exercise eight concurrent conversions at the declared maximum batch concurrency and verify progress, success, bounded duration, and duplicate-output determinism.
- Native-output conversion of a single GLB or embedded glTF now derives metadata through the existing lightweight glTF inspector instead of performing a duplicate Assimp scene parse, reducing peak native memory on large models; self-contained glTF-to-GLB export uses the three.js exporter to retain tangents, colors, morph targets, cameras, lights, animations, skin/inverse-bind structure, names, supported extras, and hierarchy transforms that the native GLB writer did not round-trip.
- The rich-feature fidelity fixture now checks animation channel interpolation/timing, skin joints and inverse-bind accessors, camera/light extension retention, names, and custom metadata in addition to geometry attributes and transformed bounds.
- Browser queue rows now expose labeled progress bars and live status regions, and previously unlabeled batch/file controls have explicit accessible names.
- Local browser qualification now records 375×800, 768×1024, 1024×768, 1280×720 at device pixel ratio 1.25, and 1440×900 checks, plus a long/unusual filename conversion, in `docs/BROWSER_LOCAL_EVIDENCE.md`; cross-engine, zoom, and assistive-technology qualification remains external.
- The committed six-fixture corpus now has an automated FBX/GLB structural smoke: every fixture produces non-empty output with positive mesh/triangle counts and remains parseable through the bundled Assimp path; exact numerical golden tolerances and target-DCC qualification remain external.
- Fidelity invariants now compare each six-fixture source against its FBX re-import for mesh cardinality, face shape, attribute cardinality, finite vertex/normal/UV values, and triangle totals; exact golden tolerances and target-DCC qualification remain external.
- CLI companion-reference tests now cover missing, cyclic, malformed, remote, and embedded references without duplicate loads or unsafe filesystem access.
- A deterministic 64-case GLB mutation corpus now verifies that malformed parser inputs either fail as typed errors or produce non-empty output with finite statistics; broader parser corpora and OS-level interruption testing remain external.
- A reproducible six-fixture fidelity baseline now verifies exact source-to-GLB retention for declared animations, skinning, textures, and triangle counts, applies the documented bounding-box tolerance, and records FBX structural/attribute cardinality evidence without overstating known native-exporter losses.
- Benchmark evidence now records CLI startup probes, module-load latency, CPU time, input/output throughput, peak RSS/heap deltas, retained RSS/heap deltas, duration, and output size for every fixture.
- Release checks now verify documentation links, documented CLI help/version behavior, a CLI fixture conversion, and a core API fixture conversion against built release artifacts.
- Public conversion options now accept cooperative `AbortSignal` cancellation; aborted work returns a typed `AbortError` at phase boundaries, optimization and batch paths propagate cancellation, streamed exports clean up interrupted writes, and browser worker disposal terminates obsolete processing heaps.
- The CLI now translates `SIGINT`/`SIGTERM` into cooperative cancellation across companion loading, optimization, conversion, and atomic output writes; interrupted jobs exit with code 130 and do not commit partial artifacts.
- CLI ZIP packaging now checks cancellation before archive generation, after generation, and during the atomic archive commit; a regression test proves a cancelled archive never becomes a committed output.
- CLI and local export tests now reject a configured output root that is a regular file without overwriting its contents; true low-disk, OS permission, and native interruption qualification remain environment-specific.
- A release approval record template now captures candidate hashes, hosted evidence, residual-risk owners, rollback, and named role approvals.
- Push builds package the exact candidate and request GitHub OIDC build-provenance attestation.
- The push release-evidence job now installs and executes the exact uploaded `.tgz` through `packed-consumer:verify` and retains machine-readable consumer evidence.

## Evidence completed

| Area                                | Evidence                                                                                                                                                                                                           | Result                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type safety                         | `npm run typecheck`                                                                                                                                                                                                | Pass                                                                                                                                                                                                                      |
| Lint                                | `npm run lint`                                                                                                                                                                                                     | Pass                                                                                                                                                                                                                      |
| Formatting                          | `npm run format:check`                                                                                                                                                                                             | Pass                                                                                                                                                                                                                      |
| Automated tests                     | 21 files, 177 tests via `npm test`                                                                                                                                                                                 | Pass                                                                                                                                                                                                                      |
| Production build                    | `npm run build`                                                                                                                                                                                                    | Pass                                                                                                                                                                                                                      |
| Release artifacts                   | `npm run verify:release`                                                                                                                                                                                           | Pass; 23 hashed runtime/documentation artifacts plus the manifest                                                                                                                                                         |
| Full local release gate             | `npm run release:check`                                                                                                                                                                                            | Pass; includes fidelity, benchmark, and budget verification                                                                                                                                                               |
| Package contents                    | `npm run verify:package` plus `npm pack --ignore-scripts --pack-destination <isolated release directory>`                                                                                                          | Pass; 39 package entries, 11.7 MB unpacked, allowlist/forbidden-material gate passed                                                                                                                                      |
| Clean dependency install            | Frozen pnpm 10.30.1 install in an isolated directory, offline                                                                                                                                                      | Pass; 211 packages                                                                                                                                                                                                        |
| Production dependency audit         | pnpm audit, `--prod --audit-level high`                                                                                                                                                                            | No known vulnerabilities                                                                                                                                                                                                  |
| SBOM                                | `npm run sbom` with the pinned pnpm runtime override on this Windows host                                                                                                                                          | Pass; CycloneDX 1.5, 18 production components, 20 dependency relationships; hosted CI uses the declared pnpm 10.30.1 workflow path                                                                                        |
| Packed consumer                     | Isolated consumer install of the exact `modelshift-0.2.0.tgz`, CLI help/version, and GLB smoke conversion                                                                                                          | Pass; hosted release evidence now runs `packed-consumer:verify` and retains a machine-readable report                                                                                                                     |
| Current packed candidate            | Final `npm pack --ignore-scripts` candidate, CLI help, cube GLB→FBX conversion, and JSON sidecar validation                                                                                                        | Pass; 17,232-byte FBX, 12 triangles, finite positive statistics                                                                                                                                                           |
| Built CLI                           | `node dist/cli/modelshift.mjs --help` and GLB smoke conversion                                                                                                                                                     | Pass                                                                                                                                                                                                                      |
| Static browser deployment           | Built preview returned HTTP 200 with title and asset references                                                                                                                                                    | Pass                                                                                                                                                                                                                      |
| Browser user flow                   | Codex in-app browser at 1280x720, device pixel ratio 1.25: file chooser upload, preview, optimized preview, and Convert all flow for `cube.glb`                                                                    | Pass; `exports/cube.fbx` saved at 100%, zero console errors                                                                                                                                                               |
| Browser warning/recovery            | Same in-app browser: unsupported `README.md` selection plus malformed supported `browser-invalid.glb` error/retry, followed by valid `cube.glb` selection                                                          | Pass; warning and Error/Retry states were actionable, failed row remained isolated, valid work stayed queued, zero browser console errors                                                                                 |
| Browser state and queue             | In-app browser: settings/profile reload persistence, queue conversion/retry controls, accessible progress/status regions, two-file queue, master selection, global LOD selection, and batch conversion             | Pass; values persisted across reload, queue conversion reached Done/100%, unsupported input recovered without queue mutation, zero browser errors                                                                         |
| Local viewport and filename matrix  | `docs/BROWSER_LOCAL_EVIDENCE.md`                                                                                                                                                                                   | Pass; 375×800, 768×1024, 1024×768, 1280×720 at DPR 1.25, and 1440×900 showed no horizontal overflow; long/unusual filename converted to Done/100%; cross-engine, zoom, and assistive-technology coverage remains external |
| Dialog accessibility behavior       | Hidden dialogs absent from DOM accessibility snapshot; focus return and keyboard trap verified                                                                                                                     | Pass                                                                                                                                                                                                                      |
| Browser compatibility contract      | Versioned desktop engine/OS/screen-reader matrix                                                                                                                                                                   | Chromium-style local flow pass; external matrix remains a checkpoint                                                                                                                                                      |
| Performance baseline                | `npm run benchmark` + `npm run benchmark:verify`                                                                                                                                                                   | Pass; 8 fixtures, 3 samples each; records duration, CPU, input/output throughput, peak/retained memory, startup probes, and output size                                                                                   |
| Maximum-local workload              | `generated-maximum-sphere.glb`, 3 samples on Node 24.13.1 / Windows x64                                                                                                                                            | Pass; 1,048,576 triangles, 121.7 MiB output, and latest samples within the 45 s, 2 GiB RSS, and 512 MiB heap ceilings                                                                                                     |
| Reliability/concurrency             | `npm run reliability` + `npm run reliability:verify`                                                                                                                                                               | Pass; 8 conversions at concurrency 8, bounded progress and duplicate digests                                                                                                                                              |
| Determinism                         | Repeated FBX, glTF bundle, and optimized GLB outputs                                                                                                                                                               | Pass; byte-identical under identical runtime/options                                                                                                                                                                      |
| Path and resource safety            | Dedicated CLI/export-server tests plus malformed-input tests                                                                                                                                                       | Pass                                                                                                                                                                                                                      |
| Reference corpus                    | Missing, cyclic, malformed, remote, and embedded companion-reference fixtures                                                                                                                                      | Pass; missing/remote/malformed resources are skipped safely, cyclic references terminate without duplicate loads                                                                                                          |
| Fidelity invariants                 | Six-fixture source-to-FBX re-import comparison                                                                                                                                                                     | Pass; topology/attribute cardinality, finite vertex/normal/UV values, and triangle totals remain stable                                                                                                                   |
| Fidelity baseline                   | `npm run fidelity` + `npm run fidelity:verify`                                                                                                                                                                     | Pass; six fixtures, exact source-to-GLB feature retention, `1e-3` bounding-box tolerance, and FBX structural evidence                                                                                                     |
| Rich feature fixture                | Synthetic self-contained glTF with colors, tangents, morph targets, material alpha, camera/light extension, transformed hierarchy, names, and extras; animated/skinned fixtures add timing and inverse-bind checks | Pass; GLB output retains the locally supported structures and world-space bounds                                                                                                                                          |
| Documentation examples              | `npm run verify:docs` against built CLI/core artifacts                                                                                                                                                             | Pass; links, CLI help/version/conversion, and public API conversion verified                                                                                                                                              |
| Unwritable output roots             | CLI output and local export roots replaced with regular-file markers                                                                                                                                               | Pass; operations fail without overwriting the marker or leaving a partial target                                                                                                                                          |
| Cancellation and interrupted writes | Public conversion/optimization/batch cancellation, CLI signal propagation, streamed export interruption, packaging cancellation, and atomic output cleanup tests                                                   | Pass; typed cancellation failures, CLI interruption verification, archive cancellation, and temporary-file cleanup are verified; native host delivery, SIGKILL, and package-process interruption remain external          |
| Reduced-motion and responsive UI    | Static reduced-motion contract plus in-app browser at 375×800 keyboard workflow                                                                                                                                    | Pass; auto-rotation is disabled for reduced-motion users, responsive queue/panes and modal Escape/focus recovery verified                                                                                                 |
| Support diagnostics                 | `docs/OPERATIONS_RUNBOOK.md` role ownership, diagnostic bundle, redaction, and escalation rules                                                                                                                    | Pass; named personnel and approval routing remain external                                                                                                                                                                |

## Known non-fatal diagnostics

The self-contained GLB exporter emits the following three.js diagnostics for
some fixture inputs during local tests and release evidence generation:

- `THREE.GLTFExporter: Creating normalized normal attribute from the non-normalized one.`
- `THREE.InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave buffer data.`

These are expected library-level normalization/de-interleaving notices, not
conversion failures. The affected outputs pass the feature, structural,
bounding-box, and deterministic checks, and the browser workflow records zero
console errors. They remain a P2 observability/polish follow-up before claiming
zero-warning target-DCC qualification.

## Findings register

The risk-ordered action handoff is maintained in
[docs/REMEDIATION_PLAN.md](docs/REMEDIATION_PLAN.md). It is a draft until the
named release roles complete the approval record.

### P1 — Hosted CI and provenance sign-off remain required

The committed workflow must pass on a real CI runner, including pnpm 10.30.1 locked installation, production dependency audit, SBOM generation, Node 20/22 release gates, package/evidence retention, and the push-build OIDC provenance attestation. Local equivalents and the workflow definition pass static/local checks, but hosted CI execution is external evidence not available in this workspace.

### P2 — Golden fidelity and target-DCC qualification

The repository now has a format/feature disposition, structural invariants,
round-trip checks, deterministic-output checks, and a six-fixture FBX/GLB
corpus. Exact numerical golden comparisons for the declared geometry,
transform, animation, skinning, material, and optimization tolerances, plus
qualification in each customer target DCC, still require representative
customer fixtures and Product/QA approval.

### P2 — Broader parser corpus and interruption qualification

The deterministic 64-case mutation corpus, path/reference tests, resource
limits, atomic-write tests, and cooperative cancellation-boundary tests cover
the locally reproducible release surfaces. A broader format/parser corpus and
OS-level interruption tests during parsing,
optimization, conversion, packaging, and export still require a dedicated
qualification environment.

### P2 — Broader compatibility evidence

The interactive browser check used the Codex in-app browser and the local preview server. A formal customer matrix still needs declared and tested browser versions, operating systems, viewport sizes, high-DPI behavior, screen-reader behavior, and non-pointer interaction.

### P2 — Maximum-workload performance evidence

Correctness and resource safeguards are covered by the tests, limits, generated 65k-triangle workload, and generated 1M-triangle maximum-local workload with executable duration, peak/retained memory, CPU, throughput, startup, and output measurements. Enterprise release approval should still attach repeatable measurements on target customer hardware and under low-resource conditions.

### P2 — Release provenance policy execution

The deterministic release manifest, CI SBOM, and push-only OIDC attestation job are configured. Hosted execution and repository policy must confirm that the resulting attestation is retained and verifiable before claiming a fully signed enterprise release.

### P2 — Operational ownership

Security reporting, limits, and release checks are documented. A named support owner, incident escalation rota, rollback owner, and post-release monitoring thresholds still require organizational assignment.

## CI and release usage

```sh
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=high
pnpm run sbom
pnpm run release:check
pnpm run test:report
```

The generated SBOM is written to `artifacts/sbom.cdx.json`, the machine-readable
test report to `artifacts/test-results.json`, and the benchmark report to
`artifacts/benchmark-baseline.json`; these are intentionally ignored from source
control and uploaded by CI. The release manifest is generated into `dist/` and
is included in the packed package. Push builds also request OIDC build-provenance
attestation for the exact `.tgz` candidate.

On this Windows workstation, the system Corepack cache is permission-restricted;
the local SBOM run therefore supplied the bundled pnpm executable explicitly.
This is a workstation limitation, not a release-policy exception: the committed
workflow installs and runs the declared pnpm 10.30.1 toolchain on hosted runners.
After the report update, a second local `npm run sbom` attempt was also blocked
before dependency traversal by the same Corepack-cache `EPERM`; it is not
counted as a fresh SBOM pass. The recorded SBOM remains valid for the unchanged
production dependency graph, and hosted CI must regenerate and retain the
candidate-specific SBOM.
