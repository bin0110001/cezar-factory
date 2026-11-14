# Verification CLI

`scripts/verification-cli.ps1` runs and inspects verification with stable, schema-versioned JSON (#107, parent #57).
Invoke it from a workflow `command:` step or application code, never from a skill. It adds no executor, ledger or
selection engine: it calls a **provider** and reads every result back through the
[query layer](verification-query.md) (bounded, redacted, deterministically ordered).

```text
verification-cli.ps1 run         --profile quick|standard|full [--json]
verification-cli.ps1 affected    --changed <path>[,<path>...] [--profile <p>] [--json]
verification-cli.ps1 last-failed [--json]
verification-cli.ps1 compare     --baseline <runId> [--profile <p>] [--json]      # profile defaults to standard
```

Common option: `--provider <file.ps1>` (or env `FACTORY_VERIFICATION_PROVIDER`). Without `--json` a short human summary is printed.

| Command | Selection |
| --- | --- |
| `run` | the tests of the profile |
| `affected` | catalog tests whose `paths` contain a changed path (exact file or directory prefix), optionally within a profile |
| `last-failed` | the tests that failed in the most recent failed run in the history |
| `compare` | the profile, then each failure is compared with the baseline run |

## Provider contract

A provider is a PowerShell file defining (see `tests/fixtures/verification-cli/provider.ps1`):

- `Get-VerificationCatalog` → `@{ profiles = @{ quick = ids; standard = ids; full = ids }; tests = @(@{ testId; paths }) }`
- `Get-VerificationHistory` → a query-layer snapshot (`docs/verification-query.md`) of prior runs
- `Invoke-VerificationTests -TestIds <ids>` → `@{ testId; status; message; output; fingerprint }` per test; `status` is `passed`, `failed`, `unknown`, `cancelled` or `infrastructure-error`
- `Get-VerificationChangedPaths` (optional) → changed paths used by `affected` when `--changed` is absent

Swapping in the real executor (#50) and ledger (#52) changes only the provider.

## Output (`schemaVersion` 1)

Schema: `schemas/verification-cli-output.schema.json`. Top-level keys: `schemaVersion`, `command`, `profile`, `status`
(`passed`, `failed`, `infrastructure-error`), `exitCode`, `summary` (`selected`, `passed`, `failed`, `new`, `known`, `fixed`),
`selection` (`mode`, `source`, `changedPaths`, `selected` and `deferred` with a bounded `reason` per test, `truncated`),
`failures` (query-layer failure items with `classification` `new` or `known`), `comparison` (`null`, or `baselineRunId`,
`status`, `new`, `known`, `fixed`) and `run`. Errors are `{schemaVersion, command, exitCode, error: {code, message}}`.

- **Deterministic.** Keys are sorted, tests and failures are ordered ordinally, the run id is a hash of the command and selection, and the document has no timestamps or durations: identical input gives byte-identical output.
- **New vs known.** A failure is `known` when the test failed in the baseline run (`compare`) or, without a baseline, in any prior run of the history; otherwise `new`. `fixed` (compare) lists baseline failures that now pass.
- **Bounded.** Messages, output and reasons are query-layer bounded text (inline, or head/tail excerpt with size, sha256 and reference). Lists beyond 200 items set `truncated` / `failuresTruncated`.
- With `--json`, stdout carries only the JSON document.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | all selected tests passed (an empty `last-failed` selection passes) |
| 1 | one or more tests failed |
| 2 | usage or configuration error (unknown command, option or profile; missing `--changed` / `--baseline`; unknown baseline; provider file missing) |
| 3 | internal, provider or executor error (no provider, executor crash, a test reporting `infrastructure-error` or returning no result) |
