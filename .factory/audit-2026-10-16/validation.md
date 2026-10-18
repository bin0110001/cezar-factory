<!-- factory-audit-2026-10-16:validation -->

Parent: #17. Related intake defect: #1. Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24.

## Objective and evidence

scripts/factory/test-full.ps1 and test-changed.ps1 derive artifacts from $PSScriptRoot, so all shared-mount runs write scripts/artifacts/*-results.json. test-full recursively executes source files instead of project test runners, repeats tests/Tests on case-insensitive filesystems, and reports passed/exit 0 for zero tests. Both outer catches can write status=failed without incrementing the counter controlling exit.

Source: local 767ac01, cross-checked against dev addbd38. This is a source finding, not proof of a live incident.

## Proposed implementation

Use the existing validation.changed/full/verify entries in factory.config.yaml and project-owned scripts/factory adapters, rather than introducing a second configuration schema. The workflow currently calls shared wrappers directly. Resolve configured commands from the current project/worktree, invoke child processes with bounded output, and put all results under worktree-local .factory/artifacts/<run-or-step>. Preserve an explicit no-tests/skipped outcome distinct from passed. Provide migration guidance for installed and shared projects.

## Dependencies

None; can be planned independently.

Required by: #20

## Acceptance criteria

- [ ] An isolated empty project cannot be reported as a passing full suite; unsupported projects return an actionable skipped/error policy outcome.
- [ ] Representative PowerShell, .NET, JS/TS and Godot projects invoke their configured runner once, including on Windows.
- [ ] Any runner/setup exception or nonzero exit produces a nonzero wrapper exit and matching failure artifact.
- [ ] Two concurrent worktrees never overwrite each other's artifacts or write into the shared runtime.

## Validation

Add fixture-driven subprocess tests for configured runners, empty projects, setup exceptions, nonzero exits, missing commands, spaces in paths and concurrent artifact isolation. Run the Factory suite on Windows and Linux.

## Scope and gates

Do not redesign GitHub merge routing or add automatic discovery of arbitrary project commands.

Plan before execution; independent review and validated release are required.

Required reading: AGENTS.md, policies/definition-of-ready.md, policies/risk.yaml, the files cited above, docs/shared-factory.md and the audit report. Factory-managed changes must be committed, pushed, independently reviewed through a dev PR, released to every explicitly configured target, and verified before closure.




