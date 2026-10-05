# Hindsight live deployment evidence

Captured 2026-10-03 on Bazzite after deploying the official
`ghcr.io/vectorize-io/hindsight:0.10.0` image.

- Container: `cezar-factory-hindsight`
- Listener: `127.0.0.1:8888` on the Bazzite host
- Persistent volume: `cezar-factory-hindsight-data`
- LLM provider: OpenAI-compatible client through the local LiteLLM gateway
- Model: `factory-small`
- Retain completion budget: 12,000 tokens, compatible with the vLLM 16,384-token context
- The service is localhost-only; no credentials are recorded here.

## Live checks

- `GET /health`: HTTP 200, status `healthy`, database `connected`.
- MCP `initialize` handshake at `/mcp/`: HTTP 200, server `hindsight-mcp`, protocol `2025-06-18`.
- Retained a bounded deployment fact in the `factory` bank: HTTP 200 and operation completed.
- Recalled the fact from the same bank: HTTP 200 and returned the LiteLLM/Bazzite and vLLM/Mac mini relationship.
- Restarted the Hindsight container, then repeated health and recall successfully; the retained fact survived the restart.
- Container remained running after the checks.

The Cezar workflow connection is now configured through the private Factory
network and the Cezar service's `FACTORY_RUNTIME_ROOT`. Its isolated-worktree
delivery path is versioned separately from this service-health evidence.

## Bounded Factory recall check

Captured 2026-10-04 after the Cezar GitHub credential rotation. A Factory
client protocol check initialized a stateful MCP session against the `factory`
bank, sent the required `notifications/initialized` notification, then made a
read-only `recall` call using the low budget and a 256-token cap.

- Recall response: HTTP 200, 3,778 bytes.
- Memory contents, identifiers, tokens, and raw response were intentionally not
  printed or retained by the check.
- This proves the deployed Hindsight MCP recall path.

## NeonPath planning pilot

Captured 2026-10-04 for issue #43.

- The first normal Cezar run correctly failed before planning: its isolated
  Git worktree did not contain NeonPath's ignored project-local Factory runtime
  files.
- A planning-only retry with `worktree: false` completed before it could be
  cancelled. It consumed a bounded recall artifact from `project-neonpath` and
  `factory`: 2 selected memories, 1,808 characters. No raw memory content was
  captured.
- The retry did not dispatch implementation, lease work, retain a memory,
  create sub-issues, or modify source files. It is evidence of recall and plan
  routing, **not** an endorsement of disabling worktree isolation.
- The remediation is the registered `FACTORY_RUNTIME_ROOT` deployment model in
  `docs/synchronization.md`. Future pilots must use isolated worktrees with
  check scripts loaded from that central, version-pinned runtime.
- The post-remediation no-agent preflight used a normal isolated Cezar worktree
  and verified the central recall, validation, and routing scripts. It
  completed with zero agent tokens (`f9a73365-92cc-4a88-90f9-0b3f5bf2888d`).
- A subsequent full isolated-worktree planning run for NeonPath #49 completed
  recall, planning, validation, and GitHub routing with the Claude runner
  (`78c92a2c-0637-4641-88fa-55236225a297`). The resulting `factory:needs-help`
  state correctly reflects the issue's declared blockers; no retention was
  attempted. An earlier OpenCode run recalled successfully but stalled during
  planning and was cancelled before validation or routing.
