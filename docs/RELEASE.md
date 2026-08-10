# Release verification and evidence

Run the complete release gate with:

```sh
npm run release:check
```

This performs type checking, linting, formatting verification, the full test
suite, the production build, and distributable-artifact verification. The
verifier checks the core API, CLI, browser client, vendor WASM/runtime files,
third-party notices, package engine requirement, and executable metadata.

Run `npm run benchmark` after a production build to generate a repeatable
fixture baseline at `artifacts/benchmark-baseline.json`. The baseline records
input/output sizes, three conversion-duration and CPU samples, throughput,
peak/retained memory deltas, and startup probes per representative fixture.
`npm run benchmark:verify` compares those measurements against release-specific
performance budgets.

The package declares `pnpm@10.30.1` as its package manager. Use
`pnpm install --frozen-lockfile` in CI or release environments. npm can run
project scripts when dependencies are already installed, but the lockfile
should be resolved with the declared package manager.

## Enterprise release evidence

The versioned release contract and audit evidence live in:

- [Release contract](RELEASE_CONTRACT.md)
- [Format and feature matrix](FORMAT_FEATURE_MATRIX.md)
- [Quality and performance budgets](QUALITY_BUDGETS.md)
- [Browser compatibility matrix](BROWSER_COMPATIBILITY_MATRIX.md)
- [Threat model](THREAT_MODEL.md)
- [Operations and release runbook](OPERATIONS_RUNBOOK.md)
- [Release approval record](RELEASE_APPROVAL_RECORD.md)

`npm run benchmark` writes the current machine’s measurements to
`artifacts/benchmark-baseline.json`; `npm run benchmark:verify` enforces the
versioned fixture ceilings in `docs/performance-budgets.json`.

`npm run test:report` writes the machine-readable Vitest result used as
retained CI release evidence at `artifacts/test-results.json`.

`npm run reliability` and `npm run reliability:verify` retain the bounded
concurrency evidence at `artifacts/reliability-baseline.json`.
