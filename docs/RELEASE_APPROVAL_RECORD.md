# MeshShift Release Approval Record

Copy this file into the release evidence bundle and complete it for the exact
candidate being shipped. An empty field is an open gate, not an approval.

## Candidate identity

| Field | Value |
| --- | --- |
| Package name/version | `meshshift@0.2.0` |
| Release commit | |
| Branch/tag | |
| Node and pnpm versions | |
| Lockfile hash | |
| Package SHA-256 | |
| `RELEASE-MANIFEST.json` SHA-256 | |
| SBOM SHA-256 | |
| Evidence bundle location | |

## Mandatory evidence gates

| Gate | Evidence location | Result | Reviewer/date |
| --- | --- | --- | --- |
| Node 20 hosted CI | | ☐ pass ☐ fail | |
| Node 22 hosted CI | | ☐ pass ☐ fail | |
| Production dependency audit | | ☐ pass ☐ fail | |
| SBOM generation and retention | | ☐ pass ☐ fail | |
| Release manifest verification | | ☐ pass ☐ fail | |
| Eight-fixture performance budget | | ☐ pass ☐ fail | |
| Eight-item concurrency smoke | | ☐ pass ☐ fail | |
| Packed-consumer installation and CLI smoke | | ☐ pass ☐ fail | |
| Browser/assistive-technology matrix | | ☐ pass ☐ fail | |
| Maximum-model and low-resource qualification | | ☐ pass ☐ fail | |
| Build-provenance attestation verification | | ☐ pass ☐ fail | |
| Rollback rehearsal or recorded rollback procedure | | ☐ pass ☐ fail | |

## Residual-risk disposition

| Finding | Disposition | Owner | Review/expiry date | Approval |
| --- | --- | --- | --- | --- |
| Broader browser and assistive-technology coverage | | | | |
| Maximum-model, low-resource, and customer-hardware qualification | | | | |
| Hosted provenance policy execution | | | | |

## Role approvals

| Role | Named individual/team | Decision | Timestamp | Signature or ticket |
| --- | --- | --- | --- | --- |
| Release Engineering | | ☐ approve ☐ reject | | |
| Security | | ☐ approve ☐ reject | | |
| Product/QA | | ☐ approve ☐ reject | | |
| Support/Operations | | ☐ approve ☐ reject | | |

## Final decision

- ☐ Ship
- ☐ Do not ship
- ☐ Ship with explicitly accepted residual risk listed above

Decision rationale:

Rollback owner and procedure:

Post-release watch items, thresholds, and escalation route:
