# Cezar Development Factory Workplan

## Goal

Build a reusable, version-controlled development factory around Cezar where:

- **GitHub** is the durable source of truth for work state.
- **Cezar Automations** decide when work should start.
- **Cezar Workflows** define the execution pipeline.
- **Cezar Skills** define how each agent role performs its work.
- **Project repositories** contain project-specific rules, validation, and overrides.
- A dedicated **factory repository** owns reusable workflows, skills, policies, templates, and synchronization tooling.
- Factory updates are **versioned, reviewable, reproducible, and safely synchronized** into individual projects.

---

# Phase 0 — Validate Cezar Integration Model

## 0.1 Confirm Cezar file locations and lifecycle

- [x] Confirm the current supported location for Cezar workflow definitions.
- [x] Confirm the current supported location\(s\) for project-local skills.
- [x] Confirm how Cezar persists automations.
- [x] Identify which files are:
  - [x] Declarative configuration.
  - [x] Runtime state.
  - [x] Generated state.
  - [x] Safe to version control.
- [x] Confirm how Cezar resolves local vs shared skills.
- [x] Confirm whether workflows can reference multiple skills.
- [x] Confirm automation support for:
  - [x] GitHub issue labels.
  - [x] GitHub issue changes.
  - [x] Pull request events.
  - [x] Scheduled runs.
- [x] Confirm retry behavior and workflow failure semantics.
- [x] Confirm child-task/dispatch behavior.
- [x] Document any Cezar limitations that affect the factory design.

### Deliverable

- [x] `docs/cezar-integration.md`

---

# Phase 1 — Create the Factory Repository

Create a dedicated repository such as:

`cezar-factory`

## 1.1 Initial repository structure

- [x] Create the repository.
- [x] Add the following structure:

```text
cezar-factory/
├── README.md
├── VERSION
│
├── skills/
│   ├── factory-plan/
│   │   └── SKILL.md
│   ├── factory-implement/
│   │   └── SKILL.md
│   ├── factory-review/
│   │   └── SKILL.md
│   ├── factory-fix/
│   │   └── SKILL.md
│   ├── factory-investigate/
│   │   └── SKILL.md
│   └── factory-learn/
│       └── SKILL.md
│
├── workflows/
│   ├── plan.yaml
│   ├── implement.yaml
│   ├── review.yaml
│   ├── fix-review.yaml
│   ├── investigate.yaml
│   └── maintenance.yaml
│
├── automations/
│   ├── needs-plan.yaml
│   ├── ready-to-implement.yaml
│   ├── ready-to-review.yaml
│   ├── changes-requested.yaml
│   └── maintenance.yaml
│
├── policies/
│   ├── labels.yaml
│   ├── risk.yaml
│   ├── retry.yaml
│   ├── definition-of-ready.md
│   ├── definition-of-done.md
│   └── escalation.md
│
├── schemas/
│   ├── plan.schema.json
│   ├── implementation-result.schema.json
│   ├── review-result.schema.json
│   └── investigation-result.schema.json
│
├── templates/
│   ├── factory.config.yaml
│   ├── agentic.config.json
│   └── gitignore.fragment
│
├── scripts/
│   ├── install.ps1
│   ├── update.ps1
│   ├── verify.ps1
│   └── diff.ps1
│
└── docs/
    ├── lifecycle.md
    ├── synchronization.md
    └── project-integration.md
```

## 1.2 Repository conventions

- [x] Define semantic versioning rules for the factory.
- [x] Add `VERSION`.
- [x] Add changelog conventions.
- [x] Decide whether releases use:
  - [ ] Git tags.
  - [ ] GitHub Releases.
  - [x] Both.
- [x] Define compatibility policy between factory versions and Cezar versions.
- [x] Document breaking-change rules.

---

# Phase 2 — Define the GitHub Factory State Model

GitHub should remain the durable state machine.

## 2.1 Primary workflow-state labels

