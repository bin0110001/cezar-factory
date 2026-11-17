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

## Trigger fields (#591)

`triggers.afterChanges` also accepts `paths` (globs that count as relevant), `minElapsedHours`, `maxDelayHours`,
`cooldownMinutes`, `quietHours` (`start`/`end` hour, optional `timezone`, may wrap midnight) and `combinator`
(`any` | `all`). `triggers.missedRun` (`skip` | `coalesce`), `missedGraceMinutes` and `priority` (order of
`schedule`, `change`, `manual`) apply across sources. Evaluation is in `docs/release-triggers.md`.

## Policy editor API (#632)

Server side of the Control Center's project policy editor, in `cezar/packages/cezar/src/release-candidates/` (contract:
`packages/contract/src/release-pipeline-policy.ts`).

- `POST /api/v1/workspace/release-pipeline-policy/preview`: validates a project's override against the whole document and returns every
  error with its path, the effective configuration, its hash, the hash of what is saved today, and the next three runs (UTC, DST-correct,
  from the project's timezone). It writes nothing.
- `POST /api/v1/workspace/release-pipeline-policy`: local machine only (403 from a remote cockpit); requires a reason; validates; refuses
  a stale editor (`expectedCurrentHash` is compared with the saved effective hash, 409); appends an audit entry (id, time, actor, project,
  before and after hash, redacted reason) and then writes `~/.cezar/release/pipeline-policy.json` atomically. The audit entry is written
  first so a change cannot exist unrecorded; a failed write returns 500 and nothing is reported saved. Existing candidates keep the
  configuration they were bound to (`appliesTo: future-candidates`).
- `GET /api/v1/workspace/release-pipeline-policy`: the saved overrides (redacted), each project's effective hash, and the last 50 audit
  entries.

The policy lives under the home directory, outside any repository, so a coding agent's change to a repository cannot reach it.

**Parity.** The release engine reads the Python library; the preview is a TypeScript port. `tests/fixtures/release-pipeline-cases.json`
is generated from the Python authority (23 cases including both pilot schedules and the unsafe ones). The Python test and the TypeScript
test both check it: validity, error paths and the effective hash must agree, so the editor shows what the engine will enforce. After
changing the Python rules, regenerate the fixture and fix the port until both suites pass.

Gap: the editor form itself (the React UI that calls these endpoints, via `getPipelinePolicy`, `previewPipelinePolicy` and
`savePipelinePolicy`) is not built in this change.
