# Developer guide

This section is for contributors and integrators working from a clone of the
MeshShift repository. Normal users should download the latest desktop release
and follow the [user quick start](QUICK_START.md).

## Local development

Requirements: Node.js 22 or newer and pnpm 10.30.1.

```sh
pnpm install
pnpm dev
```

The local web app runs at `http://localhost:5173/`. For the Electron desktop
development build:

```sh
pnpm desktop:dev
```

Build the reusable library, CLI, web client, and desktop process with:

```sh
pnpm build
pnpm desktop:build
```

## Developer references

- [CLI reference](CLI.md)
- [Core TypeScript API](API.md)
- [Architecture and preview pipeline](ARCHITECTURE.md)
- [Desktop release plan](DESKTOP_RELEASE_PLAN.md)
- [Release contract](RELEASE_CONTRACT.md)
- [Operations runbook](OPERATIONS_RUNBOOK.md)
- [Threat model](THREAT_MODEL.md)
- [Quality budgets](QUALITY_BUDGETS.md)
- [Browser compatibility qualification](BROWSER_COMPATIBILITY_MATRIX.md)

## Verification

Run the test suite and desktop package checks before opening a pull request:

```sh
pnpm test -- --run
pnpm desktop:verify
```

The GitHub Actions workflows run the broader CI and platform matrix. Release
builds start from a version tag such as `v0.2.2` and publish one installer per
supported desktop target, plus checksums.

## Other technical references

- [LOD implementation details](LOD.md)
- [Format and feature matrix](FORMAT_FEATURE_MATRIX.md)
- [Performance budgets](performance-budgets.json)
- [Reliability budgets](reliability-budgets.json)
- [Security policy](../SECURITY.md)
