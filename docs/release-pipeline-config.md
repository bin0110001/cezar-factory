# Release pipeline configuration (#589)

Project-scoped, versioned configuration for the release pipeline (epic #588). Library:
`scripts/release/release_pipeline_config.py`. Schema (editor aid): `schemas/release-pipeline.schema.json`.
Examples: `config/release-pipeline.example.json`. The library is the authority: it also enforces cross-field rules
the JSON schema cannot express.

## Shape

`schemaVersion: release-pipeline/v1`, then `defaults` and `projects.<id>`. The effective spec for a project is the
built-in default, then `defaults` (optionally a named `preset`), then the project's own override, deep-merged.
Lists, including the stage graph, are replaced whole.

Fields: `mode` (`two-branch` | `three-branch`), `stages` (id, branch, kind), `triggers` (`manual`, calendar `schedule`,
`afterChanges` thresholds), `admission`, `tests` (`suites`, `required`), `candidateLifetimeHours`, `repair`,
`promotion` (`review`, `stable`, `soakMinutes`), `artifactRetentionDays`, `notifications`, `emergencyFix`.
Branch names and schedules are data; nothing in core code names them.

```yaml
schemaVersion: release-pipeline/v1
projects:
  tableflux:
    preset: weekly-calendar        # America/Detroit; day and hour are yours to set
    triggers: { schedule: { dayOfWeek: thursday, hour: 3, minute: 0 } }
    tests: { suites: [unit, e2e], required: [unit, e2e] }
  legacy-project: {}               # unchanged two-branch dev -> stable behaviour
```

## Defaults and presets

The default is the existing two-stage behaviour (`dev` to `stable`, human approval), so a project that sets nothing
keeps it. Presets `weekly-calendar` and `daily-calendar` select the three-branch graph and the `America/Detroit`
timezone but deliberately set no hour or day: validation reports them as required. Optional change thresholds
(`afterChanges`) are enabled independently of the calendar.

## Validation

Every error carries its path (`projects.p.promotion.bogus: unknown field`). Checked: unknown fields (an `x-` prefix is
the deliberate extension namespace), a schema version newer than the reader (refused, not guessed), branch/ref
collisions and unsafe branch names, stage graph versus mode, missing or undeclared suites, a three-branch pipeline with
no required suite, unsafe auto-promotion (`stable: auto` with no required suite), timezone and schedule completeness,
a daily schedule with a weekday, `maxActiveCandidates` other than 1, and out-of-range numbers.

## Candidates and operator control

`config_hash` hashes the effective spec. `bind_candidate` records the hash and a snapshot on a new candidate and never
replaces an existing binding; `spec_for_candidate` returns the candidate's own snapshot, so a policy change applies to
future candidate revisions only. `authorize_change` refuses an `agent` actor that weakens approval or security policy
(`promotion.stable`, `promotion.review`, `promotion.soakMinutes`, `admission.maxActiveCandidates`, `tests.required`);
an `operator` may. `config/release-pipeline*.json` is a protected policy asset, so the governance guard also blocks an
implementation diff that edits it.

## Migration, readback, dry run

`migrate` wraps a legacy flat spec as `defaults` and round-trips a v1 document unchanged; a newer version is refused.
`effective_config(doc, project)` is both the readback and the dry run: it validates and returns what would apply.
There is no command-line wrapper: Factory scripts run only from workflow `command:` steps, so a wrapper belongs with
the workflow that adopts this contract (#590 onward).
