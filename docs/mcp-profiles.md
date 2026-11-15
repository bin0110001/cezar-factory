# MCP profiles for managed agents (#167)

`scripts/mcp/profile.py` is the runner-neutral contract; `config/mcp-profiles.json` is the policy-revisioned base.

- **Merge order:** global (base) → projectType → project → task. Overlays can only narrow `tools`, `runners`, `projects`, tighten `required`, or `remove` an optional server. Widening, unknown fields, unknown servers and embedded endpoint credentials raise a setup error. Output is sorted and hashed, so the same policy revision gives the same `revision` everywhere.
- **Adapters:** Claude writes `.mcp.json`, Codex writes `config.toml`. Both reference `CEZ_MCP_TOKEN_<SERVER>` env vars; tokens are returned only in the `env` mapping for the agent process, never written to files, Git or prompts. Files are mode 0600 in the run's runtime directory.
- **Preflight:** gateway reachability, identity and required tools are checked in `prepare` before the agent starts. `PreflightError.kind` is `setup`, `identity` or `required-tool`; optional servers (e.g. offline-cacheable skills) only produce warnings.
- **Lifecycle:** run identities come from a broker (`HttpBroker`, the #165/#166 gateway boundary). A retry with the same run id and revision reuses identities; a changed revision is refused. `cleanup` runs on cancel or completion, revokes every identity and deletes the files; if revocation fails the state file is kept so it can be retried.
- **Not yet done:** calling `prepare`/`cleanup` from the Cezar dispatch path and a live gateway smoke test, both of which need the #165/#166 gateway endpoints.
