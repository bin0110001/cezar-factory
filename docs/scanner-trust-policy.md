# Scanner trust policy (#604)

Every vulnerability provider runs under one policy: `server/verification/scanner-trust-policy.ts`.

## Why

A security scanner runs with read access to source and with CI-grade trust, so a compromised scanner
release defeats the check that is meant to protect the repository. The Trivy supply-chain compromise
tracked as GHSA-69fq-xp46-6x23 (referenced by issue #604; consult the advisory for details) is the
motivating case: pulling `latest` would have installed the tampered build and reported a green result.

## Policy fields

`provider`, `reference`, `pinnedDigest` (`sha256:<64 hex>`), `signature.trustedSigners`, `trustedSource`,
`updateProcess` and `dbMaxAgeHours`. A pin changes only through a reviewed change to the policy, never by
automatic refresh.

## Verdicts

`evaluateScannerTrust` returns `trusted`, `fail` or `unknown`, never a green result for anything else:

| Condition | Outcome |
| --- | --- |
| `latest`/floating or unpinned reference, digest mismatch, unsigned, untrusted signer | `fail` |
| Binary missing, advisory DB missing, DB older than `dbMaxAgeHours` (including offline) | `unknown` |
| Malformed policy | `unknown` (`invalid_policy`) |

The trusted promotion path must treat anything but `trusted` as a non-green security result. Runtime
isolation of the scan itself is in `docs/scanner-worker-profile.md`.
