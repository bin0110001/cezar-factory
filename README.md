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

## Deployment

The supported topology is declared in `config/server-topology.env`: it assigns
control-plane services and vLLM to hosts, and declares their network
relationship. Copy the example first, then copy the host-local environment
examples and run the matching deployment script:

```bash
cp config/server-topology.env.example config/server-topology.env
./scripts/deploy/deploy-control-plane.sh
./scripts/deploy/deploy-model-host.sh
```

Both scripts validate the service endpoints after startup. See
`integrations/deployment/README.md` for the network and secret boundary.

## Getting Started

Follow [docs/getting-started.md](docs/getting-started.md) for the complete,
reusable setup and deployment path, including host preparation, secret
handling, OpenHands configuration, local smoke testing, and remaining manual
gates.

Additional references:

- [Factory lifecycle and state transitions](docs/lifecycle.md)
- [Synchronization process](docs/synchronization.md)
- [Project integration model](docs/project-integration.md)

Factory issue routing: work on this Factory's workflows, skills, automations,
runtime, model serving, and documentation is tracked in
`bin0110001/cezar-factory`. A different repository used as a backlog-cleanup
example is not the issue target unless the task explicitly says it is.

## Version

Current factory version: 0.3.2 (see VERSION file)

## License

MIT
