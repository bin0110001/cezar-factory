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

- **Workflow schema.** A step is either an agent step (`skill`/`prompt`) or a check step (`command`), never neither; `onFail.retry` may only point to an earlier step. Factory workflows follow this, and the factory tests enforce it. A check step failing past `onFail.max` fails the whole run.
- **No templating in check commands.** `{{task}}` is substituted only in agent prompts, so check steps cannot know the issue number. The agent writes a result file containing `issue`; `validate-result.ps1` and `route-state.ps1` read it from there. Agents never set `factory:*` labels themselves, except the first action of implement/fix, which calls `route-state.ps1 -Event start`.
- **Install locations.** Workflows go to `.ai/cezar/workflows/factory-*.yaml` and skills to `.ai/skills/factory-*/`. Both are committable (Cezar's own `.ai/cezar/.gitignore` only ignores runtime state). Check-step scripts are not assumed to be present in an isolated worktree: they run from the version-pinned `FACTORY_RUNTIME_ROOT` registered in the Cezar service.
- **Never bypass isolation for Factory assets.** `worktree: false` is an emergency/manual mode, not a Factory deployment mechanism. If a workflow cannot find a script, schema, or policy in a worktree, register or mount the Factory runtime and repair the workflow command; do not disable the worktree.
- **Automations are not files.** Cezar stores them in gitignored `.ai/cezar/automations.json` behind an HTTP API (`CEZ_AUTOMATIONS=1`), so the factory ships JSON definitions in Cezar's own schema and reconciles them with `sync-automations.ps1`. They are GitHub polls on `issue.labeled` with `changedLabels`, every five minutes, `maxRecords: 1` (also the only available throttle; Cezar has no per-automation concurrency setting).
- **Model-pinned automations.** Every Factory automation declares a Cezar `runner` and `model`, and `routing/automation-catalog.json` is the authority for that mapping. Planning and review use Claude `sonnet`; implementation and fix/review use Codex `gpt-5.6-terra`; maintenance, bounded investigation, and the hourly backlog-label audit use OpenCode `litellm/factory-small`. The audit is feature-gated, processes at most three issues, adds only `factory:new` plus type/risk labels, and preserves project labels. The catalog validator rejects drift. Synchronization creates automations paused, so a model mapping never begins polling or spending until an operator explicitly enables it.
- **Retry exhaustion cannot trigger an automation.** Cezar has no "workflow failed" event. When an implementation check exhausts `onFail.max` the run fails and the issue stays `factory:working`. The factory covers this two ways: an implementation the agent itself reports as failed is routed to `factory:investigate`, and the opt-in maintenance workflow labels issues stuck in `factory:working` for 24h as `factory:investigate`. Until maintenance is enabled, a failed run is visible in the Cezar cockpit only.
- **Independent review.** Every Cezar run starts a fresh agent session in its own worktree, so the review workflow does not share context with implementation. Use `agent:*` labels or a workflow override to pin a different runner.
- **Polling latency.** Automations poll, so a label change is picked up within the interval (five minutes by default).

## 0.2 Deliverable

This document serves as the deliverable for Phase 0.1: `docs/cezar-integration.md`
