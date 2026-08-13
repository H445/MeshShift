# Operations and Release Runbook

MeshShift is primarily a local/offline product. Operations therefore focus on
release integrity, support diagnostics, safe filesystem behavior, and customer
recovery rather than a hosted conversion service.

## Role ownership

| Role                | Accountability                                                                  | Required action at release                                               |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Release Engineering | CI, package, manifest, SBOM, artifact retention, rollback                       | Approve all automated gates and retain the exact package/evidence bundle |
| Security            | Threat model, dependency audit, disclosure handling, provenance policy          | Approve security findings and supply-chain disposition                   |
| Product/QA          | Format contract, fidelity tolerances, compatibility matrix, performance budgets | Approve customer-facing quality and accepted residual risk               |
| Support/Operations  | Incident intake, redaction, customer recovery, monitoring thresholds            | Confirm escalation route and rollback readiness                          |

These are role owners because this repository does not encode a company's
personnel directory. Before shipping, the release record must map each role to a
named individual or team and include the approval timestamp.

## Release procedure

1. Freeze the release commit and record branch, commit, toolchain, lockfile,
   package version, and worktree status.
2. Run `pnpm install --frozen-lockfile`, `pnpm audit --prod
--audit-level=high`, `pnpm run sbom`, `pnpm run release:check`,
   `pnpm run test:report`, and `npm pack --dry-run --json`. After creating the
   exact archive, run `pnpm run packed-consumer:verify -- <archive>`. Retain
   the packed-consumer, reliability, and benchmark reports together.
3. Run the supported OS/browser qualification matrix and the representative
   workload benchmark. Attach test reports, the package, SBOM, manifest, and
   benchmark result to the release record.
4. Verify the packed package in a clean consumer directory, including CLI help,
   one conversion per supported critical path, and static client loading.
5. Complete `docs/RELEASE_APPROVAL_RECORD.md` for the exact candidate. On a
   protected push/tag, verify the retained package, SBOM, manifest,
   benchmark, and GitHub build-provenance attestation. Record approvals from
   Release Engineering, Security, Product/QA, and Support/Operations. Do not
   ship with an unresolved P0/P1 finding.

## Desktop release procedure

For a tagged desktop release, the GitHub Actions workflow builds on native
Windows, Linux, and macOS runners. It publishes only the Windows installer,
macOS DMGs, Linux AppImage and tarball, plus `SHA256SUMS.txt`. CLI archives are
intentionally not release assets; users who need the CLI can build the project
locally. The build matrix runs `pnpm run desktop:verify` before packaging and
the publish job adds GitHub artifact provenance.

Production tags should have the protected signing/notarization readiness
variables enabled and the corresponding repository secrets configured. Until
then, the workflow labels the release as a prerelease. Manual workflow dispatch
is reserved for explicitly labeled unsigned internal prereleases. Do not
promote an unsigned or unnotarized artifact to the public release channel.

Before approving a desktop release, install each native artifact on a clean
machine or VM, launch the app offline, import a representative fixture, export
to a user-writable destination, and confirm the app cannot write outside its
approved export root. Keep the installer logs, checksum file, provenance
record, and the exact workflow run with the release record.

## Incident handling

- **Incorrect or corrupt output:** preserve the smallest synthetic input and
  options, record source/output format and version, and stop distribution of the
  affected package until reproduced.
- **Security issue:** use the private reporting process in `SECURITY.md`; do not
  attach proprietary model data or secrets.
- **Disk/resource exhaustion:** stop the conversion process, remove only the
  temporary files under the configured output root, lower the configured limits,
  and retry with a smaller workload.
- **Operator interruption:** use Ctrl+C or send `SIGTERM` to request cooperative
  cancellation. The CLI exits with status 130 and does not commit the active
  job's partial output; a hard kill may bypass application cleanup and requires
  manual inspection of temporary files under the configured output root.
- **Unexpected network activity:** treat it as a release blocker, isolate the
  host, and verify the static client and vendored runtime against the release
  manifest.

## Support diagnostics and redaction

Support may request the following minimum diagnostic bundle:

- MeshShift version, release commit, operating system, architecture, Node.js
  version, and the exact CLI/API output format.
- Sanitized command-line flags or browser option values, excluding local paths
  that identify a customer or workspace.
- The machine-readable statistics sidecar and warning/error text, after review.
- A minimal synthetic or customer-approved fixture that reproduces the issue.
- The relevant release manifest, benchmark, test, or reliability evidence
  identifier rather than an entire customer workspace.

Never collect or attach source model bytes, textures, credentials, access
tokens, cookies, environment dumps, absolute customer paths, or unredacted
browser logs unless the customer has explicitly approved that specific data
transfer through the organization's secure support channel. Redact usernames,
hostnames, workspace names, URLs with query strings, and file names before
escalation. Security reports follow the private process in `SECURITY.md` and
must not be opened in a public issue tracker.

The escalation packet must identify the release version, severity, impact,
reproduction status, requested owner, and next review time. Support/Operations
owns customer communication and recovery; Security owns suspected data
exposure or supply-chain issues; Product/QA owns fidelity and compatibility;
Release Engineering owns artifact, CI, and rollback failures.

## Rollback

Rollback means withdrawing the package/version from the distribution channel
and restoring the last approved package whose manifest, SBOM, and release record
are available. The product has no central conversion database to migrate. Local
customer output files are not deleted automatically; support must provide a
separate, customer-approved cleanup procedure if needed.

## Watch items and thresholds

Until telemetry is intentionally added, health signals are manual:

- any P0/P1 report: immediate release freeze and Security/Product review;
- repeated conversion failures on a supported fixture or customer format:
  investigate within one business day;
- benchmark sample above its fixture ceiling: block the release until explained
  or the budget is formally revised;
- package manifest, SBOM, notice, or provenance mismatch: block distribution;
- accessibility regression in keyboard or dialog behavior: block the browser
  release until fixed and re-tested.
