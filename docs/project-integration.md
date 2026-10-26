# Project Integration Model

This document describes the optional local project integration layer. Cezar
uses the shared, version-pinned Factory runtime mount for workflow scripts;
configured automation definitions are synchronized through the Cezar API.
This checkout layout is needed only when a project requires a full local
`.ai/factory` installation.

## Project Structure

Projects that need Factory workflows, skills, policies, scripts, or pinned
local files follow this structure:

project/
├── .ai/
│   ├── factory/
│   │   ├── factory.config.yaml   # Factory version and feature flags
│   │   ├── VERSION               # Installed factory version (managed)
│   │   ├── manifest.json         # Managed-file ownership + hashes (managed)
│   │   ├── policies/ schemas/ scripts/ automations/   # Managed
│   │   └── overrides/            # Project-specific overrides
│   │       ├── workflows/        # Complete workflow replacements
│   │       └── skills/           # Skill extensions
│   │
│   ├── skills/                   # factory-* (managed) + project-specific skills
│   ├── cezar/workflows/          # factory-*.yaml (managed) + project workflows
│   │   ├── project-architecture/ # Architecture guidance
│   │   └── project-testing/      # Testing guidelines
│   │
│   └── ...                       # Other cezar configuration
│
├── scripts/
│   └── factory/                  # Factory-related scripts
│       ├── test-changed.ps1      # Test changed files
│       ├── test-full.ps1         # Full test suite
│       └── verify.ps1            # Validation script
│
└── ...                           # Project source code

## Factory Configuration

Projects using the local fallback must maintain a factory configuration in
`.ai/factory/factory.config.yaml`:

```yaml
factory:
  source: cezar-factory     # Factory repository source
  version: 0.2.0            # Pinned factory version

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
  backlog_reconciliation: false

project:
  type: your-project-type   # e.g., godot, dotnet, web

validation:
  targeted:
    command: "pwsh ./scripts/verify-changed.ps1"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites: ["pwsh"]
    timeoutSeconds: 600
    evidencePath: ".factory/artifacts/verification/targeted.json"
    appliesTo: ["src/**", "test/**"]
  full:
    command: "pwsh ./scripts/verify-full.ps1"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites: ["pwsh"]
    timeoutSeconds: 1800
    evidencePath: ".factory/artifacts/verification/full.json"
    appliesTo: ["*"]
  verify: "pwsh ./scripts/verify-project.ps1"
```

The current workflow invokes the project-owned `targeted`, `full`, and `verify`
commands from the project's Git worktree. A .NET project can use
`dotnet test MySolution.sln`, a JS project can use `npm test`, and a Godot
project can call its own parser/GdUnit test script. JSON-mode commands return
the structured result contract; exit-code mode remains available for legacy
commands. The Factory wrapper does not discover source files or guess a package
runner. Quote paths with spaces in command values. Targeted validation is
bounded to 20 minutes; full and verify are bounded to two hours. An overlong
command fails with an infrastructure receipt. The template's `quick` entry is
not currently invoked by the workflow, so do not treat it as a verified gate.

Before moving an installed or shared-mount project to this Factory version,
check that its `.ai/factory/factory.config.yaml` points to real project-owned
targeted, full, and verify commands. A missing config or command returns an
unavailable receipt and fails closed. Targeted validation may explicitly use
`skip` only when the project cannot support focused checks; `full` and
`verify` are required and cannot be skipped. A command that points back at a
Factory validation wrapper is rejected.

Each attempt stores bounded stdout, stderr, and a versioned receipt beneath
the worktree's `.factory/artifacts/validation/<stage>/<attempt>/`. The receipt
records the repository, issue, PR, head commit, command, timeout, exit code, outcome,
and whether the worktree was clean. Workflow review requires both full and
verify stages. The current-head merge gate is tracked in #27; an agent result
or an old receipt does not by itself authorize merging.

## Issue repository routing

Factory-owned work belongs to the Factory repository, `bin0110001/cezar-factory`.
That includes changes to Factory workflows, skills, automation definitions,
runtime deployment, model configuration, watchdogs, and Factory documentation.

