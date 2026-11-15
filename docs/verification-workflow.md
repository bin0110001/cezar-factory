# Verification workflow

`workflows/verify.yaml` (`factory-verify`, issue #102, parent #56, epic #47) runs verification as workflow command
steps. It runs no agent; every script is started from a `command:` step.

| Step | Script | Output |
| --- | --- | --- |
| `select-scoped` | `scripts/verification-select.ps1` | `.factory/verification/selection.json` |
| `invoke-checks` | `scripts/verification-invoke.ps1` | `.factory/verification/results.json` |
| `policy-evaluate` | `scripts/verification-evaluate.ps1` plus RunManager ingestion | `.factory/verification/verdict.json`, Cezar verification history, and the project finding ledger |

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
  and written to the result file. RunManager validates the selection, results and verdict artifacts after the command
  exits, emits the typed verification result and policy verdict into the Cezar run event history, and ingests failed
  checks into the project-scoped #52 finding ledger. A policy failure still records findings before failing the step.
  Artifact paths are normalized relative paths from the worktree root; missing, mismatched, duplicate or invalid
  results fail ingestion and the workflow.

## Boundaries

- The in-process adapter uses the registered project's Cezar data directory for canonical finding storage. The
  hash-chained Factory verdict JSONL remains as the workflow's portable audit receipt; run history also retains the
  verdict and artifact provenance for Cezar queries.
- This workflow evaluates `policies/verification.json` mandatory checks. Baseline promotion policy
  (`policies/baseline-promotion.json`) continues to be enforced by its separate promotion gate; it is not silently
  treated as a verification-run regression baseline.

Tests: `tests/verification-workflow.ps1` (fixture repository, no deploy), run by `tests/run-tests.ps1`.
