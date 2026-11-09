# Verification query layer

A shared, **read-only** view over verification results, for the CLI and UI (parent #57, epic #47).
It never writes to the ledger and never changes a producer (#50 executor, #52 ledger, #53 selection,
#54 baseline policy). Agent prompts get bounded, redacted, deterministically ordered pages, never raw logs.

- Code: `scripts/verification-query.ps1` (dot-source; functions only, no side effects, no entry point to
  run from a skill). Callers invoke it from their own workflow `command:` step or application code.
- Response schema: `schemas/verification-query.schema.json` (`schemaVersion` 1; other versions are rejected).
- Tests: `tests/verification-query.ps1`, run by `tests/run-tests.ps1`.

## Calling it

```powershell
. ./scripts/verification-query.ps1
$json = Invoke-VerificationQuery -Snapshot $snapshot -Kind failures -PageSize 20
$next = Invoke-VerificationQuery -Snapshot $snapshot -Kind failures -PageSize 20 -Cursor (($json | ConvertFrom-Json).page.nextCursor)
```

| Parameter | Meaning |
| --- | --- |
| `-Kind` | `runs`, `selected`, `deferred`, `failures`, `episodes`, `artifacts`, `baseline` |
| `-RunId`, `-Status` | Optional filters (`-Status` applies to run, failure, episode or baseline status). |
| `-PageSize` | 1–200, default 50. |
| `-Cursor` | `page.nextCursor` of the previous page of the **same** query. |
| `-InlineBytes` / `-ExcerptChars` | Inline cap (default 2048 bytes) and head/tail excerpt length (default 512 chars). |
| `-MaxResponseBytes` | Whole-response cap (default 262144); trailing items move to the next page. |
| `-KnownSecrets` | Literal secret values (for example from the environment) scrubbed wherever they appear. |

## Input contract (snapshot)

Producers map their records into this shape; `ConvertFrom-VerificationRunResult` does it for an executor
`VerificationRun` result (`resultVersion` 1, `cezar/packages/contract`). The ledger and baseline policy supply
`episodes` and `baseline`, which the executor result does not carry.

```json
{ "schemaVersion": 1, "runs": [ {
  "id": "run-1", "startedAt": "2026-10-01T10:00:00Z", "finishedAt": "...", "status": "failed",
  "commitSha": "...", "baseSha": "...",
  "selected":  [ { "testId": "t-1", "reason": "touches src/a" } ],
  "deferred":  [ { "testId": "t-9", "reason": "slow suite deferred to nightly" } ],
  "failures":  [ { "id": "f-1", "testId": "t-1", "status": "failed", "message": "...", "output": "..." } ],
  "episodes":  [ { "id": "e-1", "fingerprint": "...", "status": "open", "firstSeenAt": "...", "lastSeenAt": "...", "occurrences": 4 } ],
  "artifacts": [ { "id": "a-1", "name": "build.log", "path": "artifacts/build.log", "mediaType": "text/plain", "content": "..." } ],
  "baseline":  { "baselineRunId": "run-0", "status": "regressed", "regressions": ["t-1"], "fixed": [], "unchanged": 12 } } ] }
```

An artifact with `content` is bounded by the layer. A reference-only artifact (executor result) supplies
`bytes` and `sha256` instead and is always returned as a reference.

## Response

```json
{ "items": [ ... ], "kind": "failures", "limits": { ... },
  "page": { "hasMore": true, "nextCursor": "<opaque>", "returned": 20 },
  "query": { "pageSize": 20, "runId": "", "status": "" }, "schemaVersion": 1 }
```

Errors are structured and never partial: `{"schemaVersion":1,"error":{"code":"...","message":"..."}}` with
`invalid_cursor` (malformed), `stale_cursor` (issued for another query or schema version), `invalid_query`,
`unsupported_input_version`.

### Guarantees

- **Deterministic.** The same snapshot and query give byte-identical output. Order is `startedAt` descending, then
  run id, then item id, compared ordinally (never culture dependent); duplicate ids get a content-derived
  suffix. Keys are serialised sorted; no timestamp is generated at query time.
- **Pagination.** Keyset cursors (position in the total order), so pages have no gaps or duplicates even if
  producers append between calls. The cursor is opaque (base64url) and bound to the query and schema version.
- **Redaction.** Authorization/Cookie/API-key headers, bearer/basic credentials, `key=value` and JSON pairs whose
  key names a secret, private-key blocks (unterminated blocks are redacted to the end), URL credentials, common
  token shapes (GitHub, Slack, AWS, OpenAI-style, Vault, JWT) and `-KnownSecrets` become `[REDACTED]`. Redaction
  runs before excerpting, so excerpts cannot leak. Patterns are best effort; unknown formats fail closed only
  through the size cap, so keep large content as references.
- **Size caps.** Text over `InlineBytes` (failure messages and output, artifacts, reasons) returns `content: null`
  with a redacted `head`/`tail` excerpt, the original `bytes`, the `sha256` of the original and a `reference`
  (`run:<id>/artifacts/<id>`) for retrieval. The whole response is capped by `MaxResponseBytes`.
