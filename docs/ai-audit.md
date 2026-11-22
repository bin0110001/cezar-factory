# Opt-in AI code and architecture audit controls (#602)

`scripts/release/ai_audit_policy.py` (library only) decides whether an AI audit may run, builds its context safely and
normalizes what comes back. It never calls a model itself: the adopting workflow does, only when `decide` says `run`.

## Defaults

Disabled. A project must opt in (`enabled: true`); a disabled or invalid configuration yields zero model calls
(`llmCalls: 0`). Default scopes are `pr-diff` and `candidate-delta`; the architecture-wide scope runs only for a
`periodic` or `manual` trigger and must be listed in `scopes`, so a full-repo audit is never the default on every candidate.

## Deciding

`decide(config, request, state, now)` is pure and returns `run`, `skip` or `fail` with a reason and the selectors that matched.
Selectors: manual, periodic (weekly or monthly), changed sensitive paths, change size, dependency major upgrade and a minimum
deterministic-finding score, combined with `any` or `all`. Then, in order: a valid receipt for the same diff hash, model family,
prompt/policy version and scopes (reused unless `force`), cooldown, concurrency, per-diff attempts, the per-run token and dollar
caps, and the monthly dollar cap. A budget breach skips or fails per `onBudgetExceeded`. Every cap is mandatory (the validator
rejects a missing or non-positive one).

## Context and sandbox

`sandbox_spec` is read-only, no network, no tools, no repo write, no promotion and no mounted secrets. The native worker's
OpenAI-compatible endpoint is the local LiteLLM alias (`litellm`); the policy validates that the configured gateway remains
local and returns token, attempt, monthly spend and concurrency limits to the caller. The workflow must enforce these limits
at the gateway and worker. This policy library does not itself make a model call or configure the host gateway. `build_context` scrubs
every file (token shapes plus known secret values) before it can reach a model, sorts files, caps bytes, records a path, commit,
line range and SHA-256 per entry, and wraps content as `untrusted-repository-file` data with a system notice that it is never
instructions. Instruction-like text in a repository file is counted and flagged, never followed. The manifest hash is
deterministic for the same inputs.

## Findings

`normalize_findings` keeps only findings whose path, line and commit resolve to the manifest, so invented references are dropped.
It creates stable path-and-claim fingerprints (line and commit are occurrence evidence, not identity), preserves the actionable
line, suggestion and reviewer session, and forces model severity/confidence into `claimedSeverity`/`claimedConfidence` while
the ledger-facing severity is `info` and confidence `unknown`. Every kept finding is `needs-verification` with
`gateEffect: advisory`. The check-provider bridge sends these occurrences to the existing #52 ledger and retains reviewer
session provenance in evidence references; it creates no parallel findings store. `confirm` is the only way to strengthen one,
and only through `deterministic-validation` or `authorized-review` with evidence; a model's own assertion is never a CVE gate.
Actual usage is checked with `validate_usage`; missing or over-cap usage returns `partial`, never a complete/pass result.
`make_receipt` and `spend_summary` record cost for the operator view (#603).

Prompt and policy are versioned through `promptVersion`, which is part of the receipt key. Observability (#128/#129), issue dedupe
and agent triage (#105) are consumers of the receipt and findings, not part of this library.
