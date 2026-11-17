# Check capability detection and profiles (#645)

`cezar/packages/cezar/src/server/verification/checks/capabilities.ts` decides what can run for a project from its own
contents and the tools a worker reports. Nothing is hardcoded to a path or to host hardware.

- **Detection.** `detectEcosystems(paths)` maps repository-relative paths to ecosystems: `dotnet`, `typescript`, `python`,
  `godot`, `container`, `iac` and `lockfile`. Vendored directories (`node_modules`, `.git`, `bin`, `obj`, virtualenvs) and `.d.ts`
  files are ignored; Windows separators are normalized. The caller supplies the file list.
- **Profiles.** A profile lists checks, each needing an ecosystem and a tool **name** (never a path; a path fails
  validation). Built in: `factory-dotnet-ts-python` (native format, lint and type checks plus dependency and SAST scanning)
  and `godot-gdscript` (parser and warning checks plus dependency scanning). Select one by id or `auto`
  (`selectProfile`; no match is an error, not a guess). The selection shape is `profileSelectionSchema`.
- **Planning.** `planChecks(profile, ecosystems, hasTool)` marks each check `run` or `not-applicable`, with reason
  `ecosystem-absent` or `tool-missing` and a detail, so no scanner is required for something the project cannot support.
- **NOT_APPLICABLE.** A new contract status, `not-applicable`, produced only by planning through `notApplicableResult`: never
  run, no findings, a required reason (the result schema rejects any other combination, so it cannot be forged from a run).
  Gates treat it as satisfied and non-blocking and report it as `not-applicable`, distinct from `unknown` and `error`, which
  still block a required check. The quality policy (`is_blocking`) agrees. A scanner that merely found nothing to scan is still
  `unknown` (see the Trivy and OSV adapters); only capability planning can declare a check not applicable.

The adapters that use this are #646 (native lint), #647 (Semgrep), #648 (Godot) and #649 (maintainability).
