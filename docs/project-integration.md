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

`yaml
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

project:
  type: your-project-type   # e.g., godot, dotnet, web

validation:
  quick:
    command: "./scripts/verify-quick.ps1"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites:
      - pwsh
    timeoutSeconds: 120
    evidencePath: ".factory/artifacts/verification-quick.json"
    appliesTo:
      - "*"
  targeted:
    command: "./scripts/verify-changed.ps1"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites:
      - pwsh
    timeoutSeconds: 600
    evidencePath: ".factory/artifacts/verification-targeted.json"
    appliesTo:
      - "*"
  full:
    command: "./scripts/verify-full.ps1"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites:
      - pwsh
    timeoutSeconds: 1800
    evidencePath: ".factory/artifacts/verification-full.json"
    appliesTo:
      - "*"
  verify: "./scripts/factory/verify.ps1"
`

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
| Enabled features | `features:` in `factory.config.yaml` (project-owned; `maintenance`, `knowledge_extraction`) |
| Validation commands | `validation:` in `factory.config.yaml` |

Workflow `onFail.max` retry counts live in the workflow files; change them with a workflow override.

## Validation Interface

Projects declare project-owned quick, targeted, and full commands under
`validation:`. Each command must write exactly one JSON object to standard
output with a stable `status` and machine-readable `reason`; failure verdicts
also name a `category`. The Factory runtime executes only those commands and enforces
their working directory, prerequisites, timeout, evidence path, and project
applicability. The values above are examples; each project must point to
commands its toolchain actually supports.

### test-changed.ps1

The configured `targeted` command selects relevant tests using project-owned
rules. Factory does not discover test files or guess how to run them.
- Fast execution
- Focused on relevant tests
- Produce compact output
- Store verbose logs separately
- Return reliable exit code

### `test-full`

The configured `full` command runs the project's complete required suite:
- Comprehensive validation
- Longer execution time
- Store full artifacts separately
- Produce summarized output
- Return reliable exit code

### `verify`

Performs factory-specific validation:
- Checks factory configuration
- Validates installed components
- Ensures no runtime files are unintentionally tracked
- Validation scripts exist
- Project overrides reference valid base components
- Automation definitions are valid
- Required skills exist
- Required workflows exist
- Factory config is valid
- Pinned version exists
- Installed managed files match source version

### Output Format

The Factory wrapper writes a structured result for the configured command.
Missing configuration or prerequisites produce `unavailable`, project
non-applicability produces `skipped`, timeout or nonzero exit produces
`failed`, and only a zero exit from an applicable configured command produces
`passed`. A skipped result uses Cezar's typed `skip_step` control and is
preserved on the workflow step. Unavailable, no-matching-tests, malformed
results, and failures return mapped nonzero process exits so workflow gates
cannot mistake them for passing tests. A result resembles:

```json
{
  "status": "passed|failed|unavailable|skipped",
  "level": "targeted",
  "reason": "tests_passed",
  "category": null,
  "command": "./scripts/verify-changed.ps1",
  "durationSeconds": 12.4,
  "exitCode": 0,
  "evidence": ".factory/artifacts/verification-targeted.json",
  "log": ".factory/artifacts/verification-targeted.log"
}
```

The configured evidence file is stable per level for downstream consumers; its
paired log contains bounded, sanitized command output.

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

To update to a new factory version:

1. Update VERSION file with target version
2. Run factory update
3. Review changes with factory diff
4. Run factory verify to confirm installation
5. Run project validation scripts
6. Commit changes and create PR
7. Merge after approval

## Factory-Provided Components

The factory provides:

- Workflows: Plan, implement, review, fix-review, investigate
- Skills: Factory-plan, factory-implement, factory-review, factory-fix, factory-investigate, factory-learn
- Automations: Needs-plan, ready-to-implement, ready-to-review, changes-requested
- Policies: Labels, risk, retry, definition-of-ready, definition-of-done, escalation
- Schemas: Planning result, implementation result, review result, investigation result
- Templates: Factory configuration, agentic config, gitignore fragment
- Scripts: Install, update, verify, diff

## Project-Provided Components

Projects must provide:

- Factory Configuration: Version pinning and feature flags
- Project Skills: Domain-specific knowledge and guidelines
- Validation Scripts: Custom test and verification logic
- Secret Configuration: Securely managed secrets and credentials

## Best Practices

1. Never Edit Synchronized Files: All customizations go in project directories
2. Pin to Specific Versions: Avoid tracking factory main branch directly
3. Test Updates: Verify updates in a branch before merging to main
4. Document Overrides: Clearly document why project-specific changes are needed
5. Stay Current: Regularly update to receive bug fixes and improvements
6. Contribute Back: Share useful enhancements with the factory community