Create a mutually exclusive set of factory-state labels:

- [x] `factory:new`
- [x] `factory:needs-plan`
- [x] `factory:needs-help`
- [x] `factory:ready`
- [x] `factory:working`
- [x] `factory:review`
- [x] `factory:changes-requested`
- [x] `factory:human-review`
- [x] `factory:blocked`
- [x] `factory:done`

## 2.2 Work-type labels

- [x] `type:bug`
- [x] `type:feature`
- [x] `type:refactor`
- [x] `type:test`
- [x] `type:docs`
- [x] `type:maintenance`

## 2.3 Risk labels

- [x] `risk:low`
- [x] `risk:medium`
- [x] `risk:high`

## 2.4 Optional routing labels

- [x] `agent:codex`
- [x] `agent:claude`
- [x] `agent:either`

## 2.5 State-transition rules

Document valid transitions.

```text
factory:new
    ↓
factory:needs-plan
    ├──→ factory:needs-help
    ↓
factory:ready
    ↓
factory:working
    ↓
factory:review
    ├──→ factory:changes-requested
    │           ↓
    │      factory:working
    │
    └──→ factory:human-review
                ↓
           factory:done
```

- [x] Define legal transitions.
- [x] Define which automation owns each transition.
- [x] Define which transitions require humans.
- [x] Define how blocked work is resumed.
- [x] Prevent issues from carrying conflicting factory-state labels.

### Deliverable

- [x] `policies/labels.yaml`
- [x] `docs/lifecycle.md`

---

# Phase 3 — Define Factory Policies

## 3.1 Definition of Ready

An issue should not enter `factory:ready` until it has:

- [x] Clear objective.
- [x] Acceptance criteria.
- [x] Known non-goals where useful.
- [x] Relevant dependencies identified.
- [x] Risks identified.
- [x] Enough implementation context for an agent to begin.
- [x] No unresolved blocking questions.
- [x] Appropriate work type.
- [x] Appropriate risk level.

### Deliverable

- [x] `policies/definition-of-ready.md`

## 3.2 Definition of Done

Define common completion rules.

- [x] Acceptance criteria satisfied.
- [x] Relevant targeted tests pass.
- [x] Required full validation passes.
- [x] No unresolved reviewer findings.
- [x] Required documentation updated.
- [x] No accidental unrelated changes.
- [x] Required PR exists.
- [x] Human review completed where required.

### Deliverable

- [x] `policies/definition-of-done.md`

## 3.3 Retry policy

Initial target:

```text
Implementation attempt 1
    ↓ failure
Implementation attempt 2
    ↓ failure
Root-cause investigation
    ↓
Retry or escalate
```

- [x] Define maximum implementation retries.
- [x] Define maximum review/fix rounds.
- [x] Define environment-failure handling.
- [x] Define flaky-test handling.
- [x] Define when the factory must stop automatically modifying code.

### Deliverable

- [x] `policies/retry.yaml`

## 3.4 Escalation policy

- [x] Define when to add `factory:needs-help`.
- [x] Define the summary an agent must post before escalation.
- [x] Require:
  - [x] Observed problem.
  - [x] Attempts made.
  - [x] Relevant logs/artifacts.
  - [x] Current hypothesis.
  - [x] Recommended human decision.

### Deliverable

- [x] `policies/escalation.md`

---

# Phase 4 — Build the Core Skills

Keep skills reusable, role-focused, and relatively compact.

## 4.1 `factory-plan`

Responsibilities:

- [x] Read the issue.
- [x] Inspect relevant repository context.
- [x] Identify ambiguities.
- [x] Identify likely dependencies.
- [x] Define acceptance criteria.
- [x] Define non-goals.
- [x] Propose implementation steps.
- [x] Identify risks.
- [x] Decide whether decomposition is needed.
- [x] Update the issue with the plan.
- [x] Route to:
  - [x] `factory:ready`
  - [x] `factory:needs-help`

