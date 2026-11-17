# Check-provider contract (#616)

See `docs/quality-check-catalog.md` for the family-to-provider catalog.

A provider-neutral contract for quality, security and supply-chain checks, in
`cezar/packages/cezar/src/server/verification/checks/check-provider.ts`. The JSON schema
`schemas/check-provider.schema.json` is generated from it (a test fails if they drift). Scanner brands
never appear in core release logic: a provider is only data (`name`, `version`, `digest`).

- **Categories**: format, lint, type, test, sast, sca, secrets, iac, container, license, sbom, complexity, custom, ai-audit.
- **Scope**: changed-files, full-repo, baseline-diff, binary-image, git-history.
- **Trigger**: pr-dev, release-candidate, periodic-independent, manual, risk-event. A periodic-independent check
  needs a `schedule` (cron + timezone) and runs independently of any release candidate.
- **Policy**: `mandatory`, `timeoutMs`, `maxAgeHours`, caching, and what a failure or unavailable feed yields.
- **Statuses**: `pass | fail | warn | unknown | error`.

## Fail-closed rules

`pass` is not expressible as a failure or feed-unavailable outcome (`onFailure`, `onFeedUnavailable` accept
only fail/unknown/error). `checkResultSchema` rejects `pass` for a non-completed execution, a stale or
unavailable feed, or any blocking finding, so an unavailable feed is never "zero findings".
`deriveCheckStatus` computes the permitted status from the policy.

Related: `docs/scanner-trust-policy.md` (which scanners are trusted), `docs/scanner-worker-profile.md`
(isolated execution). Normalized findings are #617; runner, provenance and cache are #618; gates and
schedule are #619.

## Normalized findings (#617)

`checks/normalized-findings.ts` maps SARIF 2.1.0 (`normalizeSarif`) and a generic JSON list
(`normalizeGenericJson`) into one shape. The `fingerprint` is provider-independent: the shared advisory id
(CVE, else GHSA, else OSV) plus ecosystem and dependency name for supply-chain findings, otherwise
category, CWE (or rule id) and path. Provider-specific fingerprints are kept in `sourceFingerprints`, and
`mergeByFingerprint` carries them forward so a provider swap keeps history. Findings carry severity,
confidence, dependency/version, source path and SHA, fix availability, references, waiver status and
provenance. Messages, rule ids and fingerprints are redacted with `core/secret-redaction` plus caller-supplied
secrets before anything is stored. A malformed document throws; it never normalizes to zero findings.

Assumption: the #52 ledger's finding kinds are a closed contract enum, so persisting these findings through
`finding-ingest` (a new kind) is done with the gate integration in #619 rather than by widening the contract here.

## Check runner (#618)

`checks/check-runner.ts` runs a `CheckProviderPlugin` (CLI/container invocation in the #605 isolated worker is
the plugin's job; tests use fake Trivy/Semgrep/custom doubles). `runCheck` applies the optional #604 trust
policy, a timeout, advisory-DB freshness against `maxAgeHours`, normalization, and `deriveCheckStatus`, so a
crash, timeout, unparseable output, missing or stale feed, or untrusted scanner is never `pass`. Provenance pins
source SHA, provider name/version/digest, config digest, DB timestamp, artifact digest, worker profile and scope.
The cache key covers all of those, so any change misses; a different scope never reuses a result (#593).
Failures and stale feeds are not cached. `aggregateCategory` combines several providers in one category: worst
status wins and findings merge by common fingerprint.

## Gates and independent schedule (#619)

`checks/check-gates.ts` evaluates release gates from normalized records keyed only on category, mandatory/optional
and max age (plus the source SHA under test). A missing, stale, other-SHA or non-passing (`fail`/`error`/`unknown`)
mandatory result blocks; verdicts carry no provider names, so swapping a provider changes nothing in the
evaluation. `queryRecordFindings` is the single findings query across providers.

`planDueChecks` lists the checks due for a `periodic-independent`, `manual` or `risk-event` trigger (periodic is due
when never run or older than `maxAgeHours`). It returns check ids only, so a scheduled run cannot create a regression
candidate. Cron/timezone evaluation is left to the automation scheduler that calls it.

## Trivy adapter (#606)

`checks/providers/trivy-adapter.ts` is the only place Trivy is named. `buildTrivyArgv` enables the repository,
filesystem, image, misconfiguration, secret and license domains independently (each maps to a contract category) and
can request a CycloneDX SBOM. `trivyPlugin` runs the argv through an injected `exec` (the #605 isolated worker supplies
the scrubbed environment), parses the JSON report and hands generic findings to the shared normalizer. Secret `Match`
text is never copied. A report with no lockfile/package result is `unknown` (`not-run`, reason recorded), a non-zero exit,
non-JSON or malformed report is `error`, and `Status: not_affected` is a waived false positive. Redundant scans are avoided
with the runner cache (enable `policy.cache`). `reconcile.ts` compares consecutive runs by common fingerprint into
opened/still-open/fixed; a run that did not complete fixes nothing.

Assumption: persisting reconciled findings through the #52 ledger needs a new finding kind in the contract enum and is
not done here (see the normalized findings note).
