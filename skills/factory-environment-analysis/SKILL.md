---
name: factory-environment-analysis
description: Analyze bounded exports of Cezar and Factory runtime health, job failures, schedules, and execution history, then produce evidence-backed improvement paths.
---

# Factory environment analysis

Use this skill when the user wants an operational assessment of Factory/Cezar throughput, failures, pickup latency, schedules, or auto-fix effectiveness.

## Inputs and bounds

The workflow has already collected `.factory/environment-analysis/environment-state-latest.json` and `.md`. Read those two artifacts only. The JSON is schema version 1 and includes the collection time, local Factory state, workflow and automation inventory, GitHub metadata, configured Cezar targets, and collection limitations. Cezar run history is bounded to at most 50 records per configured target; GitHub history is bounded to at most 50 runs. Do not assume the returned history is exhaustive or that a missing field means zero.

If either artifact is missing, malformed, or disagrees on collection time, report that as a blocker and stop analysis. Treat unavailable endpoints, absent targets, empty history, and stale timestamps as limitations; they do not establish system health. Do not fetch additional data or inspect raw run logs.

## Required analysis

- Separate directly observed facts from hypotheses and cite the relevant target, run, timestamp, workflow, automation, or limitation for each finding.
- Assess failure rate and recurring failure signatures only where the bounded sample supports a denominator. Avoid percentages when history is unavailable or incomplete.
- Evaluate pickup/queue signals only from available run timestamps, workflow events, and schedules; state when latency cannot be measured.
- Compare enabled, stale, and missing automations with the workflow inventory. Evaluate auto-fix execution and recovery only when subsequent run evidence exists.
- Assess target API availability and local checkout health independently; do not infer one from the other.
- For each proposed change, state its evidence, expected effect, risk, and a measurable validation signal. Prefer incremental Factory changes. Recommend a Cezar fork only when the export shows a platform limit that Factory workflows, automations, routing, or scripts cannot address.

## Result contract

Write `.factory/environment-analysis/analysis.md` with the collection timestamp and these sections. Keep the result bounded to five executive-summary bullets, ten evidence rows, five prioritized actions, and three quick wins. If more items qualify, group related observations and state the cap; never omit a material limitation to fit it.

1. **Executive summary** — current assessment and the strongest evidence limitation.
2. **Evidence table** — observation, source reference, confidence, and limitation.
3. **Prioritized improvement paths** — ordered actions with evidence, expected effect, risk, and validation signal.
4. **Quick wins** — low-risk actions supported by the snapshot, or “None supported by available evidence.”
5. **Fork decision** — whether a Cezar fork is justified, with the specific platform evidence or why none is demonstrated.

Keep recommendations traceable to the preserved snapshot filenames and collection time. If there is insufficient evidence for a section, say so explicitly rather than filling gaps with assumptions.

## Boundaries

Do not run scripts or commands, discover or select targets, inspect secrets or raw logs, call APIs, mutate external systems, create issues or pull requests, restart jobs, change schedules, or edit source code during analysis. The workflow owns collection and target selection. Implementation requires a separate user request.
