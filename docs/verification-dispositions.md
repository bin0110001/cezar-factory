# Verification dispositions and check findings in the ledger (#664)

Check-provider findings (`docs/check-provider-contract.md`) are persisted in the existing #52 finding ledger, and each run's
decision about them is a disposition. There is no second finding store, runner or approval authority.

## Ledger widening

`check-finding` is a new finding kind in `verificationFindingKindSchema` (contract) with the fingerprint strategy
`cezar.verification.check-finding` v1. The fingerprint is the provider-independent one from the normalizer, so swapping a scanner
keeps history. The ledger keeps its structure: a Finding (identity), immutable Occurrences (observations), Episodes (open or
resolved), and the append-only audit log. A per-run `disposition-recorded` audit event records the decision (digest, run
disposition, summary counts, policy version, verification id) without changing any finding or episode.

## Dispositions (`src/verification/disposition.ts`)

`new`, `known`, `worsened`, `resolved`, `reopened`, `untested`, `unknown`, `infra-failure`. `computeDispositions` is pure and
deterministic (inputs in, records and a digest out), so a replay is identical.

- **Trusted baseline.** A baseline counts only from `integration` or `approved-evidence`. A feature-branch rerun, an agent, or no
  baseline at all means nothing can be `known`: every present finding is `new` (`reopened` if it had been resolved).
- **Comparison.** Present and in the baseline at the same or lower severity is `known`; higher is `worsened`; absent from the
  baseline is `new`. Absent now, with complete coverage, and either open in the ledger or in the baseline, is `resolved`
  (42 known warnings that become 39 give 39 `known` and 3 `resolved`).
- **Never a pass from unusable evidence.** A crash, timeout, not-run or `error` result is `infra-failure`; an incomplete
  selection (a missing suite) or a not-applicable check is `untested`; stale evidence or an `unknown` result is `unknown`; a
  baseline from another environment makes the comparison `environment-changed` with every finding `unknown`. None of these resolves
  an episode or lets an open finding disappear.
- **Known is not waived.** A waiver is a separate, scoped, expiring decision from an independent authority (`docs/check-findings-policy.md`).
  It is carried as a `waived` flag on the record and never changes the decision.
- Every record carries the effective policy version, base SHA, environment fingerprint, baseline SHA and actor.

## Ingest (`src/verification/check-finding-ingest.ts`)

`ingestCheckFindings(store, audit, input)` stores the findings, opens or extends episodes, resolves only the episodes the
dispositions mark resolvable (with an `episode-resolved` audit event), and appends one `disposition-recorded` event. Occurrence ids
derive from the run, and a disposition event for the same verification id and check marks a replay, so ingesting a run twice writes
nothing.

Next: deterministic stage rules (#665), idempotent follow-ups (#666) and the end-to-end demonstration (#669) build on this.
