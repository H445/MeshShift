# ModelShift Risk-Ordered Remediation Plan

Status: **Draft — not approved**

This document turns the findings in
[SHIP_READINESS_REPORT.md](../SHIP_READINESS_REPORT.md) into an ordered
qualification and approval handoff. It does not waive a release gate. A row is
complete only when its evidence is attached to the release record and the
named role accepts the disposition.

## Release rules

- No P0 finding is currently recorded. Any newly discovered P0 stops release
  work immediately.
- Every P1 is a release blocker unless the Release Engineering, Security, and
  Product/QA roles formally reclassify it with evidence and an expiry date.
- P2 work may ship only as an explicitly accepted residual risk with an owner,
  review date, customer impact statement, and rollback/recovery path.
- The exact candidate is defined by one approved commit/tag, one package
  archive, one release manifest, one SBOM, and one retained evidence bundle.

## Ordered work

| Order | Priority | Finding / work item | Dependency | Required action and evidence | Owner role | Release disposition |
| ---: | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | P1 | Hosted CI and provenance sign-off | Approved commit pushed to the protected repository | Run Node 20/22 quality jobs and Ubuntu/Windows/macOS platform smoke; retain package, SBOM, test, benchmark, reliability, packed-consumer, and manifest evidence; verify the OIDC attestation subject matches the package SHA-256 | Release Engineering / Security | Block until pass and attestation is verified |
| 2 | P2 | Golden fidelity and target-DCC qualification | Customer-approved fixtures and target-DCC versions | Compare geometry, transforms, animation, skinning, materials, optimization, and warnings against declared tolerances; attach fixture set, DCC versions, screenshots/logs, and Product/QA sign-off | Product/QA | Accept only with explicit target/fixture scope or remediate |
| 3 | P2 | Broader parser corpus and host interruption | Representative format corpus and disposable test hosts | Run malformed and mutation corpus across supported formats; exercise Ctrl+C/SIGTERM, interrupted packaging/export, and native parser interruption on Windows/macOS/Linux; prove no committed partial artifacts and document unavoidable hard-kill residue | Release Engineering / Security | Time-box or remediate before broad support claims |
| 4 | P2 | Browser and assistive-technology matrix | Declared browser/OS/screen-reader versions and test devices | Run the matrix in `BROWSER_COMPATIBILITY_MATRIX.md`, including viewport, zoom/high-DPI, keyboard-only, screen-reader, contrast, reduced-motion, long/unusual filenames, warning, error, retry, and batch recovery states | Product/QA | Do not claim full compatibility until evidence is attached |
| 5 | P2 | Maximum-model and low-resource qualification | Customer hardware profiles and disposable low-resource hosts | Repeat maximum workload, low-memory, low-disk, permission-denied, and interrupted-write tests; record peak RSS/heap, duration, output, cleanup, and recovery against `QUALITY_BUDGETS.md` | Product/QA / Support/Operations | Accept only for explicitly bounded hardware/resource scope |
| 6 | P2 | Provenance policy execution | Protected tag and repository attestation policy | Verify retention, access, subject digest, SBOM association, and rollback artifact retention; record the attestation URL or immutable evidence identifier | Security / Release Engineering | Block “fully signed” claim until verified |
| 7 | P2 | Operational ownership and rollback | Named personnel/team rota | Fill the approval record with Release Engineering, Security, Product/QA, and Support/Operations; rehearse rollback; define watch thresholds, escalation route, and review/expiry dates | Support/Operations | Required before final ship decision |
| 8 | P2 | Non-fatal exporter diagnostics | Target-DCC qualification results | Decide whether the three.js normalization/de-interleaving notices are accepted, suppressed, or fixed; retain warning policy and target-DCC evidence | Product/QA | P2 polish; never hide a conversion failure |

## Required evidence packet

The release reviewer should attach, at minimum:

1. The approved commit/tag and clean-worktree record.
2. The exact `.tgz` and SHA-256, `dist/RELEASE-MANIFEST.json`, SBOM, and
   hosted CI run identifiers.
3. `artifacts/test-results.json`, benchmark, reliability,
   `packed-consumer-smoke.json`, and fidelity reports.
4. Browser/assistive-technology and target-DCC qualification results.
5. The completed [release approval record](RELEASE_APPROVAL_RECORD.md),
   rollback rehearsal/result, accepted-risk expiry dates, and post-release
   watch thresholds.

## Completion rule

This remediation plan is not complete while any P1 is open, any mandatory
evidence row in the approval record is blank, or the final ship/no-ship and
post-release ownership decisions are unsigned.
