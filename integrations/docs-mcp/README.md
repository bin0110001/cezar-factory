# Documentation search/read through the Obot gateway

A read-only, source-grounded documentation layer for coding agents. It is
registered as an upstream of the existing Obot vMCP (see
[../mcp-gateway/README.md](../mcp-gateway/README.md)); runners need no change.
The reference adapter is `scripts/docs/search.py`; the backend (OpenWiki or
another, per the #175/#176 selection) sits behind its small
`search/read/revision/indexed_at` interface. Until a backend is selected the
checked-in `docs/` of each repo is the backend, and it stays the fallback.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `docs_search` | project, repo, ref, query, limit (max 5) | anchored snippets (max 600 chars) with path, line, evidence link `project/repo@sha:path#Lline` |
| `docs_read` | project, repo, ref, path, max_chars (max 8000) | one page, truncated and flagged |

Every response carries `sha`, `freshness` (`fresh`, `stale`, `index-absent`),
`status` (`ok`, `fallback`, `stale`, `index-absent`, `unavailable`, `excluded`)
and `untrusted: true`.

## Guarantees

- Authorisation (identity -> project/repo/ref grants) runs before any backend is
  contacted; a denial reveals nothing about the target.
- Bounded results, per-call timeout, one retry, 60 s cache; if the service is
  down the result is `unavailable`, never an exception, and code work continues.
- Retrieved text is fenced as untrusted: instruction-like phrases and
  credential-shaped text are removed. Licensed asset paths are excluded.
- The audit log records tool, identity, scope, outcome, query *hash*, result
  size and latency; never the query text, content or secrets. Latency and size
  feed the OTel/Langfuse metrics hook (`metrics=`; p95 via `percentile`).
- No full-wiki auto-injection: the agent calls the tools on demand.

## Agent guidance

Query when a question concerns architecture, conventions or past decisions;
inspect source directly for exact behaviour, and whenever a result is `stale`,
`index-absent` or contradicts the code. Source wins. Cite the `evidence` link
and `sha` in answers.

## Not yet done

Obot registration of the upstream, per-project skill resolver publication
(#168-#170) and live Langfuse export need the host and the #175/#176 backend
decision; they are deliberately out of this change.
