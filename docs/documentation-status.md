# Documentation status read model

Issue #180 (epic #174). The Factory UI shows where documentation came from and whether it describes the
code on a branch or target SHA. It adds no wiki editor, graph or dashboard: it reads
`factory-doc-state/v1` records (`schemas/documentation-state/`) and reuses the run explorer (#135), MCP
status (#171), Langfuse (#129) and graph/decision views (#151, #152) by link.

- Code: `scripts/documentation-status.ps1` (dot-source; functions only, no entry point for a skill).
- Tests: `tests/documentation-status.ps1`, run by `tests/run-tests.ps1`.

## View model

`ConvertTo-DocumentationStatusView -Records -Target @{branch;sha} -Backend -Operations` returns:

- `panelState`: `ready`, `empty`, `index-disabled`, `unavailable` (backend absent) or `degraded` (MCP missing
  or in error; recorded state still shown). None of these blocks unrelated coding work.
- `documents[]`: `displayState` (`proposed`, `approved`, `implemented`, `verified`, `stale`, `unknown`,
  `superseded`), a `label`, `codeVerified`, `matchesTarget`, `sourceSha`, `groundedSha`, source files,
  evidence, per-claim labels and the reasons behind any downgrade.
- `summary`: counts by display state, stale, unknown and pending counts, claim verification coverage, and the
  backend-owned `lastSuccess`, `lastFailure`, `costUsd` and `queue`, passed through from `-Operations`.
- `links`: refresh and repair job references, and the views reused above.

The function classifies; it does not recompute freshness. "Code verified" requires state `verified`, fresh
evidence checked against the observed SHA, a verifier with evidence, every claim verified and non-speculative,
and an observed SHA equal to the target. Anything weaker is shown as implemented, stale or unknown. A proposed
record or claim is always labelled "Design proposed" and cannot appear as implemented. Unsupported record
versions are shown as unknown and never used for decisions.

`Get-DocumentationImpact` compares two views and lists changed documents with source files, confidence and
unknowns, marking each change as code verified or design only.

## Actions

`Invoke-DocumentationAction` handles `refresh`, `retry`, `approve` and `override`. It is deny-by-default
(`docs:refresh`, `docs:approve`, `docs:override`, plus a named actor), requires an idempotency key, and appends
every attempt, denied ones included, to the ledger. Statuses: `accepted`, `duplicate` (same key and request
replays the original outcome), `denied`, `conflict`, `unavailable` and `invalid`.

- Approval is compare-and-set on the observed SHA and only for a `proposed` document with a reason. A changed
  SHA is a `conflict`; there is no last-write-wins. The result is a transition request for the caller to
  persist through the normal review path; approval never marks anything implemented or verified.
- Refresh and retry return a deterministic job key. With the backend down or the index disabled they return
  `unavailable` and queue nothing.
- Override is advisory-routing only, needs a reason and a review-by point, and is refused for
  `approved-contract` documents and the mandatory `security` and `approved-contract` gates.

The ledger is an in-memory object the caller persists; this module owns no storage.