Other repositories may be named as backlog-cleanup pilots, but their issues are
project work, not Factory work. Before creating or editing an issue, verify the
repository from the task context. If the task concerns Factory infrastructure,
use `bin0110001/cezar-factory`; do not infer the target from the example backlog
being audited. If a source repository is private and the Factory repository is
public, do not copy issue bodies, links, or private operational details without
explicit approval; ask whether a sanitized public issue is acceptable.

## Version Pinning

Projects pin to specific factory versions to ensure reproducible builds:

1. Initial Installation: Project selects a factory version
2. Version Factories: Each factory version is immutable
3. Explicit Updates: Version changes require explicit action
4. Rollback Capability: Projects can revert to previous versions

## Override Mechanism

Projects can customize factory behavior without modifying synchronized files:

### Skill Extensions

Compose rather than modify: add project skills next to the factory ones and let the workflow prompts or your own skills pull them in.

- Factory skills install as `.ai/skills/factory-*/` and are managed. Project skills (for example `.ai/skills/project-testing/`, `.ai/skills/tableflux-review/`) use any other name and are never touched by install/update/diff.
- Cezar resolves skills local-first: `.ai/cezar/skills` -> `.ai/skills` -> `.agents/skills` -> global -> team repo. A same-named skill in `.ai/cezar/skills/` therefore shadows the factory one for Cezar, but prefer a different name: `factory-implement` already tells the agent to discover and apply project skills, and `factory-review` checks project conventions.
- To replace a factory skill outright, use an override (below), which keeps it reproducible and drift-checked.

### Workflow and File Overrides (full replacement)

Any factory file can be fully replaced by placing a project copy at `.ai/factory/overrides/<factory source path>`:

```text
.ai/factory/overrides/workflows/implement.yaml    -> installed as .ai/cezar/workflows/factory-implement.yaml
.ai/factory/overrides/skills/factory-review/SKILL.md
.ai/factory/overrides/policies/retry.yaml
```

Copy the factory file, edit it, and keep the `name:` (for workflows, `factory-<name>`) so automations still resolve it. v0.1 deliberately has no patch/merge mode. `update.ps1` re-renders overrides on every upgrade (header `source: overrides/...`), so after a factory upgrade review whether your replacement should pick up upstream changes. `verify.ps1` fails if an override points at a path that does not exist in the factory.

### Policy Overrides

Policies are plain factory files, so a policy override is a file override:

| To change | Override file |
| --- | --- |
| Retry limits (implementation retries, review/fix rounds) | `overrides/policies/retry.yaml` (`max_review_fix_rounds` is read by `route-state.ps1`) |
| Risk classification and human gates | `overrides/policies/risk.yaml` |
| Definition of Ready / Done, escalation format | `overrides/policies/*.md` |
| Label set | `overrides/policies/labels.yaml` (`route-state.ps1` reads the factory-state list) |
| Enabled features | `features:` in `factory.config.yaml` (project-owned; `maintenance`, `knowledge_extraction`, `backlog_reconciliation`) |
| Validation commands | `validation:` in `factory.config.yaml` |

Workflow `onFail.max` retry counts live in the workflow files; change them with a workflow override.

## Validation Interface

The Factory workflow invokes the project-owned `targeted`, `full`, and
`verify` commands declared in `validation:`. Each command may return a
structured JSON result or use the legacy exit-code contract. The workflow
records a versioned receipt with stage, status, reason code, command metadata,
project head, bounded output, and evidence references under
`.factory/artifacts/validation/<stage>/<attempt>/`.

`targeted` is for applicable focused checks; its `appliesTo` patterns decide
whether it runs for a change. `full` and `verify` are required gates and cannot
be skipped. A project may mark `targeted` as `skip` only when focused checks
are unsupported. Missing configuration, commands, or prerequisites produce an
unavailable receipt and fail closed. Zero matching tests are reported as
`no_matching_tests`, never as a pass. The workflow bounds targeted execution
to 20 minutes and full/verify execution to two hours; the configured
`timeoutSeconds` may impose a shorter project-specific limit. The template's
`quick` entry is not currently invoked and is not a release gate.

