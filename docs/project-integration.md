# Project Integration Model

This document describes how individual projects integrate with the cezar factory.

## Project Structure

Each project integrating with the cezar factory follows this structure:

project/
├── .ai/
│   ├── factory/
│   │   ├── factory.config.yaml   # Factory version and feature flags
│   │   ├── VERSION               # Pinned factory version
│   │   └── overrides/            # Project-specific overrides
│   │       ├── workflows/        # Complete workflow replacements
│   │       └── skills/           # Skill extensions
│   │
│   ├── skills/                   # Project-specific skills
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

Each project must maintain a factory configuration in .ai/factory/factory.config.yaml:

`yaml
factory:
  source: cezar-factory     # Factory repository source
  version: 0.1.0            # Pinned factory version

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
  changed: ./scripts/factory/test-changed.ps1
  full: ./scripts/factory/test-full.ps1
  verify: ./scripts/factory/verify.ps1
`

## Version Pinning

Projects pin to specific factory versions to ensure reproducible builds:

1. Initial Installation: Project selects a factory version
2. Version Factories: Each factory version is immutable
3. Explicit Updates: Version changes require explicit action
4. Rollback Capability: Projects can revert to previous versions

## Override Mechanism

Projects can customize factory behavior without modifying synchronized files:

### Skill Extensions

Rather than modifying factory skills, projects create complementary skills that extend or specialize the factory skills.

**How project skills extend generic factory behavior:**
- Project skills are discovered after factory skills in the skill resolution order (see Skill Precedence below).
- A project skill can define the same skill ID as a factory skill to override it entirely, or a different ID to extend functionality.
- When a workflow references a skill ID, the system uses the first matching skill found in the skill search path.
- Project skills can introduce new skill IDs that are not present in the factory, providing new capabilities.

**Skill Precedence:**
The skill discovery precedence is (from highest to lowest priority):
1. `.ai/cezar/skills/` - workflow-specific local skills (in the Cezar runtime)
2. `.ai/skills/` - project-level skills (in the project)
3. `.ai/factory/overrides/skills/` - project-specific skill overrides (in the factory override directory)
4. `skills/` directory in the factory repository (synchronized factory skills)
5. Global skills (built-in or system-wide)
6. Team repository skills (background cached)

**Ensuring factory upgrades do not overwrite project skills:**
- Project skills stored in `.ai/skills/` and `.ai/factory/overrides/skills/` are not synchronized by the factory.
- The factory synchronization process only updates files in the synchronized directories (skills/, workflows/, automations/, policies/, schemas/, templates/).
- Project-specific skills in `.ai/skills/` are untouched by factory updates.
- Skill overrides in `.ai/factory/overrides/skills/` are also preserved because they are outside the synchronized skill directory.

### Workflow Overrides

Workflow overrides are supported when composition (via skill extensions) is insufficient to achieve the desired customization.

**Potential approach for workflow overrides:**
- Complete workflow replacements are placed in `.ai/factory/overrides/workflows/`.
- The factory synchronization process will not overwrite files in this override directory.

**Deciding on the override type:**
Projects should choose one of the following strategies for workflow overrides:
- **Full replacement:** The entire workflow YAML file is replaced with a project-specific version. This is the simplest and most explicit approach.
- **Patch/merge:** Only specific sections of the workflow are modified, aiming to preserve the base structure. This approach is more complex and error-prone.
- **Project-specific workflow selected instead:** The project defines a completely new workflow with a different ID, and the factory configuration is updated to reference this new workflow ID instead of the factory one.

**Recommendation for v1:**
For the initial version (v1) of the factory, we recommend using **full replacement** for workflow overrides. This avoids the complications of YAML patching and merge conflicts during factory upgrades. Projects should:
1. Copy the base workflow from the factory (e.g., `workflows/plan.yaml`) to `.ai/factory/overrides/workflows/plan.yaml`.
2. Modify the copied file as needed.
3. Ensure the workflow ID (the `name` field) remains the same so that automations and other references continue to work.

### Policy Overrides

Projects can adjust certain policies through configuration in their factory configuration file (`.ai/factory/factory.config.yaml`).

**Allowable policy overrides:**
Projects can change the following aspects of factory policies:

- **Risk classification:** Define custom risk levels or modify the existing ones (low, medium, high) and their associated requirements.
- **Validation requirements:** Specify which validation scripts to run and under what conditions.
- **Retry limits:** Adjust the maximum number of implementation retries, review/fix rounds, etc.
- **Required human gates:** Determine which stages require human intervention (e.g., human plan approval, human merge).
- **Enabled factory features:** Toggle optional factory features such as knowledge extraction and maintenance automation.

**Example policy override in `.ai/factory/factory.config.yaml`:**
```yaml
factory:
  source: cezar-factory
  version: 0.1.0

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
  knowledge_extraction: true   # Enable knowledge extraction
  maintenance: true            # Enable maintenance automation

project:
  type: godot

validation:
  changed: ./scripts/factory/test-changed.ps1
  full: ./scripts/factory/test-full.ps1
  verify: ./scripts/factory/verify.ps1

# Policy overrides
risk:
  levels:
    risk:high:
      requires-human-plan-approval: true
      requires-human-merge: true
      required-factory-version: "0.2.0"   # Example: require higher factory version for high risk
  # Custom risk levels can be added
  # risk:custom: ...
retry:
  max-implementation-attempts: 3
  max-review-fix-rounds: 2
validation:
  # Override validation script paths or add conditions
  changed: ./scripts/factory/test-changed.ps1
  full: ./scripts/factory/test-full.ps1
  verify: ./scripts/factory/verify.ps1
```

## Validation Interface

Projects provide three standard validation scripts:

### test-changed.ps1

Tests only files changed in the current workitem:
- Fast execution
- Focused on relevant tests
- Produce compact output
- Store verbose logs separately
- Return reliable exit code

### `test-full`

Runs the complete test suite:
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

All validation scripts produce structured JSON output for LLM-friendly consumption:

```json
{
  "status": "passed|failed|warning",
  "stage": "test|verify",
  "passed": 42,
  "failed": 0,
  "warnings": 1,
  "total": 43,
  "errors": [...],
  "failures": [...],
  "checks": [...],
  "artifact": "artifacts/verify-results.json"
}
```

Results are also written to `artifacts/` subdirectory as timestamped JSON files, with verbose logs stored separately.

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
# factory-version: 0.1.0
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

