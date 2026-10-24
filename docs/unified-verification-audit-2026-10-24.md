# Unified verification integration audit — 2026-10-24

## Scope

This audit maps the local Factory/Cezar source relevant to the verification backlog. The remote pilot was inspected only at metadata level. No remote project source, configuration contents, paths, or runtime state were transferred into this document.

## Existing interfaces

- `cezar/packages/contract/src/verification.ts` defines v1 manifest and result schemas, status semantics, normalized relative paths, and bounded limits (256 checks, 20,000 output characters per check, 100 artifact references, and 1 MiB serialized results). A `passed` run requires conclusive required-check coverage.
- `cezar/packages/cezar/src/verification/executor.ts` validates check working directories under the project root, launches commands without a shell, filters inherited environment variables, redacts common secrets, bounds output, supports timeout/cancellation, and serializes checks that share named resources. `executeSuite` currently uses an in-memory resource lock map scoped to one suite invocation.
- `cezar/packages/cezar/src/workflows/types.ts` and `workflows/run.ts` define the existing generic workflow check step. It replaces `{{task}}` with `CEZAR_TASK`, launches `bash -lc` from the task worktree, and caps captured output. This path is not the richer manifest executor.
- `cezar/packages/cezar/src/server/project-context.ts` resolves registered projects into per-project run stores/managers and shares a workspace semaphore across managers. It is a plausible integration point for project-scoped scheduling, but it does not currently connect the verification executor to workflow runs.
- `docs/project-integration.md` and `scripts/lib.ps1` define the Factory project-owned changed/full/verify adapters. These are legacy command adapters, separate from the Cezar verification manifest.
- `workflows/failure-audit.yaml`, `skills/factory-failure-audit/SKILL.md`, and `scripts/audit-factory-failures.ps1` implement a distinct bounded runtime-failure audit and optional intake recovery/issue creation. They are not verification scheduling or result-ledger components.

## Suggested vertical slice

1. Resolve the registered project and task worktree through Cezar's existing project/run context; never accept an arbitrary root from an agent prompt.
2. Load and validate the project's manifest, pin its digest and commit SHA, and select a named suite.
3. Invoke `executeSuite` with the resolved worktree and cancellation signal. Establish whether resource locks must be shared across concurrent runs; the current map only coordinates checks within one suite.
4. Persist one bounded, schema-validated result and artifact references under a Cezar-owned result location. Keep raw logs out of the issue/agent prompt path; surface a bounded redacted preview and finding references.
5. Add workflow/API scheduling and lifecycle coverage, then connect the result to the finding ledger and Hindsight only after the contract/executor path is stable.

The current code supplies manifest validation and command execution, but does not establish scheduler wiring, cross-run resource locking, result persistence, artifact collection, or a registered-project pilot.

## Backlog relationship

The planned dependency order remains contract (#49) → executor (#50) → pilot (#51) and ledger (#52) → remediation/Hindsight integration (#53–#59), subject to each issue's explicit dependencies. Failure audit work associated with #22/#30/#31 remains an adjacent diagnostic path, not a substitute for verification execution or its finding ledger.

## Metadata-only pilot observation

The host registry contains an explicitly registered pilot entry, currently marked `unclassified`. Its project-owned configuration file exists, but the three configured changed/full/verify adapter paths were reported missing-or-outside by a metadata-only existence check in the Cezar container. The project is Godot-based and has a GdUnit addon. These observations do not verify its test commands, artifact layout, or concurrency behavior.

Automatic review rejected a requested transfer of remote private project paths and selected source/config/workflow contents, stating that it could expose private data and that a metadata-only audit should be used. This audit respects that boundary. Exact target identifiers, roots, configuration contents, and private repository details are intentionally omitted.

## Local evidence inspected

- `cezar/packages/contract/src/verification.ts`
- `cezar/packages/cezar/src/verification/executor.ts`
- `cezar/packages/cezar/src/workflows/types.ts`
- `cezar/packages/cezar/src/workflows/run.ts`
- `cezar/packages/cezar/src/server/project-context.ts`
- `docs/project-integration.md`
- `scripts/lib.ps1`
- `workflows/failure-audit.yaml`
- `skills/factory-failure-audit/SKILL.md`
- `scripts/audit-factory-failures.ps1`