Must not:

- [x] Implement production changes.

## 4.2 `factory-implement`

Responsibilities:

- [x] Read approved issue plan.
- [x] Follow acceptance criteria.
- [x] Use project-specific skills.
- [x] Make the smallest appropriate change.
- [x] Add/update tests.
- [x] Run targeted validation where appropriate.
- [x] Report structured completion information.
- [x] Prepare/update PR.

## 4.3 `factory-review`

Responsibilities:

- [x] Independently review the implementation.
- [x] Compare changes against issue acceptance criteria.
- [x] Check for missed edge cases.
- [x] Check architecture/conventions.
- [x] Check tests for meaningful coverage.
- [x] Check unrelated changes.
- [x] Check backward compatibility where relevant.
- [x] Produce actionable findings.
- [x] Route to:
  - [x] `factory:changes-requested`
  - [x] `factory:human-review`

Prefer a different agent/context from implementation.

## 4.4 `factory-fix`

Responsibilities:

- [x] Read review findings.
- [x] Address only valid findings.
- [x] Avoid unrelated cleanup.
- [x] Update tests as needed.
- [x] Re-run validation.
- [x] Return to review.

## 4.5 `factory-investigate`

Responsibilities:

- [x] Stop blindly modifying code.
- [x] Analyze repeated failures.
- [x] Classify failure as:
  - [x] Implementation.
  - [x] Test.
  - [x] Flaky test.
  - [x] Environment.
  - [x] Dependency.
  - [x] Merge conflict.
  - [x] Requirements.
  - [x] Architecture.
  - [x] Unknown.
- [x] Recommend next action.
- [x] Route back to implementation only when justified.
- [x] Otherwise escalate.

## 4.6 `factory-learn`

Responsibilities:

- [x] Review successful work and failures.
- [x] Identify durable reusable knowledge.
- [x] Avoid storing task-specific/transient facts.
- [x] Recommend or update:
  - [x] Project skills.
  - [x] Testing guidance.
  - [x] Architecture documentation.
  - [x] Agent instructions.

Initially:

- [x] Run manually or in observation-only mode.
- [x] Require review before automatically modifying shared factory skills.

---

# Phase 5 — Define Structured Agent Outputs

Avoid requiring later stages to parse large free-form responses.

## 5.1 Planning result schema

Include:

- [x] Objective.
- [x] Acceptance criteria.
- [x] Non-goals.
- [x] Risks.
- [x] Dependencies.
- [x] Suggested work breakdown.
- [x] Required project skills.
- [x] Unresolved questions.
- [x] Ready/not-ready status.

## 5.2 Implementation result schema

Include:

- [x] Status.
- [x] Summary.
- [x] Files changed.
- [x] Tests run.
- [x] Test result.
- [x] Acceptance criteria status.
- [x] Known concerns.
- [x] Follow-up suggestions.
- [x] Durable knowledge candidates.

## 5.3 Review result schema

Include:

- [x] Approval/change-request status.
- [x] Blocking findings.
- [x] Non-blocking findings.
- [x] Acceptance criteria verification.
- [x] Test adequacy.
- [x] Risk observations.

## 5.4 Investigation result schema

Include:

- [x] Failure classification.
- [x] Evidence.
- [x] Attempts reviewed.
- [x] Root-cause hypothesis.
- [x] Confidence.
- [x] Recommended action.
- [x] Whether automatic retry is appropriate.

---

# Phase 6 — Build the Core Cezar Workflows

Keep workflows short enough that GitHub remains a durable checkpoint between stages.

## 6.1 Plan workflow

```text
Issue
  ↓
factory-plan
  ↓
validate plan
  ↓
update GitHub state
```

- [x] Invoke `factory-plan`.
- [x] Validate result schema.
- [x] Verify Definition of Ready.
- [x] Update issue.
- [x] Set `factory:ready` or `factory:needs-help`.

