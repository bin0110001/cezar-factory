# Verification workflow

`workflows/verify.yaml` (`factory-verify`, issue #102, parent #56, epic #47) runs verification as workflow command
steps. It runs no agent; every script is started from a `command:` step.

| Step | Script | Output |
| --- | --- | --- |
| `select-scoped` | `scripts/verification-select.ps1` | `.factory/verification/selection.json` |
| `invoke-checks` | `scripts/verification-invoke.ps1` | `.factory/verification/results.json` |
| `policy-evaluate` | `scripts/verification-evaluate.ps1` | `.factory/verification/verdict.json` and a ledger line |

## Contracts consumed

- **Impact selection (#53):** `Get-ChangedValidationSelection` in `scripts/lib.ps1` over `.ai/factory/test-ownership.json`,
  the selection `test-changed.ps1` already uses. Unowned paths fall back to the map's `unmapped` rule.
- **Policy (#54 area):** `policies/verification.json` lists `mandatoryChecks` (ids that must exist in the ownership map),
  `checkTimeoutSeconds` and the ledger path. `policies/**` is a protected governance asset (`docs/governance-guard.md`).

## Behaviour

- A scoped rerun executes the impacted checks plus the mandatory ones and nothing else. Each selected check records why
  (`impact`, `mandatory` or `impact+mandatory`).
- Mandatory selection is never agent input. `verification-invoke.ps1` takes each command from the ownership map by id and
  refuses a selection entry that differs; `verification-evaluate.ps1` re-reads the policy, so a selection or result set
  that omits a mandatory check yields `fail`. A mandatory id the ownership map does not define stops selection.
- The verdict is `pass` only when every mandatory and selected check ran and passed. It is appended, pass or fail, to
  `.factory/ledger/verification-verdicts.jsonl` as one JSON line carrying the previous line's SHA-256 (`previousDigest`),
  and written to the result file. A `fail` makes the step, and the workflow, fail.

## Known gaps (flagged, not invented around)

- The finding ledger from #52 (`cezar/packages/cezar/src/verification/finding-ledger.ts`) is a TypeScript store of findings and
  occurrences. There is no Factory-side adapter to it, so verdicts go to the Factory-side append-only JSONL above. Replace
  `verification-evaluate.ps1`'s append when a bridge exists.
- Baseline comparison (`policies/baseline-promotion.json`, `scripts/check-weakening.ps1`) is not part of this verdict; the
  policy evaluated here is the mandatory-check policy only.

Tests: `tests/verification-workflow.ps1` (fixture repository, no deploy), run by `tests/run-tests.ps1`.
