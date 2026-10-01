# Cezar Factory

A reusable, version-controlled development factory for Cezar that enables standardized, automated software development workflows.

## Overview

This factory provides:
- Standardized workflows (plan, implement, review, fix-review, investigate)
- Reusable skills for each stage of development
- Automation definitions for triggering workflows based on GitHub events
- Policies for defining ready/done criteria, retry behavior, and escalation
- Synchronization tools for keeping projects up-to-date with factory improvements
- Validation interfaces for consistent quality checks

## Quick start

```powershell
# 1. Install into a project (creates .ai/factory/factory.config.yaml on first run)
./scripts/install.ps1 -ProjectPath ../my-project -ProjectType godot
# 2. Provide scripts/factory/{test-changed,test-full,verify}.ps1 in the project, add .factory/ to its .gitignore
# 3. Check it
./scripts/verify.ps1 -ProjectPath ../my-project
# 4. Create the GitHub labels
pwsh ../my-project/.ai/factory/scripts/create-labels.ps1
# 5. With Cezar running (CEZ_AUTOMATIONS=1, CEZ_API_URL/CEZ_PROJECT_ID set), create the automations (paused)
pwsh ../my-project/.ai/factory/scripts/sync-automations.ps1
```

Run the factory's own tests with `pwsh tests/run-tests.ps1`.

## Getting Started

See the documentation in the docs/ directory for detailed information on:
- Factory lifecycle and state transitions
- Synchronization process
- Project integration model

## Version

Current factory version: 0.2.1 (see VERSION file)

## License

MIT