## 6.2 Implement workflow

```text
factory:ready
      ↓
implementation
      ↓
targeted tests
      ↓
retry if appropriate
      ↓
full verification
      ↓
PR
      ↓
factory:review
```

- [x] Mark issue `factory:working`.
- [x] Invoke implementation skill.
- [x] Run targeted tests.
- [x] Retry within configured limit.
- [x] Run required verification.
- [x] Create/update PR.
- [x] Mark issue `factory:review`.

## 6.3 Review workflow

```text
PR
 ↓
independent review
 ↓
validate review output
 ↓
changes-requested OR human-review
```

- [x] Use independent context/agent where possible.
- [x] Invoke `factory-review`.
- [x] Post findings.
- [x] Set state appropriately.

## 6.4 Fix-review workflow

```text
changes-requested
      ↓
factory-fix
      ↓
targeted validation
      ↓
factory:review
```

- [x] Feed only actionable review findings.
- [x] Run targeted tests.
- [x] Update PR.
- [x] Return issue to review.

## 6.5 Investigate workflow

```text
repeated failure
      ↓
factory-investigate
      ↓
classification
      ↓
retry OR needs-help
```

- [x] Gather compact failure evidence.
- [x] Avoid dumping full logs into the prompt.
- [x] Classify failure.
- [x] Route appropriately.

## 6.6 Maintenance workflow

Defer until the core loop is stable.

Potential uses:

- [ ] Stale issue review.
- [ ] Dependency maintenance.
- [ ] Flaky-test review.
- [ ] Documentation drift.
- [ ] Dead-code candidates.
- [ ] Unhandled TODO/FIXME review.

---

# Phase 7 — Build Cezar Automations

Automations should primarily answer:

> When should a workflow start?

Avoid putting complex implementation logic into automations.

## 7.1 Planning automation

Trigger:

- [x] Issue gains `factory:needs-plan`.

Action:

- [x] Launch `plan` workflow.

## 7.2 Implementation automation

Trigger:

- [x] Issue gains `factory:ready`.

Action:

- [x] Launch `implement` workflow.

Safeguards:

- [x] Do not start if already `factory:working`.
- [x] Do not start if blocked.
- [x] Respect configured concurrency limit.

## 7.3 Review automation

Trigger:

- [x] Issue/PR enters `factory:review`.

Action:

- [x] Launch `review` workflow.

## 7.4 Rework automation

Trigger:

- [x] Issue gains `factory:changes-requested`.

Action:

- [x] Launch `fix-review` workflow.

## 7.5 Investigation automation

Trigger:

- [x] Workflow reaches retry limit.
- [x] Issue receives an investigation-specific label.

Action:

- [x] Launch `investigate` workflow.

## 7.6 Maintenance automation

- [x] Add only after core production flow is proven.
- [x] Run on scheduled cadence.
- [x] Keep maintenance workflows separate from feature delivery.

---

# Phase 8 — Project Integration Model

Each project should contain project-owned factory configuration.

Example:

```text
project/
├── .ai/
│   ├── factory/
│   │   ├── factory.config.yaml
│   │   ├── VERSION
│   │   └── overrides/
│   │
│   ├── skills/
│   │   ├── project-architecture/
│   │   │   └── SKILL.md
│   │   └── project-testing/
│   │       └── SKILL.md
│   │
│   └── ...
│
├── scripts/
│   └── factory/
│       ├── test-changed.ps1
│       ├── test-full.ps1
│       └── verify.ps1
│
└── ...
```

## 8.1 Project-owned content

Version control these directly in the project repository:

- [x] Factory version pin.
- [x] Project factory configuration.
- [x] Project-specific skills.
- [x] Architecture instructions.
- [x] Project-specific validation scripts.
- [x] Project-specific workflow extensions.
- [x] Project-specific overrides.

## 8.2 Factory-owned synchronized content

