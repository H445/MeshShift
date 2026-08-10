# ModelShift Enterprise Ship-Readiness Plan

## Purpose

Establish whether ModelShift is ready for an enterprise-grade release using measurable, evidence-backed quality gates. This plan separates audit work from remediation: implementation changes begin only after findings, priorities, and acceptance criteria are reviewed.

## Status

- Planning: complete
- Audit execution: substantially complete; see [SHIP_READINESS_REPORT.md](SHIP_READINESS_REPORT.md)
- Remediation: implemented for validated product and release-surface findings
- Release-candidate verification: local candidate passed; CI and organizational sign-off remain

## Current evidence

The implementation has passed the local typecheck, lint, formatting, 177-test suite, production build, release-artifact verification, clean frozen pnpm installation, production dependency audit, SBOM generation, CLI smoke test, static preview test, interactive browser workflow, deterministic-output checks, six-fixture fidelity verification, eight-fixture budget verification including the generated 1M-triangle maximum-local workload, CLI interruption verification, packaging cancellation verification, and packed-consumer smoke test. Remaining gates are explicitly listed in the findings register of [SHIP_READINESS_REPORT.md](SHIP_READINESS_REPORT.md).

## Execution status

The checklist below remains the governing acceptance contract. `[x]` means the
current repository contains evidence for the item; `[ ]` means the item is not
fully evidenced locally or requires an external owner approval. A checked item
does not waive the formal ship-readiness checkpoint.

| Phase                               | Status                        | Current disposition                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Release contract                 | Partial                       | Runtime/OS/browser scope, formats, limits, API semantics, privacy, tolerances, accessibility target, and ship gates are documented; formal approval remains open.                                                                                                                                                                                      |
| 2. Clean baseline                   | Verified locally              | Typecheck, lint, formatting, 177 tests, build, package dry-run, clean frozen install, hashes, SBOM, audit, and benchmark evidence pass; hosted Node 22 Ubuntu/Windows/macOS smoke is now configured.                                                                                                                                                   |
| 3. Conversion fidelity              | Partial                       | Format/feature disposition, round-trip, optimization, camera/light, morph, skin/inverse-bind, animation timing, names/metadata, LOD, texture, invariant, deterministic tests, and six-fixture FBX/GLB corpus smoke pass; exact golden tolerances and partial-feature DCC qualification remain.                                                         |
| 4. Malformed/adversarial inputs     | Verified for release surfaces | Bounds, path safety, malformed options, resource limits, export limits, atomic writes, interrupted-stream cleanup, missing/cyclic/malformed/remote reference handling, conversion/optimization/batch cancellation boundaries, and a deterministic 64-case mutation corpus are covered; broader parser-corpus and OS-level interruption testing remain. |
| 5. Security, privacy, supply chain  | Partial                       | Threat model, dependency audit, notices, SBOM, manifest, OIDC provenance workflow, and local security controls are documented; hosted attestation/sign-off remains open.                                                                                                                                                                               |
| 6. Reliability/performance          | Partial                       | Small, large-textured, generated 65k-triangle, and generated 1M-triangle maximum-local baselines now record executable duration, peak/retained memory, CPU, throughput, startup, output, and reliability evidence; customer-hardware and low-resource qualification remain.                                                                            |
| 7. CLI/browser polish               | Verified locally              | CLI smoke conversion, static deployment, file-upload conversion, persisted settings/profiles, multi-file queue/LOD selection, modal keyboard behavior, focus management, and accessibility-tree checks pass; cross-browser/AT matrix remains.                                                                                                          |
| 8. Distribution/release engineering | Verified locally              | Release manifest, package metadata, automated package-content allowlist, documentation artifacts, CI workflow, package dry-run, and isolated packed-consumer install/smoke pass; hosted run/rollback approval remain.                                                                                                                                  |
| 9. Documentation/operations         | Partial                       | README, changelog, contract, matrix, security, threat, quality, browser, runbook, notices, and release evidence are documented; named personnel mapping remains.                                                                                                                                                                                       |
| 10. Findings register               | Verified                      | Findings and residual risks are recorded in [SHIP_READINESS_REPORT.md](SHIP_READINESS_REPORT.md).                                                                                                                                                                                                                                                      |
| 11. Ship-readiness checkpoint       | Pending approval              | Requires formal review of the release contract and explicit disposition of the remaining P1/P2 items.                                                                                                                                                                                                                                                  |
| 12. Release candidate               | Local pass                    | The local candidate passes; hosted CI execution and organizational sign-off are still required for an enterprise ship decision.                                                                                                                                                                                                                        |

