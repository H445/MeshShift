# Desktop and Portable Release Plan

## Goal

Produce installable MeshShift desktop releases and self-contained CLI archives
for GitHub Releases:

| Platform           | Desktop artifact                   | Portable CLI artifact | Architecture  |
| ------------------ | ---------------------------------- | --------------------- | ------------- |
| Windows 10/11      | NSIS `.exe` and portable `.zip`    | `.zip`                | x64           |
| macOS 13+          | `.dmg`                             | `.tar.gz`             | x64 and arm64 |
| Ubuntu 22.04/24.04 | `.AppImage` and fallback `.tar.gz` | `.tar.gz`             | x64           |

The Electron desktop application includes Electron's embedded Chromium and
Node.js runtimes. The portable CLI archives separately include an official
Node.js runtime and production dependencies. Neither surface requires users to
install Node.js, pnpm, or project dependencies.

Conversion remains local. Production builds must not upload model data, load
remote executable content, or enable telemetry by default.

## Release decisions

Use these decisions for the first production release unless an implementation
spike proves one unsuitable:

- Use Electron as the desktop host and `electron-builder` for installers.
- Distribute directly through GitHub Releases; app-store packages are out of
  scope for the first release.
- Publish separate macOS Intel and Apple Silicon DMGs instead of a universal
  binary. Revisit universal packaging only after both native builds are stable.
- Keep the npm package and the portable CLI independent from Electron.
- Do not enable automatic updates initially. Releases are manually downloaded,
  and the app may show only a non-intrusive link to the releases page if network
  access is explicitly approved later. Auto-update requires a separate design,
  signed update metadata, downgrade/rollback behavior, and privacy review.
  Do not generate or publish updater metadata such as `latest*.yml` until that
  design is approved.
- Unsigned packages may be used for internal prereleases. Public production
  Windows and macOS artifacts must be signed; macOS artifacts must also be
  notarized and stapled.
- Use explicit, supported runtime and runner versions rather than `latest`
  aliases in release jobs.

## Phase 0: Reconcile the existing release contract

Before adding Electron, align the repository's current release claims with the
toolchain used to build portable artifacts.

- Replace the current Node 20/22 release matrix with supported LTS lines. Node
  20 reached end of life in March 2026, so the expected migration is Node 22 and
  Node 24, including `engines`, TypeScript target decisions, documentation, and
  CI. Do not bundle an end-of-life Node runtime.
- Confirm that the selected Electron major still supports the declared minimum
  versions of Windows, macOS, and Linux. Record Electron, Chromium, and embedded
  Node versions in release evidence.
- Resolve package allowlist entries for repository files that do not currently
  exist (`SECURITY.md`, `SHIP_READINESS_PLAN.md`, and
  `SHIP_READINESS_REPORT.md`), either by adding the intended documents or
  removing stale entries.
- Define one source of truth for versioning. The Git tag, `package.json`,
  Electron application version, installer metadata, CLI `--version`, artifact
  names, and release title must match.
- Confirm the supported artifact matrix and whether the portable desktop ZIP
  on Windows is required in addition to NSIS.

Exit criterion: runtime versions, supported OS versions, artifact matrix, and
versioning rules are documented without contradictory claims.

## Phase 1: Build the Electron application boundary

### Main and renderer architecture

- Add dedicated Electron main-process and preload entry points, built separately
  from the existing reusable API and CLI.
- Continue using the Vite production renderer and browser worker conversion
  path so the conversion core is not duplicated.
- Serve packaged renderer files through a restricted custom standard/secure
  protocol rooted only at `dist/client`; do not grant broad `file://` access or
  set the custom protocol's `bypassCSP` privilege.
- Resolve packaged resources through `app.getAppPath()`/`process.resourcesPath`
  rather than the current working directory. Verify development, unpacked, and
  installed layouts independently.
