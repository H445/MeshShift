# Security policy

## Scope

ModelShift is a local/offline converter. The browser application processes model data in the local browser and the development/preview export endpoint writes only beneath the configured project `exports/` directory. The CLI and reusable API read and write files on the host where the caller runs them.

Security review should prioritize:

- Untrusted 3D files and companion resources
- Archive, parser, WASM, and dependency resource exhaustion
- Path traversal, symlink escapes, and unsafe output replacement
- Vendored runtime integrity and release-artifact tampering
- Accidental disclosure through logs, diagnostics, or generated metadata

## Reporting

Please report suspected vulnerabilities privately through the repository's private security-advisory or maintainer contact channel. Include the affected version, operating surface (CLI, browser, API, or export writer), a minimal reproduction, and the expected versus observed behavior. Do not publish exploit details before a fix or coordinated disclosure decision is available.

Do not include proprietary model files or credentials in a report. Reproduce with the smallest synthetic fixture possible and redact paths, usernames, and environment variables.

## Release security controls

Release candidates must pass the locked dependency installation, production build, artifact verification, third-party notice review, CI dependency-audit gate, SBOM generation, and benchmark verification. Push builds also package the exact candidate and request GitHub build-provenance attestation using short-lived OIDC credentials. The generated `dist/RELEASE-MANIFEST.json` records SHA-256 hashes for the shipped runtime and evidence documentation so downstream release automation can verify integrity.