The receipt distinguishes command failure from infrastructure failure and
records diagnostic comparison against the pinned baseline when one is
configured. A known baseline diagnostic remains visible and does not turn a
failed full or verify receipt into a pass. See
[`validation-baseline-policy.md`](validation-baseline-policy.md) for merge-gate
behavior and baseline provenance requirements.

Factory wrappers normalize the structured verdict into an exit code for Cezar:

| Exit code | Meaning | Agent retry |
| --- | --- | --- |
| `0` | Passed, or targeted validation explicitly skipped/not applicable | No |
| `1` | Structured `failed` result with `test_regression`, `test_failure`, or `work_verdict` reason | Yes, bounded |
| `10` | Invalid or missing validation configuration/baseline | No |
| `11` | Missing command, working directory, or prerequisite | No |
| `12`–`15` | Authentication, provider unavailable/quota, or transient transport | No |
| `16` | Validation timeout | No |
| `17` | Malformed result or result/exit-code contradiction | No |
| `18` | Unknown failure, no matching tests, or legacy exit-code-only failure without a typed verdict | No |

The implementation and fix-review verification steps retry only code `1`.
Fix-review retries result validation only for the explicit work-verdict code.
Project commands should use the structured JSON result contract when the failure
can be classified; a legacy exit code does not prove the failure is repairable
by a coding agent.

## Runtime Content

The following Cezar runtime and generated artifacts should **not** be version
controlled by default. Projects should add the factory-provided gitignore
fragment to their `.gitignore` to exclude these paths automatically.

### What is not version-controlled

- **Execution logs** — per-run logs and trace output.
- **Temporary worktrees** — ephemeral agent working directories.
- **Agent session state** — conversation context, session checkpoints.
- **Runtime task caches** — downloaded dependencies, compiled models.
- **Other Cezar operational data** — tracker state, automation receipts,
  dispatch buffers, and lock files generated at runtime.

### Using the gitignore fragment

The factory ships `templates/gitignore.fragment` containing all paths that
Cezar uses for runtime state. Projects can include it from their root
`.gitignore`:

```gitignore
# Exclude Cezar runtime artifacts
# managed-by: cezar-factory
# factory-version: 0.3.2
# source: templates/gitignore.fragment
# DO NOT EDIT DIRECTLY
/.ai/factory/.gitignore-fragment
```

Then copy the fragment into `.ai/factory/.gitignore-fragment` during
synchronization. Alternatively, reference it via the `core.excludesFile` Git
setting or append its rules manually.

---

## Update Process

Factory changes are reviewed through a PR targeting `dev`; request auto-merge
only after validation and independent review pass. After the change is merged,
run `scripts/release/promote-stable.ps1`, which runs the full Factory suite
before fast-forwarding `origin/stable`. The Bazzite auto-deploy timer updates
the shared mount and synchronizes automations. Use the configured-target
release flow for remote-only automation sync. Do not update an installed
project's managed `.ai/factory` layer unless its registry entry has a verified
local `projectPath` and the release dry run succeeds.

## Factory-Provided Components

The shared Factory checkout provides:

- Workflows: Plan, implement, review, fix-review, investigate
- Skills: Factory-plan, factory-implement, factory-review, factory-fix, factory-investigate, factory-learn
- Automations: Needs-plan, ready-to-implement, ready-to-review, changes-requested
- Policies: Labels, risk, retry, definition-of-ready, definition-of-done, escalation
- Schemas: Planning result, implementation result, review result, investigation result
- Templates: Factory configuration, agentic config, gitignore fragment
- Scripts: workflow-owned validation, routing, release, and runtime operations

## Project-Provided Components

Projects must provide:

- Factory Configuration: Version pinning and feature flags
- Project Skills: Domain-specific knowledge and guidelines
- Validation Scripts: Custom test and verification logic
- Secret Configuration: Securely managed secrets and credentials

## Best Practices

1. Keep project-owned validation commands and domain guidance in the project.
2. Put shared Factory behavior in the Factory checkout; use a project override
   only when a documented project-specific difference is required.
3. Validate Factory changes and review them through a PR targeting `dev`.
4. Promote only the tested merged commit to `stable`; let the supported
   shared-mount deployment flow reconcile configured automations.
5. Use a full local `.ai/factory` installation only for a configured target
   with a verified local `projectPath` and a successful release dry run.