- Preserve normal macOS application lifecycle behavior and support a single
  application instance. Decide whether opening model files from the shell/Finder
  is in scope; if enabled, validate all startup/open-file paths as untrusted.

### Export transport decision

The existing browser UI streams exports to a Vite-only HTTP middleware. That
middleware is not automatically present in an installed Electron application.
Run a short implementation spike and select one of these production designs:

1. A narrow, typed preload/IPC bridge that streams or transfers output without
   exposing raw Electron APIs.
2. A loopback-only server on an ephemeral port with an unguessable per-process
   token, strict origin/method checks, the existing size/path protections, and
   guaranteed shutdown.

Prefer IPC if it can handle the declared 1 GiB export ceiling without excessive
copying or renderer/main-process memory pressure. Do not select an approach
until large-file, cancellation, traversal, symlink, overwrite, and shutdown
tests pass. Keep the browser HTTP adapter available for the standalone web UI.

Desktop exports should use an explicit user-selected directory or a clearly
documented OS-appropriate default such as `Documents/MeshShift`. Do not write
inside the installed application, ASAR, repository, or opaque application-data
directory. Preserve the existing atomic-write and containment guarantees.

### Electron security baseline

- Set `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and
  leave `webSecurity` enabled.
- Expose only specific typed preload methods. Validate IPC sender/frame,
  argument types, sizes, paths, and operation state in the main process.
- Deny renderer permission requests by default. Block unapproved navigation,
  new windows, downloads, webviews, and external URL opening.
- Load no remote executable content. If external documentation links are
  allowed, validate parsed HTTPS origins against a small allowlist before using
  `shell.openExternal`.
- Add a restrictive Content Security Policy covering the exact needs of Vite
  chunks, workers, blobs, and WebAssembly.
- The current vendored Assimp Emscripten output contains generated
  `Function` constructors. The implementation keeps the wrapper local and
  records the exact CSP exception in `docs/THREAT_MODEL.md`; do not expand it
  to remote sources, and remove or re-review it when the vendored runtime can
  be rebuilt without dynamic execution.
- Prevent custom-protocol traversal and MIME confusion; map only known packaged
  paths and return safe response headers.
- Review and flip Electron fuses that are unnecessary, including disabling
  `RunAsNode`, node CLI inspection, and extra `file://` privileges where the
  selected Electron version supports it. Verify fuse values on packaged files.
- Disable remote crash uploads and telemetry. If local diagnostic logs are
  added, bound their size/retention, redact user model paths by default, and
  require an explicit user action before sharing them.
- Keep Electron current through an explicit maintenance cadence and automated
  dependency-update PRs; Electron carries its own Chromium and Node security
  lifecycle.
- Update `docs/THREAT_MODEL.md` for the main process, preload bridge, custom
  protocol, installer/updater boundary, signing credentials, and local export
  path.

Exit criterion: the packaged renderer has no direct Node access, its privileged
surface is enumerated and tested, and representative conversion/export works
without weakening the security baseline.

## Phase 2: Add desktop packaging

- Add pinned Electron, `electron-builder`, and any fuse/signing helpers as
  development dependencies under the lockfile.
- Keep desktop-specific build metadata in a dedicated configuration file where
  practical, including:
  - stable application ID and product name;
  - minimum OS versions and architecture targets;
  - ASAR and `extraResources`/unpack rules;
  - artifact naming;
  - protocol/file-association choices;
  - signing and notarization hooks;
  - publish provider metadata, without credentials.
- Include only the Electron main/preload output, `dist/client`, required WASM
  assets, licenses, notices, and production metadata. Explicitly exclude tests,
  source files, caches, `.env` files, fixtures not needed at runtime, and source
  maps unless retained separately as private evidence.
- Verify that `assimpjs.js`, `assimpjs.wasm`, worker chunks, `watlas` WASM, and
  lazy-loaded Vite chunks are present and resolvable after ASAR packaging.