Install from `cezar-factory`:

- [x] Generic factory skills.
- [x] Generic workflows.
- [x] Automation definitions/templates.
- [x] Shared policies.
- [x] Shared schemas.

## 8.3 Runtime content

Do **not** version-control by default:

- [x] Execution logs.
- [x] Temporary worktrees.
- [x] Agent session state.
- [x] Runtime task caches.
- [x] Other Cezar operational data.

Add required entries to project `.gitignore`.
- [x] Add required entries to project `.gitignore`.

---

# Phase 9 — Factory Synchronization Process

The synchronization system should make factory upgrades deterministic and reviewable.

## 9.1 Factory configuration

Each project should include:

```yaml
factory:
  source: "cezar-factory"
  version: "0.1.0"

workflows:
  - plan
  - implement
  - review
  - fix-review
  - investigate

skills:
  - factory-plan
  - factory-implement
  - factory-review
  - factory-fix
  - factory-investigate

features:
  knowledge_extraction: false
  maintenance: false

project:
  type: godot

validation:
  changed: "./scripts/factory/test-changed.ps1"
  full: "./scripts/factory/test-full.ps1"
  verify: "./scripts/factory/verify.ps1"
```

- [x] Finalize config schema.
- [x] Validate config during synchronization.

## 9.2 Managed-file markers

Every synchronized file should identify its source.

Example YAML header:

```yaml
# GENERATED BY CEZAR-FACTORY
# factory-version: 0.2.1
# source: workflows/implement.yaml
# DO NOT EDIT DIRECTLY
```

Example Markdown header:

```text
<!--
managed-by: cezar-factory
factory-version: 0.2.1
source: skills/factory-review/SKILL.md
-->
```

- [x] Add managed-file marker generation.
- [x] Ensure update script overwrites only managed files.
- [x] Refuse destructive updates when file ownership is ambiguous.

## 9.3 Install process

Create:

```powershell
./scripts/install.ps1
```

Responsibilities:

- [x] Read project factory config.
- [x] Resolve requested factory version.
- [x] Verify compatibility.
- [x] Copy selected factory skills.
- [x] Copy selected workflows.
- [x] Reconcile automations.
- [x] Copy required policies/schemas.
- [x] Add/update managed-file metadata.
- [x] Validate installation.
- [x] Print resulting changes.

## 9.4 Update process

Create:

```powershell
./scripts/update.ps1
```

Expected flow:

```text
Read current project config
        ↓
Read pinned factory version
        ↓
Resolve requested upgrade version
        ↓
Compare manifests
        ↓
Update managed files
        ↓
Remove obsolete managed files
        ↓
Preserve project files/overrides
        ↓
Validate
        ↓
Show diff
```

- [x] Support explicit version upgrades.
- [x] Do not automatically track `main`.
- [x] Require version pin changes for upgrades.
- [x] Produce a readable summary:

```text
Factory 0.1.0 → 0.2.0

Updated:
  workflow/implement.yaml
  skills/factory-review/SKILL.md

Added:
  skills/factory-investigate/SKILL.md

Removed:
  skills/factory-debug/SKILL.md

Project-owned files:
  unchanged

Validation:
  PASS
```

## 9.5 Diff process

Create:

```powershell
./scripts/diff.ps1
```

Responsibilities:

- [x] Compare installed factory files with pinned source version.
- [x] Detect locally modified managed files.
- [x] Detect missing managed files.
- [x] Detect obsolete managed files.
- [x] Detect unexpected unmanaged files in managed directories.
- [x] Exit non-zero when drift exists.

Potential CI use:

```text
factory diff
    ↓
PASS → repository factory installation is reproducible
FAIL → checked-in generated files have drifted
```

## 9.6 Verification process

Create:

```powershell
./scripts/verify.ps1
```

Check:

