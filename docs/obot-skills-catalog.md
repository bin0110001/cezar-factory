# Obot Skills catalog (issue #168)

Git stays the source of truth. `integrations/obot-skills/catalog.json` is the approved
pilot catalog Obot indexes: each bundle pins a repository, path and **immutable commit**,
a content `digest`, metadata (languages, capabilities, owner, license, trust, permissions)
and an explicit `projectTypes` allow-list. A bundle with no `projectTypes` is rejected, so
.NET, Python and general projects receive nothing unless a bundle names them.

## Resolving a bundle

`scripts/obot-skills/obot_skills.py` is the supported CLI fetch path. The Obot POC (#165)
runs unreachable from some hosts and its bundle API is not required: no custom catalog
service was built.

```
python3 scripts/obot-skills/obot_skills.py validate
python3 scripts/obot-skills/obot_skills.py resolve --project-type godot --cache <dir> [--offline] [--lock installed.json]
```

- Fetches only the pinned commit with `git`, checks the HEAD equals the pin, and verifies the
  bundle digest (sha256 over sorted `relpath NUL file-sha256` lines) before it enters the cache.
- Rejects symlinks, a missing root `SKILL.md`, path traversal and integrity mismatches.
- Two projects resolving the same bundle get the same verified bytes; the cache is keyed by digest
  and re-verified on every use (a tampered cache is evicted).
- After warmup `--offline` serves from the cache; uncached content is reported under
  `unavailable` (exit 1), never substituted. `--lock` records the installed repository, commit and digest.

## Pilot bundle

`godot-core` publishes `skills/factory-godot-upgrade` from this repository at the pinned commit.
Expand the catalog only through the same validation. Update a pin by changing `commit` and
`digest` together in a reviewed PR. Project-type resolution and precedence are #169.

Not verified here: indexing in a live Obot instance (unreachable from this run) and PowerShell
invocation on Windows; the tool is stdlib Python and uses only `git`.