- Produce proper source artwork and generated platform assets: multi-resolution
  Windows `.ico`, macOS `.icns`, and Linux PNG/icon/desktop metadata. Validate
  appearance at small and high-DPI sizes.
- Configure targets:
  - Windows x64: NSIS per-user installer and optional portable ZIP.
  - macOS: separate x64 and arm64 DMGs with consistent bundle identifiers.
  - Linux x64: AppImage built on the oldest supported Ubuntu runner, plus an
    unpacked/tar fallback for CI diagnosis and systems without FUSE.
- Define install/uninstall behavior, shortcuts, install scope, upgrade behavior,
  user-data retention, and whether uninstall removes settings. Never remove
  user exports during uninstall.
- Add application metadata visible in About/system dialogs: version, license,
  project URL, runtime versions, and a safe path to diagnostics.

### Local commands

Add scripts with stable names and no global-tool requirement:

- `desktop:dev`: run Vite and Electron together with clean shutdown.
- `desktop:build`: build renderer, main process, preload, and required assets.
- `desktop:package`: produce an unpacked current-platform app.
- `desktop:dist`: produce current-platform installers/archives.
- `desktop:verify`: inspect and smoke-test the packaged application.
- `release:desktop:check`: run desktop security, packaging, and runtime gates.

Exit criterion: developers can build and test an unsigned current-platform app
from a frozen install, and packaged resources work without the repository or a
globally installed Node runtime.

## Phase 3: Produce portable CLI bundles with Node included

Electron's embedded Node runtime should not be repurposed as the CLI runtime.
Build a separate portable folder for each supported architecture containing:

```text
meshshift-cli/
  meshshift.cmd or meshshift
  runtime/node.exe or runtime/bin/node
  app/dist/cli/meshshift.mjs
  app/dist/core/
  app/dist/vendor/assimpjs.js
  app/dist/vendor/assimpjs.wasm
  app/node_modules/          # production dependencies only
  LICENSE
  THIRD_PARTY_NOTICES.md
  README.txt
```

- Download the exact official Node LTS runtime for each target on its native
  runner and verify it against Node's published SHA-256 manifest before staging.
- Bundle one supported runtime line per archive, expected to be Node 24 LTS for
  the first release. Test the package/API against Node 22 and 24, but do not
  duplicate public archives by Node version unless customers require it.
- Bundle only production dependencies required by the externalized CLI build.
  Alternatively, make the CLI bundle fully self-contained first, but retain the
  WASM files as explicit resources and verify dynamic imports.
- Launch through a small platform script that resolves paths relative to itself
  and forwards arguments/exit codes/signals correctly.
- Preserve executable bits in tar archives and handle spaces and Unicode in the
  installation/input/output paths.
- Include the Node license and all redistributed dependency notices. Generate a
  CLI-specific SBOM that represents the runtime actually shipped.
- Smoke-test with system Node removed from `PATH`; invoke the bundled runtime
  directly and verify `--help`, `--version`, conversion, archive output, exit
  codes, and interruption behavior.

Exit criterion: every CLI archive runs on a clean supported host without Node
installed and reports the same MeshShift version as the desktop app.

## Phase 4: Create GitHub Actions workflows

Use separate workflows so pull-request validation never receives release
permissions or signing secrets.

### `.github/workflows/ci.yml`

- Trigger on pull requests and default-branch pushes, with path/branch filters
  only if they cannot skip a required release surface.
- Default to `permissions: contents: read` and grant no OIDC or release write
  access.
- Use a concurrency group that cancels superseded branch/PR runs.
- Run the supported Node matrix (expected Node 22 and 24) and the existing frozen
  install, typecheck, lint, formatting, test, build, package, fidelity,
  reliability, benchmark, interruption, documentation, and audit gates.
- Audit both shipped production dependencies and desktop build tooling; the
  existing production-only audit does not cover Electron/electron-builder when
  they are development dependencies.
