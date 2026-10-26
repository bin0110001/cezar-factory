# Cezar Integration Model Validation

This document validates the Cezar integration model by examining the current Cezar implementation at D:\Projects\cezar and documenting how various aspects work.

## 0.1 Confirm Cezar file locations and lifecycle

### Current supported location for Cezar workflow definitions
Workflow definitions are stored in .ai/cezar/workflows/ directory as YAML files. According to the loadWorkflows function in packages/cezar/src/workflows/load.ts, the constant WORKFLOWS_DIR = '.ai/cezar/workflows' defines where workflow files are loaded from.

### Current supported location(s) for project-local skills
Skills are discovered in multiple locations with the following precedence (from packages/cezar/src/skills.ts and packages/cezar/src/skills-remote.ts):
1. .ai/cezar/skills/ - local workflow-specific skills
2. .ai/skills/ - project-level skills  
3. .agents/skills/ + agent mirrors - agent-specific skills
4. Global skills
5. Team repository skills (background cached in ~/.cache/cez/)

### How Cezar persists automations
Automations are persisted under .ai/cezar/ with the following files (from .ai/cezar/.gitignore):
- utomations.json - automation definitions
- utomations.json.tmp - temporary file for atomic writes
- utomation-state.json - current state of automations
- utomation-state.json.tmp - temporary file for atomic writes
- utomation-receipts.ndjson - append-only log of automation events
- utomation-receipts.ndjson.tmp - temporary file for atomic writes
- utomation-log.ndjson - execution log for debugging
- utomation-log.ndjson.tmp - temporary file for atomic writes
- utomation-poll.lock - cross-process lock for polling
- utomation-poll.lock.guard/ - lock guard directory
- utomation-mutation.lock.guard/ - mutation lock guard directory
- utomation-mutation.lock - cross-process lock for mutations

### File classification

