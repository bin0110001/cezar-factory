# Quality gates (#611)

Which checks gate which stage, how strictly, and what happens when a check cannot run. The policy is data in
`policies/quality-gates.json` (a protected policy asset, so coding agents cannot edit it); the validator and resolver are
`scripts/release/quality_gate_policy.py`; `schemas/quality-gate-policy.schema.json` is an editor aid. Check categories
are the provider-contract categories (`docs/check-provider-contract.md`), so no scanner brand appears in a policy. This
adds no CI engine: it only decides what the existing local verification must require.

## Shape

`schemaVersion: quality-gates/v1`, `defaults`, optional `repoTypes.<type>` and `projects.<id>` overrides, merged in that
order key by key. Each layer may hold:

- `checks.<category>.<stage>`: a level (`required`, `optional`, `advisory`, `off`) or `{level, onUnavailable}` where
  `onUnavailable` is `fail-closed` or `fail-open`. Stages: `pr-dev`, `candidate`, `stable`, `periodic`, `manual`.
- `cadence.<category>`: `daily`, `weekly` or `monthly`. Defaults: dependency CVE refresh (`sca`) daily, `sast` weekly,
  `license` monthly.
- `riskPatterns`: globs that pull a check forward when a change touches them (dependency manifests make `sca` required on
  the PR; Dockerfiles and Terraform pull `container` and `iac`).
- `tolerances`: `maxNewFindings` per severity (default zero critical and high) and `baselineMaxAgeDays`.
- `budgets`: per-stage `maxMinutes` and `maxCostUnits`, to keep full-scan cost bounded.
- `waivers`: `grantedBy` (only `human` and `operator`) and `maxDays`.

Default posture: fast checks (format, lint, type, tests, secrets) on every PR; dependency scanning advisory on a PR but
required and fail-closed at candidate and stable; broader SAST advisory; `ai-audit` optional and manual only.

## Rules the validator enforces

- Unknown fields, categories, stages, levels, cadences and severities are rejected with their path.
- A required security check (`sast`, `sca`, `secrets`, `iac`, `container`) at `candidate` or `stable` must fail closed. This
  is also checked on every project's effective policy, so an override cannot weaken it.
- Waivers can only be granted by a human or operator and always have a bounded lifetime; a coding agent can never grant one.

## Decisions

`stage_matrix` and `escalated_stage_matrix` give the checks for a stage (the latter adds risk-pattern escalation for the
changed paths). `is_blocking(category, stage, status)`: `fail` blocks a required check; `unknown` and `error` block only a
required check that fails closed; advisory and off checks never block; `pass` and `warn` never block. Evaluating findings
against baselines is #612, scanner status and backoff is #613, periodic scans are #614 and wiring into the stages is #615.
