# Cezar Factory

A reusable, version-controlled development factory for Cezar that enables standardized, automated software development workflows.

## Active execution model

Production Factory automations run directly through the Cezar service. Their
`runner` and `model` fields select Codex, Claude, or the Factory gateway; they
do not submit work to OpenHands. The OpenHands integration and deployment
files remain only as legacy/reference material and are not required for the
active automation path.

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
# 1. Configure remote Cezar targets in config/factory-projects.json
# 2. Validate and synchronize Factory automations without a project checkout
./scripts/push-factory-updates.ps1 -SyncAutomations
```

For a first-time project integration, or when Cezar needs project-local
workflows, skills, policies, or scripts, use the local fallback:

```powershell
./scripts/install.ps1 -ProjectPath ../my-project -ProjectType godot
./scripts/verify.ps1 -ProjectPath ../my-project
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
handling, Cezar runtime configuration, local smoke testing, and remaining
manual gates. Its OpenHands sections are retained as legacy migration notes
and are not part of the active deployment.

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
For transient PowerShell child-process startup failures, run the bounded test
wrapper instead of retrying the full command manually:

```powershell
pwsh -NoProfile -File .\tests\run-tests-retry.ps1
```

The wrapper retries launch exceptions only; deterministic test failures return
immediately with their original exit code.