#### Declarative configuration:
- .ai/cezar/config.json - Cezar-specific configuration (default models)
- .ai/agentic.config.json - machine-readable pipeline configuration (validation commands, labels, paths)
- .ai/cezar/workflows/*.{yaml,yml} - workflow definitions
- .ai/cezar/skills/*/SKILL.md - skill definitions (Markdown with optional YAML frontmatter)
- .ai/skills/*/SKILL.md - project-specific skills
- utomations.json - automation definitions (JSON)

#### Runtime state:
- .ai/cezar/runs.json - index of workflow runs (zod-validated, atomic tmp+rename, debounced save)
- .ai/cezar/runs/ - directory containing per-run NDJSON event files
- .ai/cezar/automation-state.json - current automation state
- .ai/cezar/automation-receipts.ndjson - automation event receipts
- .ai/cezar/automation-log.ndjson - automation execution log
- .ai/cezar/runs/ - workflow run event files (append-only NDJSON per run)
- .ai/cezar/worktrees/ - git worktrees for task isolation
- .ai/cezar/dispatch/ - task dispatch state
- .ai/cezar/attachments/ - file attachments from tool use
- .ai/cezar/tmp/ - temporary files
- .ai/cezar/drafts/ - draft task storage
- .ai/cezar/todos.json - todo lists
- .ai/cezar/tracker.json - issue tracker connections
- .ai/cezar/launch-key - secure launch key

#### Generated state:
- All files under .ai/cezar/ that are persisted from workflow execution are considered generated state, including:
  - Automation receipts and logs
  - Todo files
  - Tracker association lock files
  - Run event files in .ai/cezar/runs/
  - Worktree directories in .ai/cezar/worktrees/
  - Dispatch state in .ai/cezar/dispatch/
  - Attachments in .ai/cezar/attachments/

#### Safe to version control:
The following files are safe to version control (not ignored by .ai/cezar/.gitignore):
- .ai/cezar/config.json - Cezar configuration
- .ai/cezar/.gitignore - git ignore rules (though this controls what's ignored)
- Any workflow files placed in .ai/cezar/workflows/ (would need to be added to gitignore exceptions)
- Any skill files placed in .ai/cezar/skills/ (would need to be added to gitignore exceptions)

The .ai/cezar/.gitignore file shows that most runtime and generated state is intentionally not version controlled.

### How Cezar resolves local vs shared skills

> Discovery precedence is local-first: .ai/cezar/skills → .ai/skills → .agents/skills + agent mirrors → global → team repo.

This means:
1. First looks in .ai/cezar/skills/ (workflow-specific local skills)
2. Then .ai/skills/ (project-level shared skills)
3. Then .agents/skills/ + agent mirrors (agent-specific skills)
4. Then global skills (built-in or system-wide)
5. Finally team repository skills (cached in ~/.cache/cez/)

Missing directories are fine; team-skill loading never blocks on the network (background cache).

### Whether workflows can reference multiple skills
Yes, workflows can reference multiple skills. From the workflow types definition in `packages/cezar/src/workflows/types.ts`:

A workflow can be defined in two ways:
1. **Full steps**: An array of workflow steps where each step can specify a skill field

Becomes three agent steps, each running the corresponding skill on the task.

Workflows can also mix skill-based steps with custom prompt steps, checks, etc. in the full steps format.

### Automation support for GitHub events
From the "GitHub Automations" spec (2026-07-25-github-automations.md):
Automations support the following GitHub events:
1. Issue events:
    - `issue label added` and `issue label removed` (modelled as two selectable event types)
    - GitHub issue creation, updates, etc. through the search API

2. Pull request events:
    - GitHub PR creation, updates, etc. through the search API
    - PR-related events like review requested, ready for review, etc.

The spec specifically mentions:

- Users define bounded, polling-based GitHub triggers
- Matching issues or pull requests enqueue ordinary cezar tasks
- The automation system polls GitHub using `gh api` commands with search queries
- It supports filtering by author, assignee, label, relative-date, and result limits

Automations do **not** use webhooks; they use polling-based detection of GitHub events.

### Retry behavior and workflow failure semantics
From the workflow types definition (`packages/cezar/src/workflows/types.ts`):

Individual steps can have retry behavior defined through the `onFail` field:
```yaml
onFail:
  retry: "<step-id>"  # must reference an earlier step
  max: 2              # default, positive integer
```

Constraints:
- `onFail.retry` may only reference an **earlier** step (loops only go backwards)
- Step IDs must be unique within a workflow
- The `stepsIssue` validation function ensures these constraints

When a check step (shell command) fails (non-zero exit):
  - If `onFail` is defined, it loops back to the specified earlier step
  - The retry count is tracked and limited by the `max` value
  - After `max` retries, the workflow fails

### Typed step conditions and structured artifacts

Steps may declare standard JSON Schema under `when`. Cezar evaluates it against
the same `{ task, outputs }` object used by `inputSchema`. A match runs the
step; a value mismatch records the step as `skipped` with reason
`precondition_not_met`, before invoking its agent or command. Invalid condition
schemas are rejected as workflow-definition errors. No custom expression syntax
or free-form evaluation is introduced.

```yaml
- id: implement
  skill: factory-implement
  when:
    type: object
    required: [outputs]
    properties:
      outputs:
        type: object
        required: [preflight]
        properties:
          preflight:
            type: object
            required: [hasWork]
            properties:
              hasWork: { const: true }
```

The condition can only use outputs from completed, committed prior steps. Those
artifacts are checked against their attempt, content digest and source-step
digest before the condition is evaluated. A mismatch fails closed as an
infrastructure integrity failure; absent data simply fails the condition and
skips the step.

### Finalizers

Cleanup steps use a bounded, idempotent command suffix. They run after the
ordinary workflow reaches success, failure, no-work, or cancellation. Each step
must declare finalizer: true, idempotent: true, and timeoutSeconds; the sum
of finalizer timeouts in a workflow cannot exceed 300 seconds. Finalizers
cannot declare conditions, structured input/output contracts, failure maps, or
retry loops.

```yaml
- id: cleanup
  name: Remove temporary resources
  command: ./scripts/cleanup-task.ps1
  finalizer: true
  idempotent: true
  timeoutSeconds: 30
```

Cezar persists terminal intent before starting cleanup. After a restart, it
replays a finalizer whose status was still running, skips completed finalizers,
and does not replay a failure already durably recorded. A command interrupted
before its result was stored can run again, so finalizer commands must be
safe to repeat. Cleanup failure is recorded separately; it does not replace an
existing task failure, and it fails an otherwise successful run.

### Child-task/dispatch behavior

> Owner-approved exception (2026-09-12): task dispatch (`cez task create`, spec `.ai/specs/2026-09-10-dispatch.md`) is default-on; `CEZ_DISPATCH=0` turns it off. Its brakes live in the engine — four children in flight, a child's budget carved out of its parent's — and with dispatch off the agent fanned out through its own sub-agents instead (unbudgeted and invisible (live run 3f7eaf02, 4.3M tokens).

Key points:
- Task dispatch is enabled by default (`CEZ_DISPATCH=1`)
- Limits: four children in flight simultaneously
- Resource management: a child's budget is carved out of its parent's budget
- When disabled (`CEZ_DISPATCH=0`), agents fan out through their own sub-agents instead (unbudgeted and invisible)

### Limitations affecting factory design

Based on my analysis of the Cezar codebase and documentation, here are key limitations that affect the factory design:

1. **Automation opt-in requirement**: 
   - GitHub automations are opt-in behind `CEZ_AUTOMATIONS=1` (strict activation, off by default)
   - This means factories must explicitly enable this feature flag

2. **No webhook support**: 
   - Automations use polling only, not webhooks
   - This introduces latency and requires careful tuning of polling intervals
   - Factories must account for polling-based delay in their design

3. **Local-first skill resolution**: 
   - Skills are resolved locally first, which is good for factory overrides
   - But team repository skills require background caching and may have staleness issues

4. **Workflow file location constraint**: 
   - Workflows must be in `.ai/cezar/workflows/` to be auto-loaded
   - Factory synchronization must place workflows in this exact location

5. **State isolation**: 
   - Each run gets its own git worktree at `.ai/cezar/worktrees/<runId>`
   - Factory design must account for worktree cleanup

6. **Runtime data accumulation**: 
   - Logs and state files accumulate over time and need periodic cleanup
   - Factory design must account for worktree cleanup
   - Factories need to either preserve this or provide their own validation configuration

7. **Label taxonomy**: 
   - Cezar uses a specific label pipeline (review, changes-requested, qa, qa-failed, merge-queue, blocked, do-not-merge)
   - Factories must align with or override this taxonomy

8. **Schedules are bounded to fixed Cezar intervals**:
   - Cezar supports `daily`, `weekdays`, `weekly`, and `hours` schedules; hourly uses
     `{ "type": "hours", "every": 1 }` and runs in the cockpit time zone.
   - A scheduled backlog audit must stay capped and opt-in because it can spend model budget and alter labels.

9. **Deterministic workflow IDs required**: 
   - Workflow step IDs must be unique and `onFail.retry` must reference earlier steps
   - Factory-generated workflows must comply with these constraints

10. **Skill prompt constraints**: 
    - Skill prompts should ideally use `{{task}}` placeholder for the portable shorthand to work
    - Custom prompts break the `skills:` shorthand optimization

## Design consequences (verified against the Cezar source)

The active Factory deployment uses Cezar as the execution service. Automation
`runner` and `model` fields select the configured Codex, Claude, or Factory
gateway route directly; OpenHands is not an execution dependency. The
OpenHands provider files and evidence retained in this repository describe a
legacy integration and must not be used to diagnose current automation runs.

- **Workflow execution and artifacts.** A workflow step is an agent step (`skill`/`prompt`) or a command step. Workflows own scripts: a command step invokes each Factory script and passes `{{task}}` when that script needs the selected task. Steps that declare `outputSchema` require a bounded JSON result; deterministic command steps materialize and validate those artifacts before a consumer acts. Agent prompts must not ask the agent to run Factory scripts, repeat workflow discovery, or write files that a deterministic materializer owns. Failure past a step's configured retry limit fails the run unless a documented finalizer or failure route handles it.
- **Runtime and isolation.** Workflows and skills can come from the shared Factory mount or a project override. Command steps use the registered `FACTORY_RUNTIME_ROOT` for Factory scripts; do not copy scripts into a task worktree or disable worktree isolation to work around a missing runtime mount.
- **Automation definitions and profiles.** Automation JSON definitions are reconciled through the Cezar API by `sync-automations.ps1`; the host-local `config/factory-projects.json` is the explicit target registry. `routing/automation-catalog.json` is the source for configured runner/model profiles. Current mappings use Claude Sonnet for planning and review, the configured Factory gateway for investigation, ambiguous maintenance audits, and small implementation, GPT-5.6 Luna for medium implementation, and GPT-6.1 Sol for large implementation. Intake is script-only; its configured profile does not itself prove an agent call. These mappings describe configured routes, not which automations are enabled on any live project; enablement and runtime receipts must be checked in that project's Cezar configuration.
- **Maintenance ownership.** The feature-gated hourly `[factory] maintenance` automation runs stale-workable refresh and deterministic repository maintenance before backlog classification, so a later classification failure does not suppress those independent tasks. `[factory] intake` owns issue intake separately. The maintenance workflow is the only automation definition that invokes `refresh-stale-workable.ps1`; it is bounded to two issues with no updates for 24 hours per run. Before toggling a lifecycle label, the script rechecks the issue's open state, `updatedAt` revision, and label set. Successful refreshes advance the cooldown. Schedules remain unchanged unless a reviewed migration explicitly changes them. Source definitions do not prove a project's live feature flag or schedule state.
- **Retry exhaustion and watchdog.** Cezar has no workflow-failure event that starts another automation. A failed run stays visible; the watchdog is not a retry-exhaustion recovery path. `scripts/watchdog-automations.ps1` accepts the live top-level run array and two explicit compatibility envelopes, and cancels only positively owned runs whose runner, lease, heartbeat, progress, and deadline evidence all show a stall. Current run records may lack the required liveness fields, in which case the watchdog skips with a reason. Elapsed time alone never triggers cancellation.
- **Typed outcomes, workflow contracts and artifact provenance (partial FND-01/02/RUN-02).** Run records carry outcome kinds and stable reason codes alongside status; legacy records map conservatively, and the task header explains outcomes. Workflow steps can declare JSON Schema input/output contracts. Inputs validate before dispatch. Validated outputs are tagged with attempt and source digests and committed with the completed step before downstream dispatch. Consumers ignore stale attempts and fail closed on digest or source mismatches. Checks support no-work, step skip, and typed blocked outcomes. Contract failures have their own typed reason codes. Checks may map exit codes to normalized failure categories; when taxonomy is declared, only mapped work-verdict/test-regression codes can enter an agent repair loop, while infrastructure, provider, timeout and malformed-result categories stop with typed outcomes. Multi-process index-writer races, bounded artifact-retention policy, restart/concurrent replay on a supported Linux/Bazzite Cezar host, agent-produced output contracts and broader Factory workflow adoption remain outstanding.
- **Independent review.** Every Cezar run starts a fresh agent session in its own worktree, so the review workflow does not share context with implementation. Use `agent:*` labels or a workflow override to pin a different runner.
- **Polling latency.** Event automations poll, so a label change is picked up within the configured interval (five minutes by default). Scheduled automations use their configured cadence.

## 0.2 Deliverable

This document serves as the deliverable for Phase 0.1: `docs/cezar-integration.md`
