# MeshShift Threat Model

## Trust boundaries

1. **Input boundary:** user-selected model files and companion resources enter
   the CLI, Node API, or browser worker. They are untrusted bytes.
2. **Parser/WASM boundary:** Assimp and supporting decoders interpret those
   bytes and may allocate substantial native/WASM memory.
3. **Filesystem boundary:** the CLI writes converted files to a caller-selected
   directory; the local browser endpoint writes only below `exports/`.
4. **Browser boundary:** the static client owns UI state and worker messages;
   the export endpoint is a local development/preview integration, not an
   authenticated internet service.
5. **Release boundary:** package contents, vendored WASM, dependencies, and CI
   artifacts become executable customer inputs.

## Threat register and controls

| Threat                                    | Impact                                              | Controls                                                                                               | Evidence / residual                                                            |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Path traversal or absolute companion path | Read outside selected input root                    | Relative-name validation, realpath containment, URL rejection, symlink checks                          | CLI path tests; continue fuzzing unusual Unicode/path encodings                |
| Path traversal or device-name output      | Overwrite unintended files                          | Output segment validation, output-root containment, symlink checks, atomic temp+rename                 | CLI output tests; Windows matrix remains required                              |
| Malformed parser input                    | Crash, corruption, denial of service                | Aggregate bytes, file-count, option, and browser direct-GLB limits; typed parse errors                 | Malformed-input tests; large adversarial corpus remains required               |
| Export stream overrun                     | Disk exhaustion                                     | Content-Length precheck and streamed byte ceiling; temporary cleanup                                   | Export-server tests                                                            |
| Partial output after interruption         | Misleading or corrupt artifact                      | Temporary file then atomic rename; cleanup on failure, CLI signal propagation                           | Output/export tests and CLI interruption verifier                              |
| Cancellation during conversion            | Stale work, leaked worker memory, or partial output | AbortSignal phase checks, CLI `SIGINT`/`SIGTERM`, worker termination for obsolete jobs, atomic output commit | Cooperative cancellation tests and CLI interruption verifier; native/OS interruption remains required |
| Remote resource exfiltration              | Privacy loss or network dependency                  | CLI rejects URL references; browser processing is local; static hosting contract                       | Companion-resource tests and release contract                                  |
| Vendored runtime tampering                | Supply-chain compromise                             | Third-party notices, release manifest SHA-256, locked install, audit, SBOM                             | Build verifier and CI workflow; hosted attestation remains required            |
| Secret or model data disclosure           | Privacy breach                                      | No telemetry by default, generic server errors, redacted support guidance, ignored generated artifacts | Security policy and release review                                             |
| Worker/UI stale-state race                | Wrong asset exported or lost work                   | Request IDs, obsolete worker cancellation, queue state tests                                           | Browser workflow and UI tests; broader concurrency matrix remains required     |
| ZIP/resource expansion abuse              | Disk/memory exhaustion                              | Input archives are not accepted; output ZIP contains only successful generated files                   | Contract explicitly excludes archive input; reassess if archive input is added |

## Security assumptions

- The caller controls the CLI/API process and is responsible for filesystem
  permissions and host isolation.
- The local export endpoint is not safe to expose to an untrusted network. A
  deployment that does so must add authentication, origin policy, CSRF controls,
  rate limiting, and a separate security review.
- WASM and parser limits reduce but do not eliminate algorithmic complexity or
  host memory risk; maximum-supported-model qualification is operationally
  required.

## Release security decision

No known P0/P1 security finding is present in the current local candidate. A
hosted build-provenance or signing mechanism must be selected before an
enterprise release is called fully signed and verifiable.