- Add native platform jobs for Windows x64, Linux x64, macOS Intel, and macOS
  arm64. Avoid `latest` aliases in the release matrix; expected 2026 labels are
  `windows-2025` or `windows-2022`, `ubuntu-22.04`, `macos-15-intel`, and
  `macos-15`, subject to availability for the repository plan.
- Build an unpacked Electron app and portable CLI bundle on each relevant job.
- Run platform CLI and packaged-app smoke tests. Use Xvfb and an unpacked app or
  AppImage extraction on Linux where FUSE is unavailable.
- Upload test reports, manifests, and logs with a documented retention period.
  Logs must not contain model bytes, secrets, or unnecessarily identifying
  absolute paths.
- Cache only safe package-manager downloads keyed by OS, architecture, runtime,
  and lockfile; never cache signing material or final release output.

### `.github/workflows/release.yml`

- Trigger on protected version tags such as `v*` and allow manual dispatch only
  for an explicitly marked prerelease/recovery flow.
- Validate that the tag is an exact semantic match for `package.json`, points to
  the intended protected commit, and has not already been published.
- Re-run required gates against the exact tagged commit rather than trusting an
  earlier branch run alone.
- Use native architecture runners for all artifacts. Do not silently
  cross-compile a required artifact or substitute one architecture for another.
- Place signing/notarization and publication jobs behind a protected `release`
  environment with required reviewer approval and no self-approval where the
  repository plan supports it.
- Give build/test jobs `contents: read`. Give only the attestation job
  `id-token: write` and `attestations: write`, and only the publish job
  `contents: write`. Add `artifact-metadata: write` only if the repository
  intentionally uses GitHub's linked-artifacts feature.
- Pin all third-party and GitHub Actions to full commit SHAs, record the human
  readable versions in comments, and use dependency automation to update them.
- Use workflow concurrency keyed by tag and disable cancel-in-progress for an
  active production publication.
- Build, sign, notarize where applicable, and smoke-test the exact final files.
  Do not rebuild between verification and upload.
- Upload platform outputs as workflow artifacts, aggregate them in one final
  job, reject unexpected files/duplicate names, and verify every digest.
- Generate final SHA-256 checksums, SBOMs, internal manifests, and GitHub build
  provenance attestations for every public installer/archive.
- Create a draft GitHub Release only after all required platforms pass. Upload
  the complete set, download/verify it once, then publish the draft. Retries must
  be idempotent and must never replace an existing tagged asset silently.
- Retain the exact release evidence bundle independently of the public release:
  test reports, checksums, manifests, SBOMs, attestation identifiers, signing
  verification, runner images, tool versions, and approval record.
- Add Dependabot or equivalent updates for npm and GitHub Actions plus a
  scheduled, read-only security workflow. Define an owner and response target
  for Electron/Chromium, Node, packaging-tool, and production dependency
  security updates.

Suggested immutable artifact names:

```text
MeshShift-0.2.0-win-x64.exe
MeshShift-0.2.0-win-x64.zip
MeshShift-0.2.0-macos-x64.dmg
MeshShift-0.2.0-macos-arm64.dmg
MeshShift-0.2.0-linux-x64.AppImage
MeshShift-0.2.0-linux-x64.tar.gz
meshshift-0.2.0-cli-win-x64.zip
meshshift-0.2.0-cli-macos-x64.tar.gz
meshshift-0.2.0-cli-macos-arm64.tar.gz
meshshift-0.2.0-cli-linux-x64.tar.gz
meshshift-0.2.0-sbom.cdx.json
SHA256SUMS.txt
```

Exit criterion: a protected prerelease tag creates one complete, attested draft
release from native builds, and a reviewer can verify and publish it without
manually reconstructing artifacts.

## Phase 5: Signing and notarization

### Windows

- Select an Authenticode certificate or managed signing service compatible with
  GitHub-hosted runners.
