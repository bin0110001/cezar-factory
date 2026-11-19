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

## Deterministic rules and stage gates (#665)

`src/verification/disposition-rules.ts` maps dispositions to **CONTINUE**, **RECORD** (follow-up), **RETRY** (rerun or repair) or
**BLOCK** per stage, instead of treating a nonzero exit as failure. The policy is the `dispositionRules` block of
`policies/verification.json`, validated by `dispositionPolicySchema` (the JSON schema `schemas/verification-disposition-policy.schema.json`
is generated from it and drift-tested). `policies/**` is a protected asset, so an implementation change cannot edit the policy,
baselines or waivers; `policyEditViolations(changedPaths, protectedGlobs)` names the offending paths.

Per stage: `requiredChecks` (the stage minimum gate), `default` actions per disposition, ordered `rules` (first match wins, on
decision, class, minimum severity, impacted scope and category) and `maxRetries`. The validator refuses any way to CONTINUE past an
unusable run: `unknown`, `untested` and `infra-failure` can neither default to CONTINUE nor be matched by a CONTINUE rule.

`decideStage(policy, stage, runs)` returns the stage action (the worst across checks), per-finding decisions with the rule that fired,
follow-up fingerprints to record, checks to retry, rows for the Operations and Verification views, and a one-line agent-facing summary.
Behaviour with the shipped policy: accepted existing debt (`known`) continues; a new minor finding is recorded as a follow-up; a
regression in the impacted area blocks; a new high or critical security finding blocks at candidate and stable; a required check
that did not run (or is unknown or untested) blocks and stays unknown, never a pass; a scanner or runner outage retries, then
escalates to BLOCK after `maxRetries`.

## Follow-ups and bounded remediation (#666)

`src/verification/followups.ts` creates follow-ups and remediation exactly once per canonical finding.

- **One issue per finding.** `ensureFollowUp` goes through an injected `Publisher` (the existing canonical GitHub publisher; nothing
  here talks to GitHub). The idempotency key is `quality-followup:<project>:<fingerprint>` and is written into the issue body as a
  marker. Order: the ledger's `followup-recorded` event, then the publisher's own search by key, then create. So repeated
  detections across many executions give one issue, concurrent callers in a process share one creation, and a crash between creating
  the issue and recording it is recovered by finding the issue by key instead of creating a second.
- **Bounded remediation.** `nextRemediation` climbs `auto-fix`, `return-to-agent`, `scoped-rerun`, `planning-escalation`, then
  `human-decision`, with a per-step attempt budget and a total cap (`DEFAULT_BUDGET`). Steps that do not apply (no safe auto-fix,
  agent unreachable) are skipped. A persistent human decision task is created only once the ladder is spent and the finding is truly
  blocked; otherwise the finding stays recorded as a follow-up. A recorded successful fix ends it.
- **Replay-safe.** `recordRemediation` is idempotent per (fingerprint, step, attempt) and both event types are in the ledger's
  audit log (`followup-recorded`, `remediation-recorded`), so a restart sees the same history, computes the same plan
  (`remediationDigest` is unchanged) and repeats no work.

## Optional triage advisor (#667)

`src/verification/triage-advisor.ts` offers advice (semantic duplicates, causal and test-obsolescence hypotheses, suggested
follow-ups) next to a disposition record. It is off by default, accepts only a local model endpoint (loopback or private network; a
remote host makes the configuration invalid), and has call, token and cost budgets.

It is advisory by construction: `triage` returns the original stage decision object untouched and the advice separately, so advice
cannot flip a BLOCK to CONTINUE, waive a mandatory check, change policy or approve anything. Each claim must cite evidence the decision
actually has (fingerprint, check id, rule id or stage) and name a known finding, with a known kind; anything else is dropped and
counted. A disabled, invalid, failing, malformed or over-budget advisor yields no advice and the dispositions are unchanged. The
advisor sees only identifiers (fingerprint, check id, decision, rule id), never raw evidence.

## Progression, merge and release policy (#100)

`policies/verification-coverage.json` and `scripts/release/verification_progression.py` judge one comparison result per stage:
`iteration` (existing stage `pr-dev`) answers `continue`, `merge` (`candidate`) answers `merge-ok`, `release` (`stable`) answers
`release-ok`; any failure answers `blocked` with reasons. It is separate from `dispositionRules` because that block is schema-validated
by cezar.

- Known debt with zero new regressions does not block iteration or merge, but `release.blockKnownDebt` blocks release.
- A new/worsened/reopened failure in the impacted area blocks every stage; outside the impacted area it blocks merge and release.
- `untested`, `unknown`, `infra-failure`, unrecognised dispositions and unknown coverage are never green.
- Coverage below the stage's `minCoverage` blocks it (equal passes). `validate` rejects thresholds outside 0-100 and any stage looser
  than the previous one (iteration <= merge <= release).
