# Check-provider contract (#616)

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
