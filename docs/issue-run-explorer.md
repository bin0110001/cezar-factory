# GitHub issue run explorer

GitHub issue detail reads the project-local coding-run ledger for the selected
issue number. The ledger remains authoritative for run metadata and lifecycle;
the UI does not infer run history from comments or copy the Langfuse trace view.

`GET /api/v1/p/:projectId/tracker/:issueNumber/run-explorer` returns up to 20
newest run summaries per page. Its opaque cursor is bound to the repository and
issue and uses a stable `(updatedAt, runId)` keyset. Each run includes bounded
attempt, timeline, and evidence summaries. The server preserves `unknown` for
corrupt or unsupported records, reports completed runs without validation as
`untested`, and marks a passed run `flaky` when an earlier attempt failed or
was cancelled. Current task records may refine an exact run ID match to
`waiting`; a GitHub `factory:blocked` label appears separately with a link to
the issue's blocker comments. Projection payloads above one megabyte are reported
as incomplete instead of being loaded into the page.

Trace links require `LANGFUSE_HOST` and `LANGFUSE_PROJECT_ID`. The server checks
`/api/public/health` with a 1.5-second timeout and caches the result for up to
10 seconds; missing or unhealthy configuration is rendered as unavailable. Trace
IDs are derived from the coding run's correlation identity and the URL is built
with the existing HTTP(S)-only Langfuse URL helper. No Langfuse credentials are
returned to the browser. The link is direct, so Langfuse remains the authority
for project access and will prompt or deny users whose browser session lacks
permission.

Evidence is listed from the coding-run projection and its digest-bound manifest.
Downloads are scoped to the active project and require the run ID, issue number,
and SHA-256 to match the ledger. The content-addressed store checks expiry, size,
and digest before returning the already-redacted bytes with `private, no-store`
and `nosniff` headers. Expired, missing, or mismatched evidence is not served.

The read model links to verification history and dependency views. Release
Control Center detail is shown as unavailable while its read model (#70) is
still open; the explorer does not create a competing release view. Jira and
Linear identifiers are not joined to numeric GitHub issue IDs.