## Operating principles

- Replace subjective goals such as "perfect precision" with declared numerical tolerances and repeatable tests.
- Treat every release claim as something that must be supported by recorded evidence.
- Surface inexpensive, high-impact blockers before beginning expensive deep testing.
- Preserve customer data, privacy, and offline-operation claims throughout testing and operation.
- Separate release blockers, required fixes, polish, and explicitly accepted residual risk.
- Verify the final release candidate independently from a clean environment.

## Phase 1: Define the release contract

- [x] Declare supported operating systems, CPU architectures, Node.js versions, and browsers.
- [x] Declare supported input/output formats and the supported feature subset for each format.
- [x] Define practical limits for file size, scene complexity, texture size, animation count, and batch size.
- [x] Identify the supported public API, CLI commands, flags, exit codes, package exports, and compatibility guarantees.
- [x] Document offline-operation, privacy, telemetry, and network-access guarantees.
- [x] Define numerical tolerances for geometry, transforms, animation, skinning, materials, and optimization results.
- [x] Select the accessibility target and supported interaction modes.
- [x] Define measurable ship/no-ship thresholds for correctness, security, reliability, performance, accessibility, packaging, and documentation.

**Exit criteria:** The release scope and all acceptance gates are documented and approved before audit results are judged.

## Phase 2: Capture a clean baseline

- [x] Record the commit, branch, worktree state, toolchain versions, and relevant environment details.
- [x] Verify lockfile integrity and perform a clean dependency installation using the declared package manager.
- [x] Run type checking, linting, formatting checks, tests, and the complete release build.
- [x] Build all distributable surfaces: core package, CLI, browser application, WASM/vendor assets, and static output.
- [x] Inspect package contents and validate installation and execution from the packed artifact.
- [x] Inventory release artifacts and record sizes and cryptographic hashes.
- [x] Capture current startup, bundle-size, memory, and representative conversion-performance baselines.
- [x] Record every failure or warning without making implementation changes.

**Exit criteria:** A reproducible baseline report exists, with failures and environmental assumptions clearly recorded.

## Phase 3: Audit conversion fidelity

- [x] Create a format-by-feature coverage matrix.
- [x] Verify topology, indices, vertex attributes, normals, tangents, colors, and primitive modes for the self-contained GLB/glTF path; other importer paths remain dispositioned as partial.
- [x] Verify transforms and hierarchy for the self-contained GLB/glTF path; pivots, coordinate systems, handedness, axes, and units remain target-DCC qualification items.
- [x] Verify UV sets, materials, embedded textures, color/alpha properties, and sampler retention for the self-contained GLB/glTF path; external-resource and importer-specific behavior remains partial.
- [x] Verify cameras, lights, morph targets, skinning, inverse bind matrices, animation channels, interpolation, and timing for the self-contained glTF/GLB path; other importer paths remain partial.
- [x] Verify LOD selection, simplification, texture baking, optimization, and cache behavior.
- [x] Verify names, custom metadata, and the supported `KHR_lights_punctual` extension for the self-contained glTF/GLB path; other extensions and importer paths remain partial.
- [x] Use six committed fixtures plus a synthetic rich-feature fixture, round-trip checks, structural invariants, and the documented `1e-5`/`1e-4`/`1e-3` numerical tolerances; customer golden fixtures and target-DCC approval remain external.
- [x] Confirm whether identical inputs and options produce deterministic artifacts or document permitted variance.

**Exit criteria:** Every supported format/feature combination has a disposition, evidence, and declared tolerance; no unexplained data loss remains.

## Phase 4: Audit malformed and adversarial inputs

- [x] Test empty, truncated, corrupt, and structurally invalid files.
- [x] Test missing, cyclic, malformed, and remote resource references.
- [x] Test unsupported formats, extensions, encodings, and feature combinations.
- [x] Test extreme element counts, dimensions, nesting, animation duration, and texture sizes.
- [x] Assess archive expansion limits, decompression bombs, and excessive compression ratios; archive-input handling is outside the declared input contract.
- [x] Test path traversal, absolute paths, reserved names, invalid characters, and filename collisions.
- [ ] Test cancellation and interruption during parsing, optimization, conversion, packaging, and export.
- [x] Verify cooperative cancellation at public API phase boundaries and worker lifecycle termination; native/OS-level interruption remains a separate qualification gate.
- [x] Verify optimization, batch, streamed-export, and CLI ZIP-packaging cancellation/interrupt cleanup; native parser, package-process, and OS-level interruption remain separate qualification gates.
- [x] Verify CLI `SIGINT`/`SIGTERM` propagation through input loading, optimization, conversion, atomic output writes, and archive generation/commit; hard process termination and native host delivery remain separate qualification gates.
- [x] Verify atomic output behavior and cleanup of temporary or partial artifacts.
- [x] Confirm errors are stable, actionable, appropriately scoped, and free of sensitive data.