- [x] Factory config is valid.
- [x] Pinned version exists.
- [x] Installed managed files match source version.
- [x] Required skills exist.
- [x] Required workflows exist.
- [x] Automation definitions are valid.
- [x] Validation scripts exist.
- [x] Project overrides reference valid base components.
- [x] No runtime files are unintentionally tracked.

---

# Phase 10 — Automation Synchronization

Treat automation definitions as declarative factory source even if Cezar stores live automation state elsewhere.

## 10.1 Canonical automation definitions

Keep reusable definitions in:

```text
cezar-factory/automations/
```

Each should define:

- [x] Name.
- [x] Trigger.
- [x] Required labels/filters.
- [x] Workflow.
- [x] Enabled default.
- [x] Optional concurrency policy.

## 10.2 Reconciliation process

The sync layer should:

- [x] Read canonical automation definitions.
- [x] Read project overrides.
- [x] Compare against current Cezar automation state.
- [x] Create missing automations.
- [x] Update changed factory-managed automations.
- [x] Leave unmanaged automations untouched.
- [x] Disable/remove obsolete factory-managed automations safely.
- [x] Record the factory version responsible for each managed automation where possible.

## 10.3 Safety

- [x] Never delete an automation unless it is explicitly marked factory-managed.
- [x] Support dry-run mode.
- [x] Print automation changes before applying.
- [x] Log reconciliation results.

---

# Phase 11 — Project Overrides

Avoid editing synchronized files directly.

## 11.1 Skill extensions

Prefer composition:

```text
factory-review
+
tableflux-review
```

rather than modifying `factory-review`.

- [x] Define how project skills extend generic factory behavior.
- [x] Document skill precedence.
- [x] Ensure factory upgrades do not overwrite project skills.

## 11.2 Workflow overrides

Support only when composition is insufficient.

Potential approach:

```text
.ai/factory/overrides/workflows/
```

- [x] Decide whether overrides are:
  - [x] Full replacement.
  - [ ] Patch/merge.
  - [ ] Project-specific workflow selected instead.
- [x] Prefer explicit replacement over complicated YAML patching for v1.

## 11.3 Policy overrides

Allow projects to change:

- [x] Risk classification.
- [x] Validation requirements.
- [x] Retry limits.
- [x] Required human gates.
- [x] Enabled factory features.

---

# Phase 12 — Standard Project Validation Interface

Give every project a predictable interface.

Target:

```text
scripts/factory/test-changed.ps1
scripts/factory/test-full.ps1
scripts/factory/verify.ps1
```

## 12.1 `test-changed`

- [x] Run tests most relevant to changed files.
- [x] Produce compact output.
- [x] Store verbose logs separately.
- [x] Return reliable exit code.

## 12.2 `test-full`

- [x] Run the broader project suite.
- [x] Produce summarized output.
- [x] Store full artifacts separately.
- [x] Return reliable exit code.

## 12.3 `verify`

Potential checks:

- [x] Build.
- [x] Lint/static analysis.
- [x] Syntax validation.
- [x] Required tests.
- [x] Generated-file checks.
- [x] Packaging/export checks where relevant.

## 12.4 LLM-friendly result format

Prefer concise structured output such as:

```json
{
  "status": "failed",
  "stage": "test",
  "passed": 417,
  "failed": 2,
  "failures": [
    {
      "test": "NetworkSessionTest.join_existing_session",
      "message": "Expected READY, received CONNECTING",
      "artifact": "artifacts/test-failure-1.log"
    }
  ]
}
```

- [x] Keep large logs out of normal agent context.
- [x] Provide artifact paths for deeper investigation.

---

# Phase 13 — Risk-Based Human Gates

## Low risk

Examples:

- [x] Documentation.
- [x] Tests.
- [x] Minor UI.
- [x] Small isolated bug fixes.

Flow:

```text
implement → test → review → human-review
```

Potential future option:

- [x] Allow additional automation after the system proves reliable.

## Medium risk

Examples:

