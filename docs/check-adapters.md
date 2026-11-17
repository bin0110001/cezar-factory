# Quality check adapters: Semgrep, native lint and Godot (#646, #647, #648)

Three adapter families behind the check-provider contract (`docs/check-provider-contract.md`). Each lives in
`cezar/packages/cezar/src/server/verification/checks/providers/` and takes an injected `exec` that runs in the isolated scanner
worker (`docs/scanner-worker-profile.md`); none spawns a process itself. Tool specifics stay in the adapter: the runner,
normalizer and gates see only provider-neutral results. Whether a tool or language is present is decided by capability planning
(`docs/check-capabilities.md`), which reports NOT_APPLICABLE; no binary path is hardcoded.

## Semgrep (`semgrep-adapter.ts`, #647)

Rulesets are pinned by digest (`RulesetSource`: id, path, `sha256:` digest) and semgrep never runs with its default registry
rules. Before scanning, each ruleset's current digest is read on the worker: unavailable or different from its pin is an error,
never a pass. The combined ruleset digest is returned as `inputsDigest`, which the runner includes in the cache key and the
provenance, so changing a ruleset misses the cache. Output is SARIF, normalized to `sast` findings (CWE from the rule or message,
`error` level maps to a blocking severity). With no file in a supported language the plugin reports `unknown` with a reason (the
planner is what declares NOT_APPLICABLE). The scanner itself is trusted through the runner's `trustPolicy` (`docs/scanner-trust-policy.md`).

## Native format/lint/type (`native-lint-adapter.ts`, #646)

Each ecosystem's own tool, not one cross-language linter: ESLint and `tsc` for TypeScript, Ruff for Python, and the .NET
compiler/analyzer SARIF error log for C#. Parsers produce the generic findings document (or SARIF). An error is a blocking
severity, a warning is quality debt; a clean run passes; a crash, an unexpected exit code or unparseable output is an error.
Accepted exit codes are per tool (ESLint and Ruff exit 1 on findings, `tsc` exits 2 on type errors, `dotnet build` exits 1).

## Godot (`godot-check-adapter.ts`, #648)

Reuses the existing output classifier. A GDScript parse error is a blocking finding with its file and line, warnings are quality
debt (status `warn`, non-blocking), and editor or start-up noise, or an unexplained non-zero exit, is an error because it says
nothing about the project. A missing Godot is NOT_APPLICABLE from planning.

Runner change: a plugin may return an `inputsDigest` (or report it from `probe`); it is part of `Provenance` and the cache key.
