# Adaptive progress evaluator (#739)

`scripts/release/progress_evaluator.py` is a pure, deterministic library (no clock, IO, randomness or LLM) that classifies
one repair round from an ordered history of immutable observations. Wiring, budgets and terminal outcomes belong to #740/#741.

## Input contract

`evaluate(history, accepted_fingerprints=())`; `history` is oldest-first, the last entry is the round judged.
Observation: `id`, `verified`, `coverage.expected` / `coverage.executed` (check ids), `artifact.hash`, and `findings`
(`fingerprint`, `severity`, `criterionId`, `checkId`). This is the minimal shape adapted from the #738 diagnostics.
Severity order: info < low < medium < high < critical (unknown severity counts as critical).
`accepted_fingerprints` come from the trusted baseline/disposition policy (#661/#664/#665, `verification_progression.py`):
they stay visible (`acceptedVisible`) but are not blocking; the evaluator never decides acceptance itself.

## Precedence

1. `inconclusive` - unverified, no expected checks, expected checks not executed, coverage reduced vs the previous round, a finding
   disappeared whose check did not run (masked), or no previous observation. Never progress.
2. `regression` - severity increase on a persistent finding, higher severity-weighted score, or (when not cyclic) a reopened finding or
   a previously resolved acceptance criterion failing again.
3. `oscillation` - the blocking set returned to an earlier set after leaving it (A->B->A, A->B->C->A); `oscillationCycle` is the length.
4. `resolved` - no blocking findings. 5. `net_progress` - findings resolved, none new, lower score.
6. `mixed_progress` - resolved and new findings, lower score. 7. `partial_progress` - lower score without resolution (severity eased).
8. `stagnation` - everything else; a new fingerprint replacing a resolved one at equal or higher weight is stagnation, not progress.

## Output

`classification`, `reasonCodes`, `evidenceRefs`, `new/resolved/persistent/reopened/regressed`, `acceptedVisible`, `artifactChanged`,
`consecutiveNoProgress` and `persistenceAllowed` (stagnation with a changed artifact; the budget issue #740 caps it),
`bestComparison`/`bestObservation` (best is the earliest lowest-score VERIFIED, complete-coverage prior observation; tied scores do not
prefer fewer findings; `worse_than_best_verified`
is reported as a reason code), `blockingCount`, `score`.

Duplicate rows with the same fingerprint are one finding. The evaluator keeps the highest severity and unions all non-empty
criterion and check identifiers in sorted order. This makes repeated validator reports order-independent and ensures an unrun
associated check cannot make a finding appear resolved.
