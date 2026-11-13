# Documentation-assist evaluation (issue #182)

Decides, per issue class, whether grounded documentation or spec-first planning improves Factory
coding outcomes enough to pay for retrieval **and** maintenance. The protocol is pre-registered in
`policies/docs-evaluation.json`; the analysis is `scripts/docs-evaluation-report.ps1`. Everything runs
on local or self-hosted workers; nothing uses GitHub-hosted compute.

## Status

The protocol, thresholds, analysis and rollout gates are defined. **No go/no-go has been issued**:
the measurements need the #175-#181 pilots to exist. Until a run file reaches
`minRunsPerArmPerClass` for a class and arm, the report says `insufficient-data` for it, and the
default for every class is **off**.

## Design

- Classes: simple bug, unfamiliar subsystem, cross-component feature, multi-repo interface change,
  drawn from cezar-factory and TableFlux issues with an immutable issue, commit and evidence reference.
- Arms: `baseline` (direct code exploration), `doc-assisted` (retrieval), `spec-first` (selective).
  Model family, issue and repeats are held equal between arms; pair comparable issues or randomize.
- Exclusion: a run is dropped (and the drop recorded) if it hit an infrastructure failure unrelated to
  the arm, or contains a secret or raw licensed data.
- Thresholds are fixed **before** collection. Changing one after data exists means a new policy
  `version`, not an edit.

## Metrics

Net cost is `generationTokens + retrievalTokens + reviewTokens + maintenanceTokens`: documentation
generation and refresh and human review count, so retrieval-only savings cannot produce a go. Also
recorded: first-useful-edit latency, completion time, accepted rate, rework and merge conflicts,
claim correctness (judged by tests or a person, never by the agent under test), and recovery.
Each run carries `sourceSha` and `workflowMode`; the report rejects runs without a SHA. Traces go
through Langfuse (#129) and OpenTelemetry (#128), model quality through #137.

## Running

```
pwsh scripts/docs-evaluation-report.ps1 -RunsPath <runs.jsonl>
```

Output is JSON with, per class and arm, the net token reduction, a seeded bootstrap 95% interval,
accepted rates, claim-incorrect rate and a `go`, `no-go` or `insufficient-data` decision.
A `go` needs the reduction to meet the threshold, the interval to exclude zero, no drop in accepted
rate and claim incorrectness within the limit. Limitation: the bootstrap resamples runs, not issues.

## Staged rollout and rollback

Flag `docsAssist` per project: `off` (default), `pilot`, `dev`, `stable`. Move one stage at a time and
only for a class with a `go`. `stable` needs explicit controlled approval and does not change
`config/promotion-policy.json`. Backend versions are pinned per stage.
**Rollback:** set the flag to `off`. Agents then use direct code exploration; a missing index or
backend never blocks them.

## Failure injection and operator playbook

Exercise each before moving a stage; the agent must degrade to baseline behaviour and say so.

| Injection | Expected behaviour | Operator action |
|---|---|---|
| MCP unavailable | Falls back to code exploration | Check the backend, keep flag or set `off` |
| Index stale (SHA behind HEAD) | Stale docs ignored or flagged | Rebuild the index, then re-enable |
| Gateway down | Falls back; no retry storm | Restore the gateway |
| Git drift / replay | Provenance SHA mismatch rejects the run | Re-collect from the pinned SHA |
| Prompt injection in docs | Retrieved text is data, not instructions | Quarantine the document, set `off` for the project |
