# Deterministic Factory startup contract

The `factory-impliment` workflow must not begin implementation until its
execution context has been validated mechanically. LLM instructions are a
fallback for interpretation, not a substitute for these checks.

## Required preflight

Run `scripts/factory-preflight.ps1` from the Factory checkout before invoking
the Factory implementation skill. The preflight must pass before any issue
state transition, GitHub lookup, worktree inspection, or implementation step.

```powershell
pwsh -NoProfile -File .\scripts\factory-preflight.ps1
```

The script deliberately searches only configured and checkout-local locations.
It must not scan drives or infer a project from an arbitrary working
directory. A caller may provide `-FactoryRuntimeRoot` when the runtime is
mounted outside the checkout, but that path must exist and contain the
expected Factory script layout.

The target registry is `config/factory-projects.json`. Every target must have
an `apiUrl` and `projectId`. A `projectPath`, when present, must be an existing
absolute Windows path; remote/container paths are invalid there. An empty or
missing target registry is a hard failure, not a reason to improvise a target.

## Fail-closed behavior

- Missing `pwsh`, runtime root, route-state script, registry, or target data:
  exit nonzero and stop.
- Invalid JSON or an ambiguous target selection: exit nonzero and stop.
- Missing prerequisites in the target repository: exit nonzero and stop before
  implementation.
- A preflight failure must produce a concise machine-readable result and must
  not enter an implementation step or wait for an LLM timeout.

## Runtime and container guidance

Factory workflow commands execute inside the Cezar Linux container. The
registered `FACTORY_RUNTIME_ROOT` is consequently an in-container path,
normally `/projects/cezar-factory`; it must never be interpreted as a Windows
drive path. If PowerShell reports that
`/projects/cezar-factory/scripts/factory-startup.ps1` is not recognized, the
container bind mount or deployed Factory checkout is missing or stale. Repair
the mount/deployment on Bazzite rather than changing the workflow to a Windows
path.

Container images used for this workflow should include PowerShell (`pwsh`),
Git, and GitHub CLI at image-build time. The startup entrypoint should invoke
the preflight with `-NoProfile`, preserve its exit code, and only then launch
the Factory skill. Do not rely on shell-specific discovery such as `which`,
an unset `FACTORY_RUNTIME_ROOT`, or a guessed `/projects` mount.

If the runtime is intentionally mounted separately, set
`FACTORY_RUNTIME_ROOT` explicitly or pass `-FactoryRuntimeRoot`; otherwise the
checkout-local `.ai/factory` runtime is the only fallback. No external changes
are authorized when the registry is absent.
