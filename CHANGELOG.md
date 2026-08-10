# Changelog

All notable changes to MeshShift are documented here. The project follows
Semantic Versioning for the public package and CLI.

## [0.2.0] - Release candidate

### Added

- Enterprise ship-readiness contract, format matrix, quality budgets, threat
  model, and operations runbook.
- Deterministic release manifest, production SBOM generation, and CI release
  gates for Node 20 and 22.
- Defensive input, companion-resource, export-path, and streamed-export limits.
- Atomic CLI and local browser export writes.
- Modal dialog semantics, keyboard focus handling, and accessibility status
  labels in the browser UI.

### Changed

- Public optimization options reject unsafe or non-finite values at the API
  boundary.
- Release decisions now distinguish verified local evidence from hosted CI and
  organizational approval requirements.

### Known limitations

- Full OS/browser/screen-reader qualification, maximum-size workload evidence,
  hosted build provenance, and named organizational approvals remain release
  checkpoint requirements.
