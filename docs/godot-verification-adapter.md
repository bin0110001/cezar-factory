# Godot verification adapter (TableFlux pilot)

`cezar/packages/cezar/src/verification/godot-adapter.ts` layers over the generic verification
executor (#50). It wraps the project's existing scripts; it never rewrites them.

| Check id contains | Kind | Behaviour |
|---|---|---|
| `parse`, `resource`, `import`, `lint` | parse | `SCRIPT ERROR: Parse Error` output fails the check even on exit 0 (`godot.parse-error`, file/line from `res://` locations). Editor/startup errors are classified separately (`godot.editor-error`) and yield `infrastructure-error`, never a pass or a script defect. |
| `startup`, `launch`, `boot` | startup | Runs the existing startup check unchanged; parse errors are tagged `godot.startup-error`. |
| `gdunit`, `unit` | gdunit | Ingests JUnit XML from `reports/` (configurable). Raw XML is left in place and referenced as an artifact (path, size, sha256). Exit 100 or any failure/error fails; exit 101 passes with a `gdunit.warnings` diagnostic; no XML, malformed XML → `unknown`; zero tests → `no-tests`; all skipped → `skipped`. |

## Worktree-local suites

Defined in the target's `.ai/factory/factory.config.yaml` (delivered as an approved TableFlux
project PR; no remote service is needed). Use `resources:` to serialize checks sharing a Godot
user dir:

```yaml
verification:
  version: 1
  checks:
    godot-parse:   {runner: command, executable: ./scripts/verify-parse.sh,   args: [], cwd: ., timeoutSeconds: 300}
    tableflux-startup: {runner: command, executable: ./scripts/startup-check.sh, args: [], cwd: ., timeoutSeconds: 300, resources: [godot-user-dir]}
    gdunit:        {runner: command, executable: ./scripts/run-gdunit.sh,     args: [], cwd: ., timeoutSeconds: 900, resources: [godot-user-dir]}
  suites:
    quick: [godot-parse]
    standard: [godot-parse, tableflux-startup]
    full: [godot-parse, tableflux-startup, gdunit]
```

Each check appears once per suite run; per-worktree artifacts never collide. Old-vs-new
comparison cases (empty, failed, skipped, malformed, concurrent) are covered by
`godot-adapter.test.ts`. Not done here: the TableFlux repo change itself.