- Sign application executables and the NSIS installer with timestamping.
- Verify signatures after packaging and again on downloaded release assets.
- Document that reputation-based SmartScreen prompts can persist for a new
  publisher even when a signature is valid; include a manual clean-machine
  checkpoint.

### macOS

- Use a Developer ID Application certificate for direct distribution, Hardened
  Runtime, and the minimum required main/helper entitlements.
- Store the certificate/API credentials only in protected environment secrets.
- Notarize both architectures, staple the ticket, and verify with `codesign`,
  `spctl`, and `stapler` before upload.
- Mount and launch the final DMG on the matching architecture. Confirm that
  Gatekeeper accepts the installed application and that no helper is unsigned.

### Linux and cross-platform integrity

- Publish SHA-256 checksums and GitHub provenance attestations for all files.
- Optionally add a project signing key for checksums/AppImage after defining key
  ownership, rotation, revocation, and offline backup policy.
- Scan final artifacts with the available platform malware tooling and retain
  results as release evidence; document expected false-positive handling.

Exit criterion: production Windows/macOS artifacts pass native signature checks,
macOS notarization works offline via stapling, and every artifact has a verified
checksum and provenance record.

## Phase 6: Verification matrix

### Automated tests

- Unit/integration tests for Electron lifecycle, protocol path mapping, preload
  API shape, sender validation, export limits, cancellation, and cleanup.
- Build-time assertions that no forbidden files, secrets, source maps, or raw
  Electron APIs are packaged.
- CSP tests proving that application resources, workers, and WASM load while
  unapproved network/script/navigation attempts fail.
- Architecture assertions for each executable/runtime and manifest completeness
  checks for every packaged asset.
- Desktop SBOM/license checks that include Electron, Chromium, embedded Node,
  the portable Node runtimes, and redistributed production dependencies.

### Packaged application smoke tests

Test the final installed/signed artifact, not only the development server:

- start with no separately installed Node.js;
- load JavaScript, CSS, worker chunks, Assimp WASM, and `watlas` WASM;
- open representative GLB and multi-file glTF/OBJ fixtures;
- convert at least one critical path to GLB and FBX;
- run optimization/LOD generation and preview interaction;
- export to a user-selected path and repeat/overwrite safely;
- cancel conversion/export and confirm no committed partial file remains;
- work offline and make no unexpected model-data or telemetry requests;
- close cleanly without orphaned server/helper processes;
- operate with spaces, Unicode, long paths/names, read-only destinations, and
  low-disk/error conditions;
- preserve accessibility behavior at supported zoom/DPI settings, keyboard-only
  operation, reduced motion, and the declared screen-reader checkpoints.

### Installer lifecycle tests

- clean install, first launch, normal relaunch, and uninstall;
- upgrade from the previous supported version while retaining settings/exports;
- define and test downgrade behavior or explicitly reject unsupported downgrade;
- install/launch as a non-administrator where supported;
- verify shortcuts, app metadata, icons, uninstall entries, and no unexpected
  files outside approved application/user-data locations;
- verify that uninstall never deletes user-created exports;
- measure artifact size, startup time, conversion performance, and memory
  against recorded desktop budgets.

Maintain a small deterministic test hook or automation harness that can launch
the packaged app, perform a fixture conversion, verify the output digest and
location, and exit. It must not expose privileged debug interfaces in production
or require disabling the Chromium sandbox.

Exit criterion: clean supported hosts can install, launch, convert, export,
upgrade, and uninstall safely, with retained evidence for every required OS and
architecture.

## Phase 7: Release evidence, licensing, and documentation

- Extend `dist/RELEASE-MANIFEST.json` or create a desktop manifest that hashes
  the exact packaged runtime inputs; separately hash each final installer/archive
  because signing and notarization modify outputs.
- Generate distinct desktop and portable-CLI SBOMs from staged shipping content,
  not only `pnpm list --prod` from the repository.
