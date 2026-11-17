# Reusable Godot verification provider (#662)

`cezar/packages/cezar/src/server/verification/checks/providers/godot-provider.ts` packages the Godot capabilities as one versioned provider
for any Godot repository, behind the check-provider contract (`docs/check-provider-contract.md`). It builds on the existing adapters
(`verification/godot-adapter.ts`, `providers/godot-check-adapter.ts`, `providers/junit-adapter.ts`).

**Manifest** (`godotProviderManifestSchema`, default `godot-verification` 1.0.0): capabilities (parse, startup, gdunit, resource-references),
supported Godot range (4.2 to 4.9) and GdUnit range, the worker profile it requires (renderer and display; the default is `none` and
`headless`, so it runs anywhere) and optional named asset mounts, each required or not.

**Capability matching** (`matchWorker`): checks the engine version, GdUnit only when the project has suites, renderer and display, and
required mounts, and returns every problem with a typed reason. `environmentHash` covers provider version, engine, GdUnit, OS, renderer,
display, mounts, suites and exclusions; it is returned as the run's input digest, so it is part of provenance and the cache key.

**Project-owned configuration** (`godotProjectConfigSchema`): project directory, suites, exclusions, timeout and which mounts are present.
Suites, scenarios, assets, thresholds and licences stay in the project repository; the provider names no project, path or hardware (a
test scans its source for that). Two distinct projects use the same provider and manifest with only their own configuration.

**Normalization.** A parse error is a high-severity finding keyed by file; a warning is low severity and its fingerprint ignores line
numbers and paths, so known warning debt keeps one identity while a new error or a different warning is a new finding; GdUnit JUnit failures
become test findings; `res://` references in scenes and resources that point at nothing are reported. Messages are bounded and absolute
paths are redacted. Warning debt can be baselined and stays visible while a newly introduced error blocks (`docs/check-findings-policy.md`).

**Infrastructure is separate from code.** No engine, an incompatible engine or GdUnit, a missing display or renderer, a missing required
asset mount, a timeout, a start-up failure or a test crash with no report are errors with a typed `GodotEnvironmentError` reason, never
findings and never a pass. A missing asset mount says it is an environment problem, not a code regression.

Not done here: discovering and installing the engine and GdUnit on a worker, running the processes (`exec` is injected), selection of the
focused suites (#53) and scene or network scenario providers; Linux and Windows differences are in the worker capability and `exec` layer,
which this provider does not hardcode.
