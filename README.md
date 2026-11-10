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

The shared Factory checkout mounted into Cezar is the default. Configure
explicit targets from [`config/factory-projects.json.example`](config/factory-projects.json.example)
and use the owning Cezar workflow for Factory operations. A local project
installation is a fallback for projects that need the complete `.ai/factory`
layer; see [project integration](docs/project-integration.md).

Repository changes are validated locally with `tests/run-tests.ps1` and the
pre-commit hook. Operational Factory scripts are invoked by workflow command
steps, not by agent prompts.

## Deployment

The supported topology is declared in `config/server-topology.env`: it assigns
control-plane services and vLLM to hosts and declares their network
relationship. Host-local deployment is separate from remote-only Cezar
automation synchronization. See `integrations/deployment/README.md` for the
deployment and secret boundary.

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

Current factory version: 0.3.70 (see VERSION file)

## License

MIT
For transient PowerShell child-process startup failures, run the bounded test
wrapper instead of retrying the full command manually:

```powershell
pwsh -NoProfile -File .\tests\run-tests-retry.ps1
```

The wrapper retries launch exceptions only; deterministic test failures return
immediately with their original exit code.
