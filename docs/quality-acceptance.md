# Quality integration acceptance map (#669, #673)

How the check pipeline's acceptance bullets (epic #663) are covered, and where. Every test runs locally in the suite; none uses GitHub Actions.

## First delivery (#669): `src/verification/quality-e2e.test.ts`

A Trivy provider, a unit-test provider (`providers/junit-adapter.ts`, reads the JUnit XML test runners already write) and a native
static analyzer (ESLint) emit the same normalized finding schema, are stored as `check-finding` kinds in the #52 ledger through
`check-bridge.ts` and `check-finding-ingest.ts`, and are dispositioned CONTINUE/RECORD/RETRY/BLOCK by the shipped
`policies/verification.json` rules (`docs/verification-dispositions.md`).

- A fixture project with accepted debt, a new critical vulnerability and a new lint error: unrelated dev work continues; the new
  findings are recorded on a PR; at candidate and stable the new critical blocks, while the new lint error (quality debt) is only
  recorded.
- Provenance (provider, config and input digests) is kept as evidence references on every occurrence, and a token planted in
  scanner output appears nowhere in the ledger or the audit log.
- A tool crash is an error and RETRY (then BLOCK once retries are spent); an unexecuted suite and an unavailable advisory feed are
  `unknown` and block at stable; none of them resolves an open finding or continues past a gate.

## Epic acceptance bullets (#673)

| Bullet | Covered by |
| --- | --- |
| Provider swap needs no core change and keeps history | `src/verification/provider-swap-ledger.test.ts` (Trivy then OSV-Scanner give one finding, one episode, two observations with each provider's provenance); `providers/provider-swap.test.ts` (same status, fingerprints and gate verdicts) |
| Two analyzers cannot both be mandatory gates for one concern without explicit configuration | `checks/guards.ts` `duplicateGateViolations` and `checks/acceptance.test.ts` (an explicit `allowedDuplicates` list is the only way) |
| Opt-in AI audit stays within budget and is advisory only | `tests/test_ai_audit_policy.py` (zero calls when disabled, caps, receipt reuse, findings always `needs-verification`); not re-implemented in TypeScript |
| .NET, TypeScript, Python and Godot share infrastructure with no hardcoded machine profile | `checks/acceptance.test.ts` (one planner for every ecosystem; profiles name tools, not paths; check adapters contain no machine-specific constants) |

## Reconciliation

The owners #646-#654 are delivered (`docs/check-adapters.md`, `docs/check-supply-chain.md`, `docs/check-findings-policy.md`,
`docs/check-capabilities.md`). The issue also names #662 (a Godot pilot); no such deliverable exists in this repository, so it is
reported here as a gap against #662 rather than reimplemented. #670 (architecture boundaries and API compatibility) and #672
(documentation and decision drift) depend on the impact-manifest and drift engines (#195, #196, #149, #174) that this change does not
touch; they are not started.
