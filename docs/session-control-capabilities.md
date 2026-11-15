# Session-control capability profile (#346)

`scripts/session/capability_broker.py` issues and checks short-lived credentials for graphical
session control (ADR `docs/adr/344-graphical-agent-control.md`, parent #329). It owns no session,
lease, scheduler or evidence store: the fence comes from the session runtime via `fence_lookup`.

- **Profile:** `observe` (screenshot, snapshot, read_text) is separate from `control`
  (click, type, key, scroll). `control` implies `observe`, is opt-in, and is behind
  `FACTORY_SESSION_CONTROL=1`; with the flag off it cannot be issued or used.
- **Credential:** HMAC-signed token bound to project, run, attempt, session and fence; audience
  `session-control`; TTL default 300 s, capped at 900 s.
- **Denied (fail closed):** bad/foreign signature, wrong audience, expiry, revocation, another project
  or session, any target other than the session (host desktop, controller, sibling job), stale fence
  (so a restart or reconnect cannot restore an old token), unknown action, gateway/lookup outage,
  and control input during human takeover (`suspend`; resume needs a fresh decision).
- **Project config** may only narrow capabilities; unknown keys/scopes and widening are rejected.
- **Redaction:** denial reasons are stable codes; `redact()` strips tokens from log text. Pass
  tokens through the environment or stdin, never process arguments.

Tests: `tests/test_session_capability_broker.py`.