- [x] Feature work.
- [x] Refactoring.
- [x] Networking changes.
- [x] Persistence changes.

Requirements:

- [x] Independent review.
- [x] Human PR review.

## High risk

Examples:

- [x] Authentication.
- [x] Security.
- [x] Data migration.
- [x] Billing.
- [x] Large architectural changes.
- [x] Deployment infrastructure.

Requirements:

- [x] Human plan approval.
- [x] Implementation.
- [x] Full validation.
- [x] Independent review.
- [x] Human merge.

---

# Phase 14 — Dispatch and Parallel Work

Use Cezar child-task dispatch only when decomposition provides clear value.

## 14.1 Initial use cases

- [x] Independent test creation.
- [x] Parallel research.
- [x] Independent codebase analysis.
- [x] Clearly isolated implementation components.

## 14.2 Avoid initially

- [x] Multiple child agents editing strongly overlapping files.
- [x] Unbounded recursive task decomposition.
- [x] Large numbers of tiny child tasks.

## 14.3 Guardrails

- [x] Set maximum in-flight child count.
- [x] Set cost/token budget.
- [x] Require parent integration step.
- [x] Require final validation after integration.

---

# Phase 15 — Knowledge Feedback Loop

Add only after the core factory is stable.

```text
Task
 ↓
Implementation
 ↓
Failure/review feedback
 ↓
Reusable discovery
 ↓
Project knowledge
 ↓
Future tasks improve
```

## 15.1 Initial mode

- [x] Agent proposes knowledge updates.
- [x] Human reviews them.
- [x] Do not auto-edit shared factory skills initially.

## 15.2 Project-level knowledge

Good targets:

- [x] Testing requirements.
- [x] Architecture rules.
- [x] Common environment setup.
- [x] Known framework pitfalls.
- [x] Project conventions.

## 15.3 Factory-level knowledge

Promote project findings to shared factory skills only when:

- [x] Applicable across multiple repositories.
- [x] Stable.
- [x] Not technology/project-specific.
- [x] Reviewed.

---

# Phase 16 — Pilot on One Repository

Use one repository as the proving ground before rolling out globally.

Recommended pilot characteristics:

- [x] Active backlog.
- [x] Good automated tests.
- [x] Mix of bugs and features.
- [x] Existing Cezar usage.

## Pilot steps

- [ ] Install factory `0.1.0`.
- [ ] Configure labels.
- [ ] Add project validation scripts.
- [ ] Add project architecture/testing skills.
- [ ] Enable planning automation only.
- [ ] Process several real issues.
- [ ] Tune planning skill.
- [ ] Enable implementation automation.
- [ ] Process several low-risk issues.
- [ ] Enable review automation.
- [ ] Exercise rework loop.
- [ ] Exercise investigation/escalation.
- [ ] Test factory upgrade process.
- [ ] Test rollback to previous factory version.

---

# Phase 17 — CI for the Factory Itself

The factory repository should test its own releases.

## Validate on every factory change

- [x] YAML syntax.
- [x] JSON schemas.
- [x] Skill metadata.
- [x] Required files.
- [x] Managed-file templates.
- [x] Sync scripts.
- [x] Install into sample fixture project.
- [x] Upgrade fixture from previous version.
- [x] Drift detection.
- [x] Removal of obsolete managed files.
- [x] Preservation of project-owned overrides.

## Fixture repositories

Create sample project fixtures:

```text
tests/fixtures/
├── godot-project/
├── dotnet-project/
└── generic-project/
```

---

# Phase 18 — Versioning and Release Process

## Version policy

Use semantic versioning:

### Patch

Examples:

- Prompt wording improvements.
- Bug fixes.
- Non-breaking validation improvements.

### Minor

Examples:

- New skill.
- New workflow.
- New optional policy.
- New automation.

### Major

Examples:

- Label lifecycle changes.
- Required config schema changes.
- Workflow semantics change.
- Removal/rename of public factory components.

