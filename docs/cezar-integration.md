# Cezar integration model

This document records the Cezar behavior used by Factory workflows, checked
against the source in `cezar/packages/cezar/`. Runtime enablement and host state
must be verified on the target; source definitions alone do not prove what is
active.

## Workflow and skill discovery

Cezar loads project workflows from `.ai/cezar/workflows/` and then searches
operator-mounted workflow catalogs named by `CEZ_SHARED_WORKFLOWS_DIRS`. A
project workflow with the same name takes precedence over the shared copy.
Invalid workflow files are reported as load issues; the built-in
`quick-task` workflow remains available unless shadowed.

Skills resolve local first: `.ai/cezar/skills/`, `.ai/skills/`, `.agents/skills/`
and supported agent mirrors, then global skills, shared catalogs named by
`CEZ_SHARED_SKILL_DIRS`, configured team skills, and built-ins. A local skill
with the same name shadows a shared Factory skill. Missing team-skill network
access does not block startup.

Factory uses the shared checkout for workflows, skills, and command scripts.
`docs/shared-factory.md` is the operational source for the mounted path,
release gates, and Bazzite synchronization. A project override can change
effective behavior, so inspect the resolved workflow and skill when diagnosing
a specific project.

## Automation definitions and runtime state

Cezar stores project automation definitions in `.ai/cezar/automations.json`.
State, receipts, logs, and poll/mutation locks are separate generated files
under `.ai/cezar/`; they are not source configuration. Factory definitions
live in `automations/*.json` and are synchronized through the Cezar API by
Factory release workflows. The host-local `config/factory-projects.json` is
the only source of configured release targets.

Automations are disabled unless `CEZ_AUTOMATIONS=1`. A definition in the
Factory checkout or a successful source validation does not prove that a
project has enabled or synchronized it. Check the target Cezar project and its
runtime receipts for that evidence. Scheduled and event automations are
processed by Cezar; they queue ordinary workflow tasks.

The hourly `[factory] maintenance` automation owns the combined maintenance
workflow. That workflow runs stale-workable refresh and repository maintenance
before backlog classification, with independent bounded command steps, so a
later classification failure does not suppress either housekeeping step.
`[factory] intake` owns issue intake separately. The maintenance workflow is
the only automation definition that invokes `refresh-stale-workable.ps1`;
Source definitions do not prove which automations are enabled or their live
schedule state.

## Workflow execution contracts

Workflows own scripts: a workflow step is either an agent step (`skill` or
`prompt`) or a command step. Each command step invokes Factory scripts and
passes `{{task}}` when required. Skills and prompt text must not ask the agent to run
Factory scripts, repeat task discovery already performed by the workflow, or
write artifacts owned by a deterministic consumer.

Workflow steps can declare `outputSchema` for structured results. Cezar
validates workflow definitions and input/output schemas. Invalid required
output stops downstream consumers. Structured
artifacts are tied to run, step, attempt, and source digests; stale attempts
are ignored and integrity mismatches fail closed. Conditional steps can be
skipped with an explicit reason. Typed outcomes distinguish no-work, skipped,
blocked, task failure, infrastructure failure, timeout, and cancellation;
legacy records are mapped conservatively.

A check step may declare `timeoutSeconds`. Workflow definitions can also set
`maxRunDurationSeconds` (up to 24 hours) and `maxRepairAttempts` (0–20, default
3). Repair attempts are shared across check-to-agent loops and persisted with
the run. The active run deadline pauses for explicit human waits and resumes
with its stored remaining time; deadline expiry is distinct from a check
timeout, idle/no-progress, or user cancellation. Workflow-level run limits are
opt-in and must be set from observed duration evidence.

Finalizers are a contiguous, command-only suffix. Each must be explicitly
idempotent and bounded; their combined timeout cap is 300 seconds. Cezar
persists terminal intent and finalizer progress before execution, resumes
unfinished cleanup after restart, and preserves the original failure if
cleanup also fails. An interrupted command can be replayed before its result is
persisted, so its operation must tolerate replay.

## Child-task dispatch

Dispatch is on by default; `CEZ_DISPATCH=0` disables it. The engine limits
children in flight and reserves a child's requested budget from its parent.
Dispatch records and reports are durable. This is Cezar task dispatch, distinct
from untracked agent-side sub-agent behavior; do not describe the latter as a
fallback controlled by `CEZ_DISPATCH`.

## Operational boundaries and open evidence

- A Factory feature branch is never promoted directly. The implementation PR
  targets `dev`; independent review and any required human plan approval precede
  auto-merge. Stable promotion and Bazzite autodeploy follow the reviewed merge.
- Remote-only synchronization updates automation definitions. It does not
  install the full Factory layer or deploy files under `integrations/`.
- Verify Bazzite checkout, mounted runtime, and health on the host before
  claiming runtime parity. Never edit the host checkout by hand.
- Cezar Windows tests do not establish Linux/Bazzite process-tree behavior.
  Supported-host restart, concurrency, and runtime-parity evidence remains
  required where the workstream acceptance criteria call for it.
- `docs/skills-automation-polish-plan-2026-10-25.md` tracks remaining
  acceptance items and evidence. Do not infer pilot outcomes, live enablement,
  quota, or project verification from repository definitions.

## Deliverable

This document replaces the earlier integration audit with the current
source-backed execution and deployment model. The current plan and evidence
log remain authoritative for unfinished acceptance criteria.
