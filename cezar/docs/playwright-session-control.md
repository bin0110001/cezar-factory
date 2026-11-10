# Playwright session-control adapter

The browser adapter in `packages/cezar/src/session-control/playwright-adapter.ts`
accepts a Playwright browser supplied by the session executor. The adapter checks
the executable version against the trusted expected version; the executor owns
the browser binary and launch configuration. This package does not launch a shared browser
or expose a debugging port. Each adapter instance creates a new browser context
with downloads disabled and service workers blocked, and it binds that context to
one run, attempt, session, and lease validator.

The adapter checks the trusted session capability before actions, limits requests
to 60 per rolling minute, and applies an exact HTTP(S) origin allowlist to every
browser request as well as navigation. Worker level network egress rules remain
required because URL routing is not a substitute for network isolation. Playwright
tracing omits source files; screenshots and traces are passed to the executor's
artifact sink, with screenshot payloads capped at 4 MiB and trace files at 8 MiB.
Action events carry immutable run/attempt/session/request IDs and action type, but
omit selector values, typed text, URLs, and page contents.

`close()` is idempotent. It stops tracing, stores the bounded trace through the
artifact sink, removes its temporary trace file, and closes the context. A
`requestStop` action uses the same cleanup path. Consumers must treat loss of the
lease as terminal and call `close()` when their worker exits.

The adapter is deliberately an injected Playwright boundary. The caller supplies
the pinned runtime, trusted allowlist, lease check, artifact store, and trace-event
writer; none of those values may come from the agent-controlled request. Playwright
MCP can be placed behind a separately scoped tool profile, but its arbitrary-code
tool is not an authorization boundary and is not used by this adapter. See the
[graphical agent-control ADR](../../docs/adr/344-graphical-agent-control.md) for
the tool choice and threat model.
