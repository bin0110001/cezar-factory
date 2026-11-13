# Documentation refresh (incremental drift detection and recovery)

`scripts/docs/docs_refresh.py` keeps the derived documentation index current at bounded cost. It
consumes verified-merge events (the existing execution ledger owns them; no second ledger is
created) and stores only its own queue (`queue.json`) and index (`index.json`), both written
atomically and rebuildable from Git (`rebuild`). State carries `factory-doc-refresh/v1`; an unknown
version is refused and corrupt files are set aside as `*.corrupt`.

- **Impact before models.** `impacted_sections` maps changed files (and configured dependents) to
  sections deterministically. Docs-only, excluded and unrelated changes cause zero generation calls.
  Deterministic extractors (`extract_contract`: Python, GDScript, PowerShell, scenes/resources, JSON)
  produce contract hashes; `detect_drift` reports severity and evidence from them.
- **Revision grounding.** A job is pinned to a target and SHA. A SHA that is not the merged target head
  (or its ancestor) is rejected; an older or duplicate SHA cannot overwrite newer verified docs.
  Events for one target coalesce (debounce); replays are idempotent.
- **Recovery.** Jobs lease while running; `recover` returns expired leases to pending. Failures back off
  exponentially (30 s, capped at 30 min), fail after 4 attempts, and escalate with a linked-issue request
  from the third. Sections are published only after every impacted section generated; a failure marks
  them `unverified` and never keeps stale claims as verified.
- **Gate.** Only a section the policy names in `blockingSections` with critical severity returns `block`;
  everything else is `advisory` and never stops issue completion.
- **Claims** carry source, source SHA and evidence, or are `unverified`.
- **Safety.** Secrets, binaries, licensed assets, generated and vendor paths are excluded; paths with
  traversal or absolute form are refused; suspected instructions in source comments are redacted before
  any prompt. Nothing here needs hosted CI; it runs on local Podman runners.

Tests: `tests/test_factory_docs_refresh.py`.
