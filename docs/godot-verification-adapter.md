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

## Reusable provider (#662)

The adapter is project-agnostic: any Godot repository declares the single versioned provider
(`schemas/godot-provider-manifest.schema.json`, `godot-provider.ts`) and keeps its own suites,
assets, thresholds, license manifests and debt baselines. Nothing gameplay- or TableFlux-specific
lives in Cezarium. Pass `createGodotVerificationAdapter({ provider: { manifest, environment, knownWarningFingerprints, knownErrorFingerprints } })`.

The manifest declares provider version, capabilities (`parse`, `startup`, `gdunit`, `scene-resource-refs`;
`render`, `network-scenario`, `gua` are reserved for future providers using the same contract),
engine and GdUnit version ranges, discovery order, tool provenance, worker profile
(renderer/display/os/capabilities), optional asset mounts and an environment hash.
`godotWorkerMatches` is the predicate for #213 capability matching; it does not schedule anything.

| Situation | Outcome |
|---|---|
| Missing required asset mount, engine/GdUnit out of range, OS/renderer/display mismatch | `infrastructure-error` with `godot.asset-mount-missing`, `godot.engine-mismatch`, ...; the check is not run, so it is never a code regression |
| Engine crash (signature, 134/139/0xC0000005) | `infrastructure-error`, `godot.crash` |
| Timeout, spawn failure, truncated output | `godot.runner-failure` / `godot.output-truncated` (executor status kept) |
| Warning in the project's known-debt baseline | `godot.warning.known` (info); new warning stays `godot.warning` and does not fail |
| Runtime `SCRIPT ERROR:`/`ERROR:` not in the known-error baseline | `godot.error.new`, check fails; baselined errors are `godot.error.known` |

Fingerprints (`godotDiagnosticFingerprint`) hash the kind plus a message with paths, numbers and
locations removed, so debt survives line moves and differs by OS paths not at all. Diagnostics carry a
redacted, bounded excerpt; the raw log/JUnit remain on disk and are referenced as artifacts. Diagnostics
flow to the unified finding ledger through the existing ingest, and selection stays with #53.