- Update `THIRD_PARTY_NOTICES.md` and packaged license material for Electron,
  Chromium, Node.js, Assimp, and all redistributed dependencies. Preserve any
  Electron/Chromium license files required in the application bundle.
- Add a desktop release approval record containing artifact digests, signatures,
  notarization IDs, attestation links, test evidence, accepted risks, owners,
  and expiry dates.
- Update:
  - `README.md` with GitHub download links and the platform matrix;
  - `docs/QUICK_START.md` and `docs/HOW_TO_USE.md` for desktop installation and
    the chosen export location;
  - `docs/CLI.md` for bundled-runtime archives and checksum verification;
  - `docs/ARCHITECTURE.md` for Electron/custom-protocol/export boundaries;
  - `docs/RELEASE_CONTRACT.md` for desktop support, signing, architectures, and
    runtime policy;
  - `docs/OPERATIONS_RUNBOOK.md` for tag controls, signing, publication,
    retention, incident response, and rollback;
  - `docs/BROWSER_COMPATIBILITY_MATRIX.md` with a separate Electron/Chromium
    qualification row rather than treating browser evidence as desktop evidence.
- Document installation, signature/checksum verification, offline behavior,
  export/data locations, log locations and redaction, uninstall behavior,
  known OS warnings, supported architectures, and manual update procedure.

Exit criterion: a user and release reviewer can independently install, verify,
operate, diagnose, and remove the application from the published documentation.

## Phase 8: Rollout and rollback

1. Build an unsigned Windows development package and complete the architecture
   and large-export spike.
2. Produce unsigned native prerelease packages on all required runners.
3. Add CI and packaged smoke tests until all platforms are stable.
4. Configure protected signing/notarization and validate final artifacts.
5. Publish a manually approved GitHub prerelease to a small test group.
6. Exercise install, upgrade, uninstall, and rollback from that exact release.
7. Promote a new, fully verified tag to the first production release; do not
   mutate the prerelease artifacts into production artifacts.

Rollback policy:

- Never overwrite a tag or release asset after publication.
- If a release is unsafe, mark it withdrawn, stop recommending its download,
  preserve evidence, publish impact/recovery guidance, and issue a higher patch
  version. Delete an asset only for active harm such as malware or leaked
  secrets, and record that exceptional action.
- Keep the last known-good signed installers and portable archives available.
- Because auto-update is initially disabled, rollback is a documented manual
  reinstall. Preserve user exports and define settings compatibility across the
  rollback boundary.

## Definition of done

- A protected version tag creates all required Windows, macOS, Linux, and
  portable CLI artifacts with exact version/architecture metadata.
- Public Windows artifacts are signed; public macOS artifacts are signed,
  notarized, and stapled.
- Each desktop artifact starts and converts without a separate Node install.
- Each portable CLI uses its bundled, supported Node runtime with system Node
  absent from `PATH`.
- Packaged workers and WASM load under the approved CSP with the documented,
  vendored-Assimp-only dynamic-execution exception tracked in the threat model.
- Clean-machine tests cover conversion/export plus install, upgrade, uninstall,
  cancellation, offline operation, and user-data preservation.
- CI blocks publication on a missing artifact, version mismatch, failed test,
  signature/notarization failure, checksum mismatch, SBOM/license failure, or
  missing provenance attestation.
- The exact uploaded assets are the assets that were signed and tested.
- Release assets have immutable names, SHA-256 checksums, retained evidence, and
  documented rollback.
- Documentation accurately states supported platforms, signing status, manual
  update policy, data/export locations, CLI alternatives, and known limitations.

## Official implementation references

- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron application distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution/)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron custom protocols](https://www.electronjs.org/docs/latest/api/protocol)
- [electron-builder macOS configuration](https://www.electron.build/mac/)
- [electron-builder notarization](https://www.electron.build/docs/notarization/)
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
