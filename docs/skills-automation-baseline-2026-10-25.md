# Skills and automation baseline — 2026-10-25

This is a bounded, sanitized snapshot for PIL-01 of [the skills and automation polish plan](skills-automation-polish-plan-2026-10-25.md). It records metadata and failure-step signatures only; run IDs, issue numbers, titles, API URLs, and raw logs are omitted.

## Collection record

- Collected at: 2026-10-25 15:29:28 UTC.
- Source checkout: Factory `VERSION` 0.3.45, `HEAD` `a9dc0b53c65cd64cc92176e7f2bfcfc2c9cbdc87`; the worktree was dirty. The Cezar runtime's mounted Factory revision was not independently verified during collection.
- Targets: the three entries in `config/factory-projects.json` only.
- Query: Cezar `/api/v1/p/{projectId}/runs` and `/automations`; the runs endpoint returned arrays, so the collector sorted by `createdAt` and retained the latest 20 records per project (60 total). GitHub `gh run list --limit 20` was also captured for the Factory repository.
- Collector: `scripts/collect-environment-state.ps1`, updated to preserve UTC offsets and calculate run durations from start/finish timestamps. The detailed local export is under the ignored `.factory/skills-polish-baseline-2026-10-25/final/`; this tracked report contains the sanitized aggregate.
- Missing fields are reported as unavailable; a missing failure reason is not classified as a code defect.

## Cezar sample

| Project | Runs | Done | Failed | Running/queued | Creation window (UTC) | Live automation definitions (enabled) |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Blackjack/Godot | 20 | 12 | 7 | 1 | Oct 25 06:00–15:11 | 16 (12) |
| Factory | 20 | 16 | 4 | 0 | Oct 25 01:00–15:00 | 17 (16) |
| TableFlux animation pipeline | 20 | 18 | 2 | 0 | Oct 24 20:00–Oct 25 15:00 | 14 (12) |
| **Total** | **60** | **46** | **13** | **1** | Different windows | **47 (40)** |

The sample is maintenance-heavy: 47/60 runs used `factory-maintenance`; the remaining runs were investigation (8), implementation (1), planning (1), intake (1), failure audit (1), and one legacy `(planned)` workflow. Work types and time windows differ by project, so these counts are descriptive only.

### Failed step signatures

| Project | Failed workflow/step | Count |
| --- | --- | ---: |
| Blackjack/Godot | `factory-investigate/investigate` | 5 |
| Blackjack/Godot | `factory-implement/targeted-tests` | 1 |
| Blackjack/Godot | `factory-maintenance/backlog-label-audit` | 1 |
| Factory | `factory-maintenance/recover-audit-reservations` | 2 |
| Factory | `factory-failure-audit/collect` | 1 |
| Factory | `factory-maintenance/backlog-label-audit` | 1 |
| TableFlux animation pipeline | `factory-maintenance/backlog-label-audit` | 1 |
| TableFlux animation pipeline | `factory-maintenance/startup` | 1 |

All 13 failed records lacked `terminalReason` and `validationOutcome`; the available export identifies failed step IDs but contains no bounded provider response or command diagnostic. Their causes therefore remain **unknown**. The currently available sample cannot validate the original timeout or targeted-test hypotheses.

## Usage and outcome limits

- `tokensUsed` was populated on all 60 records (58,045,509 reported in aggregate). This is the run-record value, not a cost estimate; its scale and accounting semantics have not been independently verified.
- Run duration was derivable for 59 terminal records. Mean duration was 1,535.8 seconds for 46 done runs and 1,155.2 seconds for 13 failed runs. One running record had no terminal duration. These mixed workflow means should not be compared as performance effects.
- `costUsd` was populated on only 1/60 records (0.2114 USD). Cost per accepted outcome is not measurable from this baseline.
- The 20 sampled Factory GitHub Actions runs had zero failures. These repository runs are separate from Cezar outcomes.
- `done` does not prove that an issue produced an independently reviewed and accepted PR. Accepted/merged outcomes, human recovery, duplicate effects, retries by reason, actual agent-call counts, provider capacity, and subscription utilization were not captured.
- The two project registry entries without `projectType` remain unknown in this snapshot. Live automation enabled state is an observation at collection time, not authorization to change schedules.

## Pre-registered comparison protocol (PIL-02)

For each comparison, capture the latest 20 records for each same configured target at a fixed collection time, and report terminal, queued, and running states separately. Stratify by workflow and work outcome; compare matched work categories and keep project-specific windows visible. Do not compare overall rates across periods unless the work mix is comparable. For a pilot, require at least 20 eligible issue-producing terminal runs in both baseline and pilot windows; if that volume is not reached, extend the observation window and report the shortfall instead of substituting maintenance runs.

The initial targets remain provisional and are not measured by this baseline: at least 50% fewer classified avoidable agent calls, zero observed duplicate side effects in replay/pilot, fewer than 5% unclassified failures, and at least 25% lower cost per accepted outcome with no lower useful acceptance or bypassed review. Cost is currently present on only 1/60 records and accepted outcomes are unavailable, so the cost/acceptance target cannot be evaluated until telemetry is fixed.