**Exit criteria:** Untrusted inputs cannot escape intended boundaries, silently corrupt output, or cause uncontrolled resource use within declared limits.

## Phase 5: Audit security, privacy, and supply chain

- [x] Produce a threat model for CLI, browser UI, development/export middleware, workers, WASM, file handling, and package distribution.
- [x] Review trust boundaries and browser/server separation.
- [x] Verify the source, version, integrity, license, and update process for WASM and vendored assets.
- [x] Audit direct and transitive dependencies for vulnerabilities, maintenance risk, and licensing obligations.
- [x] Generate and validate a software bill of materials.
- [x] Search release inputs and artifacts for secrets, credentials, development paths, and sensitive diagnostics.
- [x] Verify all network behavior against the documented offline and privacy stance.
- [x] Review path handling, temporary storage, output permissions, denial-of-service controls, and resource limits.
- [x] Define release provenance, artifact signing, verification, and dependency-update expectations.

**Exit criteria:** No unresolved critical/high security exposure exists; supply-chain and privacy claims are backed by evidence.

## Phase 6: Audit reliability and performance

- [x] Define representative small, medium, large, and maximum-supported workloads.
- [x] Measure peak memory, retained memory, CPU time, throughput, startup latency, and output size.
- [x] Exercise repeated conversions to detect leaks, stale state, and nondeterministic failures.
- [x] Exercise concurrency, queues, workers, cancellation, retry behavior, and application shutdown.
- [x] Verify cache keys, invalidation, corruption handling, concurrency safety, and storage bounds.
- [ ] Test low-memory, low-disk, permission-denied, and interrupted-write conditions.
- [x] Verify deterministic unwritable-root rejection without overwriting existing marker files; low-memory, true low-disk, OS permission, and interruption qualification remain external.
- [x] Verify the generated maximum-local workload and bounded RSS/heap/output budgets; customer hardware and true low-resource qualification remain external.
- [x] Establish explicit performance budgets and regression thresholds.
- [x] Repeat measurements enough to distinguish regressions from normal variance.

**Exit criteria:** Supported workloads remain within declared resource budgets and recover cleanly from expected failures.

## Phase 7: Audit CLI and browser polish

- [x] Review command names, help output, examples, defaults, option precedence, validation, and exit codes.
- [x] Verify progress, cancellation, batch summaries, warning visibility, and machine-readable behavior where promised.
- [x] Review empty, loading, processing, success, warning, error, and recovery states in the local Chromium workflow; formal cross-browser state coverage remains external.
- [x] Verify queue behavior, settings, profiles, LOD controls, preview navigation, export flow, and persisted state in the local Chromium workflow; formal cross-browser coverage remains external.
- [x] Test keyboard navigation, focus order, focus visibility, semantic labels, reduced motion, and non-pointer use in the local Chromium workflow; formal screen-reader, contrast, zoom, and cross-browser qualification remain external.
- [ ] Test supported browsers, viewport sizes, high-DPI displays, and long or unusual filenames.
- [x] Standardize terminology, punctuation, capitalization, units, error language, and destructive-action confirmation across the README, UI, CLI, and release contract; targeted wording drift was corrected and regression checks cover the public markup contract.
- [x] Ensure failures provide a clear recovery path without losing unrelated work; malformed-input Error/Retry and an independent valid queue item were verified locally.
- [x] Verify locally: unsupported-input warning/recovery, malformed-input error/retry recovery, persisted settings/profiles, multi-file queue selection, global LOD selection, and successful batch conversion; unrelated queued work remains intact after a failed item.
- [x] Verify locally: queue status/progress live regions, labeled file/batch controls, modal focus recovery, successful conversion, and unsupported-input recovery; formal screen-reader, contrast, zoom, and cross-browser qualification remain external.

**Exit criteria:** Supported workflows are consistent, accessible to the declared target, and recoverable without specialist knowledge.

## Phase 8: Audit distribution and release engineering