## Release checklist

- [x] Update `VERSION`.
- [x] Update changelog.
- [ ] Run factory CI.
- [x] Test synchronization against fixture projects.
- [ ] Tag release.
- [ ] Publish release notes.
- [x] Document any project migration steps.

---

# Phase 19 — Factory Upgrade Flow

Normal project upgrade:

```text
Current project
factory: 0.3.1
      ↓
choose 0.4.0
      ↓
update factory.config.yaml
      ↓
run factory update
      ↓
review generated diff
      ↓
run factory verify
      ↓
project CI
      ↓
commit/PR
      ↓
merge
```

Checklist:

- [x] Never upgrade projects silently.
- [x] Never automatically follow factory `main`.
- [x] Keep old factory releases available.
- [x] Make rollback possible by restoring the previous version pin and re-running sync.
- [x] Commit synchronized generated files to each project.

---

# Phase 20 — Initial v0.1 Scope

Keep the first release intentionally small.

## Skills

- [x] `factory-plan`
- [x] `factory-implement`
- [x] `factory-review`
- [x] `factory-fix`
- [x] `factory-investigate`

## Workflows

- [x] `plan`
- [x] `implement`
- [x] `review`
- [x] `fix-review`
- [x] `investigate`

## Automations

- [x] `needs-plan`
- [x] `ready-to-implement`
- [x] `ready-to-review`
- [x] `changes-requested`

## Policies

- [x] Labels.
- [x] Definition of Ready.
- [x] Definition of Done.
- [x] Retry policy.
- [x] Escalation policy.

## Synchronization

- [x] `install.ps1`
- [x] `update.ps1`
- [x] `verify.ps1`
- [x] `diff.ps1`
- [x] Version pinning.
- [x] Managed-file markers.
- [x] Project-owned override preservation.
- [x] Dry-run support.

## Explicitly defer

- [ ] Automatic merging.
- [ ] Large custom dashboard.
- [ ] Separate orchestration database.
- [ ] Complex dependency scheduler.
- [ ] Automated factory-wide knowledge edits.
- [ ] Automated risk inference.
- [ ] Advanced cross-project scheduling.
- [ ] Complex workflow patching.
- [ ] Fully autonomous high-risk changes.

---

# Target v0.1 Lifecycle

```text
GitHub Issue
     │
     ▼
factory:needs-plan
     │
     ▼
Cezar Automation
     │
     ▼
PLAN WORKFLOW
     │
     ├── needs-help
     │
     └── ready
           │
           ▼
     Cezar Automation
           │
           ▼
   IMPLEMENT WORKFLOW
           │
           ├── retry
           │
           ├── investigate
           │
           └── PR + review
                      │
                      ▼
                REVIEW WORKFLOW
                      │
                ┌─────┴─────┐
                ▼           ▼
        changes-requested   human-review
                │           │
                ▼           ▼
          FIX WORKFLOW    HUMAN
                │           │
                └──review───┘
                            │
                            ▼
                          done
```

---

# Success Criteria for the First Production Release

The factory is ready for broader rollout when:

- [ ] A new issue can move from `needs-plan` to a reviewed PR without manual orchestration.
- [x] Agents do not implement unresolved/ambiguous issues.
- [x] Failed implementation attempts stop after a defined limit.
- [x] Repeated failures are investigated instead of endlessly retried.
- [x] Review is performed in an independent context.
- [x] Project validation produces compact LLM-friendly results.
- [x] Human intervention is clearly surfaced with actionable context.
- [x] Factory upgrades are version-pinned.
- [x] Factory upgrades produce reviewable Git diffs.
- [x] A project can reproduce its installed factory configuration from source.
- [x] A previous factory release can be restored cleanly.
- [x] Project-specific skills and overrides survive factory upgrades.
- [x] Cezar runtime state is not accidentally committed to source control.







































































