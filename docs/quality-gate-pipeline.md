# Quality gate pipeline (#612, #613, #614, #615)

Builds on the policy in `docs/quality-gates.md` and the check contract in `docs/check-provider-contract.md`. All four
modules are libraries under `scripts/release/`; nothing here runs a scanner, edits `config/promotion-policy.json` or starts
a candidate. All compute stays on local Factory workers.

## Scanner status and backoff (`scanner_status.py`, #613)

A scan is `clean`, `findings`, `unknown`, `outage` or `stale`. `classify_scan` returns `clean` only if the scan ran, its feed
was available, the result parsed and it is within its max age; an outage or unusable scan is never clean, and `stale` is a
distinct state. `outcome` maps a state to `pass`, `warn` or `block` from the check's level and fail mode (a required check that
fails closed blocks on unknown, outage and stale). `backoff_delay` is exponential from a base and bounded by a cap. `ScanBook`
keeps, per project and check, the last good scan time and advisory DB snapshot (a failed attempt does not overwrite them),
consecutive failures, the next retry time, and downgrades a state to `stale` when the last good scan is too old.

## Periodic scans and freshness (`scanner_status.py`, #614)

`due_periodic` lists the categories whose cadence (daily, weekly, monthly) has elapsed and whose backoff allows a retry: scans
only, never the full suite. `evidence_fresh` is false when evidence was recorded against an older advisory DB snapshot, even for an
unchanged SHA. `apply_periodic_result` folds a periodic scan into quality evidence and reports new blocking findings and whether
promote-readiness flipped; it carries `startedCandidate: false` and verifies the candidate it was given is unchanged, so a
periodic run never creates a second candidate, takes ownership or changes a SHA (tested against the candidate store).

## Findings, baselines and suppressions (`quality_findings.py`, #612)

`evaluate_findings` classifies each finding as `new`, `baselined` (known debt, only while the baseline entry is younger than
`baselineMaxAgeDays`) or `suppressed`, tightens one severity step for confirmed-exploitable or high-criticality paths that have a
fix, and blocks when new findings exceed the policy tolerance for a severity. A suppression is valid only if it was granted by
a kind the policy allows (`human` or `operator`; an agent never can), names a fingerprint or advisory id, has a reason and an
exception receipt id, expires, does not outlive `waivers.maxDays`, and matches its project, stage and path scope. An expired or
out-of-scope suppression blocks again. `exception_receipt` is a deterministic digest. `plan_issues` creates actionable issues for
blocking findings, deduplicated against open ones and bounded per run (#105).

## Stage wiring (`quality_stage_gate.py`, #615)

`evaluate_stage` resolves the effective policy for a project and repo type, adds the checks a risk pattern pulls into the stage,
maps each check's result through `is_blocking` (a missing required result counts as `unknown`, so an absent scan never passes a
required security check), runs finding evaluation where a security check is enforced, and returns a `quality-gate-receipt/v1`
that is redacted (token shapes plus caller-supplied secrets) before it is returned. The adopting stage records that receipt
with its validation receipts.

Not done here: changing the live promoter and `config/promotion-policy.json` to call `evaluate_stage` is the adoption step; the
libraries are deliberately inert until a workflow `command:` step uses them.

## Waiver inbox (#603)

`scripts/release/release_waiver_inbox.py` is the engine side of the Control Center waiver request. The Control Center appends audited requests to `~/.cezar/release/waivers.jsonl`; `process()` decides each request not yet decided against the effective policy (`waivers.grantedBy`, `maxDays`, a named fingerprint or advisory, an expiry, never blanket) using `quality_findings.suppression_problems`, and returns one decision per request for `waiver-decisions.jsonl`: a granted operator suppression with an exception receipt, or a rejection with the reasons. Decided requests are skipped, so a rerun records nothing twice, and `active_suppressions()` returns the unexpired grants for one project, which the stage gate evaluates findings against. An expired grant blocks again.

Gap: this is a library; the scheduled engine step that reads and appends the files and feeds the grants to `quality_stage_gate` is not wired yet.