- [x] Validate package name, version, metadata, exports, type declarations, engine constraints, executable path, and included files.
- [x] Install and exercise the packed package in a clean consumer project.
- [x] Validate static browser deployment from supported paths and hosts, including asset and WASM loading.
- [x] Verify release artifacts contain no test fixtures, caches, local exports, editor files, secrets, or unintended source material.
- [x] Define source-map and production-debuggability policy.
- [x] Assess build reproducibility and explain any unavoidable nondeterminism.
- [x] Define required CI checks, protected release gates, artifact retention, and provenance records.
- [x] Verify semantic versioning, changelog, migration guidance, compatibility promises, rollback procedure, and release ownership.

**Exit criteria:** A clean environment can install and run the exact release artifacts, and the release process is repeatable and reversible.

## Phase 9: Audit documentation and operations

- [x] Validate quick starts for the CLI, browser UI, and core API.
- [x] Publish an accurate format/feature support table and known limitations.
- [x] Document precision guarantees, lossy transformations, optimization tradeoffs, and deterministic-output expectations.
- [x] Verify all examples and troubleshooting instructions against release artifacts.
- [x] Document security reporting, dependency disclosure, licensing, and third-party notices.
- [x] Define role-based support ownership, escalation paths, diagnostic collection, data-redaction rules, and incident response; named personnel mapping remains a release-approval gate.
- [x] Define privacy-compatible post-release health signals and manual verification where telemetry is intentionally absent.
- [x] Prepare release notes, known issues, rollback instructions, and customer-facing upgrade guidance.

**Exit criteria:** Customers and support staff can install, operate, diagnose, and recover the product using current documentation.

## Phase 10: Produce the findings register

For every finding, record:

- Severity and confidence
- Affected component and supported scenario
- Evidence and reproduction steps
- Customer, security, operational, and business impact
- Root cause or bounded hypothesis
- Proposed remediation
- Verification method and acceptance criteria
- Owner and target milestone
- Release disposition
- Residual risk and approval, when applicable

### Severity model

- **P0 — Stop immediately:** Active data loss, critical security exposure, release artifact compromise, or systemic unusability.
- **P1 — Release blocker:** Supported behavior is incorrect, unsafe, materially unreliable, inaccessible against the declared target, or impossible to operate/support.
- **P2 — Polish/follow-up:** Meaningful quality improvement that does not violate an approved release gate.
- **Accepted risk:** Explicitly documented residual risk with rationale, owner, expiry/review date, and approval.

**Exit criteria:** All findings are deduplicated, evidence-backed, prioritized, owned, and assigned a release disposition.

## Phase 11: Hold the ship-readiness checkpoint

- [ ] Review release-contract compliance and the complete findings register.
- [ ] Confirm every P0 and P1 finding is a release blocker unless formally reclassified with evidence.
- [ ] Approve, reject, or time-box accepted risks.
- [ ] Create a separate remediation plan ordered by risk and dependency: P0, P1, then approved P2 polish.
- [ ] Freeze acceptance criteria before implementation begins.

**Exit criteria:** Remediation scope and acceptance criteria are approved; the audit record remains unchanged except for traceable status updates.

## Phase 12: Verify the release candidate

- [ ] Build from the approved commit in a clean environment using the declared toolchain.
- [x] Repeat all release gates against the exact candidate artifacts.
- [x] Re-test fixed findings and targeted regression surfaces.
- [ ] Confirm package installation, CLI execution, static deployment, artifact integrity, documentation, and rollback procedure.
- [x] Record known issues, residual risks, approvals, artifact hashes, and evidence locations.
- [ ] Issue a final ship/no-ship decision.
- [ ] Define post-release watch items, owners, thresholds, and escalation actions.

**Exit criteria:** The exact candidate artifacts satisfy every mandatory gate, with no unresolved P0/P1 findings and all residual risks explicitly approved.

## Execution order

1. Complete Phase 1 before judging any audit result.
2. Complete Phase 2 before deep audit work begins.
3. Run Phases 3 through 9 in parallel where staffing permits.
4. Consolidate results in Phase 10.
5. Obtain authorization at Phase 11 before modifying implementation.
6. Complete independent release-candidate verification in Phase 12.

## Required final deliverables

- Release contract and compatibility matrix
- Baseline evidence report
- Format/feature fidelity matrix
- Security threat model, dependency review, and SBOM
- Reliability and performance report with budgets
- UX and accessibility audit report
- Distribution and release-engineering report
- Documentation and operations readiness report
- Prioritized findings register
- Approved remediation plan
- Release-candidate verification report
- Risk-ordered remediation plan with dependency, owner, evidence, and release disposition
- Final ship/no-ship decision and rollback plan
