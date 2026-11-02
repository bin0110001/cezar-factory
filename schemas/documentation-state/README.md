# Documentation state contract

This contract describes authored requirements and documentation evidence. It
does not create another run/event ledger, resolve dependencies, or execute
reconciliation. The record is versioned independently as
`factory-doc-state/v1`; consumers must reject an unknown version for decisions
and preserve its original bytes for repair or later migration.

## Authority and storage

Git is the initial source of truth for authored specs, ADRs, and contract
examples. Store records with the repository content they describe and pin each
record to a repository slug, branch, base SHA, observed SHA, and source anchors.
An external index may cache or search Git records, but it is a rebuildable
adapter and must link back to the immutable Git revision. It cannot approve or
rewrite a record.

| Information | Authority | Conflict behavior |
| --- | --- | --- |
| Requested scope, acceptance criteria, and issue dependencies | GitHub issue at the referenced revision | Issue describes intent; it cannot prove implementation behavior. Preserve links and record conflicts for a human to resolve. |
| Implemented behavior | Source code at the observed Git SHA | Tests and source anchors support claims; a mismatch with an approved spec is drift, not an automatic spec update. |
| Intended public contract | Approved spec/ADR in Git at its approved revision | Changes require an explicit review and state transition. Approval does not imply implementation or verification. |
| Retrieved recollections | Hindsight | Suggestions only. Add source-backed claims to Git through review; memory never overrides source evidence. |
| Generated wiki or search index | Derived output | Rebuild from Git; stale or conflicting output is discarded or marked stale. It is never a source of truth. |
| Test and review evidence | Immutable run/review artifacts referenced by the record | Evidence supports only the exact revision and scope tested. The existing run/evidence contract owns full execution details. |

## Lifecycle and claim rules

Allowed transitions are `null -> proposed`, `proposed -> approved`,
`approved -> implemented`, and `implemented -> verified`. Any non-superseded
state may transition to `superseded`; no other transition is valid. Correct an
approved or verified statement by creating a new revision and review transition,
not by rewriting historical evidence. Record actor, time, and reason for every
transition. A proposed requirement is never automatically promoted.

Every claim is either `proposed` or `verified`. Proposed claims must set
`speculative: true`; their text is a hypothesis until approved. Verified claims
must set `speculative: false` and cite evidence. A record in `verified` state
must have a verifier, tool version, timestamp, and evidence, and every claim
must be verified. JSON Schema checks record shape; consumers also enforce the
transition and cross-field rules because Draft-07 cannot compare two records or
SHA fields.

Freshness compares `freshness.checkedAgainstSha` with `revision.observedSha`.
`fresh` requires equality; `stale` requires a different SHA and records why;
`unknown` means no comparable source/evidence exists and omits
`checkedAgainstSha`. Missing or stale evidence makes advisory documentation
checks fail open with an explicit unknown/stale result. It never makes a record
verified. Approved-contract and security gates remain mandatory when enabled
for a project and fail closed when their required evidence is missing or stale.

Concurrent branches keep separate revision-pinned proposals. Never apply
last-write-wins to approved state. Before approval, rebase/re-anchor and
revalidate against the chosen base. If two branches propose incompatible
approved contracts, retain both histories and require a named human owner to
resolve the conflict with an audit reason.

## Project policy and privacy

Projects default to `opt-in`; a project can explicitly select `opt-out` for
advisory spec-routing checks. The `approved-contract` and `security` gates are
mandatory wherever configured and cannot be bypassed by missing documentation,
an override, or an index outage. Human overrides apply only to advisory routing
and require actor, reason, and expiry/review point in the consuming workflow.

Do not copy secret, credential, licensed, or restricted content into records,
fixtures, indexes, or evidence. Do not ingest generated, vendor, build, or
excluded paths as authored requirements. Store only an allowlisted source
anchor or a non-sensitive exclusion reason; do not publish sensitive paths,
content hashes, prompts, or excerpts. `sensitivity` is a handling label, not
permission to export the record.

## Change routing policy

Routing is deterministic from the changed surface and configured gates. Model
impact estimates can explain or suggest routing but cannot silently change the
classification or project policy. A human can override an advisory choice with
an actor, reason, and review point. Security and approved-contract gates are
not overrideable.

| Change scenario | Default route | Human override |
| --- | --- | --- |
| New public API or protocol | Spec-first | Owner may choose code-first only with a reason and explicit contract review. |
| JSON schema or persisted record format | Spec-first | Contract owner documents compatibility and migration rationale. |
| Database or on-disk migration | Spec-first | Security/data owner review remains mandatory. |
| Cross-component interface or serialization change | Spec-first | Architecture owner records why a spec update is unnecessary. |
| New subsystem or ownership boundary | Spec-first | Maintainer records the narrow implementation scope. |
| Security, credential, or trust-boundary change | Spec-first plus mandatory security gate | No override of the security gate. |
| Small isolated bug fix with no contract change | Code-first | Author may opt into a spec note. |
| Refactor that preserves observable behavior | Code-first | Contract owner can require spec-first if evidence shows behavior changes. |
| Documentation typo or formatting-only edit | Code-first | Maintainer may request broader docs review. |
| Emergency reliability repair | Code-first with follow-up record | Incident owner records urgency and review deadline; security gates remain. |
| Generated code or generated API client | Excluded from authored-spec routing | Review the generator/input contract instead. |
| Vendored third-party source | Excluded from authored-spec routing | Review upstream provenance and local patch separately. |
| Secret or credential-bearing file | Excluded and never indexed | No override to ingest the secret; replace it with a safe interface description. |
| Licensed content without redistribution rights | Excluded from snapshots/indexes | Legal/maintainer review may approve metadata-only references. |
| Change with missing repository or base SHA | Advisory route is unknown/fail-open | Owner may supply a pinned revision; mandatory contract/security gates still block promotion. |

## Migration and retention

The schema version is carried on every record. A v0/unversioned record is
migrated by writing a new v1 record and retaining the original bytes. The
migration example in `fixtures/migration-v0-to-v1/` maps old `summary` text to a
proposed, explicitly speculative claim; unknown owner, sensitivity, freshness,
and verification become `unknown`/`internal`/`not-verified` values. Migration
never infers approval, verification, or currentness. `migratedFrom` identifies
the old format and source reference. Unsupported future versions are preserved
but not used for routing or gates.

Git history is the retention record for authored contracts. Run evidence follows
the existing evidence retention policy and is referenced, not duplicated.
External indexes are disposable caches. Removing a cache never removes the Git
source or evidence required by an open review. Keep sensitive content outside
both Git records and indexes.

## Fixtures

`state.schema.json` validates record shape. The test suite also applies the
cross-field lifecycle/freshness rules to valid, invalid-transition,
stale-evidence, speculative-claim, and migration fixtures. Fixtures use
synthetic revisions and contain no secrets or deployable configuration.
