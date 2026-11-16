# Vulnerability provider comparison: Trivy vs OSV-Scanner (#607)

Both adapters run behind the same contract, runner, trust policy (`docs/scanner-trust-policy.md`) and isolation
profile (`docs/scanner-worker-profile.md`). The shared fixture suite is
`checks/providers/provider-swap.test.ts`; it runs every scenario against both adapters and asserts identical
status, active-finding fingerprints and gate verdicts. A provider swap is a change of `provider` identity and plugin
in the check definition, with no change to core release code.

**Scope of this comparison.** The fixtures are hand-written reports in each tool's documented JSON shape. They show
that both adapters normalize equivalently and fail closed identically. They do **not** measure real-world detection
rates or false-positive rates; no real scanner was executed to produce this document.

| Scenario | Trivy | OSV-Scanner |
| --- | --- | --- |
| Confirmed CVE (lockfile) | fail, 1 blocking | fail, 1 blocking (CVE found through the GHSA alias) |
| False positive | `Status: not_affected` becomes a waived finding | suppressed by OSV ignore config, so absent from output |
| Clean lockfile | pass | pass |
| No lockfile | unknown, reason recorded | exit 128 mapped to unknown, reason recorded |
| Planted secret in output | redacted | redacted |
| Crash / bad JSON | error | error (exit 1 means vulnerabilities found, not a crash) |

## Coverage

| Domain | Trivy | OSV-Scanner |
| --- | --- | --- |
| Repository lockfiles (SCA) | yes | yes |
| Container image | yes | yes |
| Misconfiguration (IaC) | yes | no |
| Secrets | yes | no |
| License | yes | no |
| SBOM output | CycloneDX | not used by the adapter |

## Decision

Keep Trivy as the default provider because it is the only one of the two covering the misconfiguration, secret and
license domains through one adapter. Keep OSV-Scanner as the configured alternate for SCA and as the swap proof. The
default is justified by breadth, not by measured accuracy; revisit once both have run against real repositories on a
worker and their findings can be compared (a follow-up, not part of this change).
