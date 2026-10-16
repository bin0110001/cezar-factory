---
name: factory-environment-analysis
description: Analyze bounded exports of Cezar and Factory runtime health, job failures, schedules, and execution history, then produce evidence-backed improvement paths.
---

# Factory environment analysis

Use this skill when the user wants a current operational assessment of Factory/Cezar throughput, failing builds, pickup latency, schedules, or auto-fix effectiveness.

The workflow command creates a JSON export and a compact Markdown handoff. Read only the generated JSON and Markdown artifacts; do not rediscover targets, inspect secrets, or fetch raw run logs. Treat missing API data as a limitation, not as evidence that the system is healthy.

Analyze at least:

- failure rate and recurring failure signatures across the bounded Cezar and GitHub histories;
- queue/pickup signals available in run timestamps, workflow events, and automation schedules;
- enabled versus stale or missing automations and workflow coverage;
- auto-fix evidence: whether fix/review jobs are scheduled, executing, succeeding, and producing subsequent recovery;
- target-by-target API availability and local Factory checkout health.

Separate observations from hypotheses. For every proposed change, name the evidence, expected effect, risk, and a measurable validation signal. Prefer incremental Factory-side fixes first; discuss a Cezar fork only where the export shows a platform limitation that cannot be addressed through workflows, automations, routing, or scripts. Do not make external changes, create issues, restart jobs, or edit source during analysis unless the user separately asks for implementation.

Produce an analysis artifact alongside the export with an executive summary, evidence table, prioritized improvement paths, quick wins, and a fork decision record. Preserve the export filenames and collection timestamp so recommendations remain auditable.
