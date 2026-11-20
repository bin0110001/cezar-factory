# Repair receipts, idempotent recovery and operations visibility (#743)

`scripts/repair/repair_receipts.py` makes adaptive-repair rounds durable. It extends the existing
run directory (`repair-receipts.jsonl` beside the run's other ledgers); there is no separate incident store.

- **Receipts** (`schemas/repair-receipt.schema.json`, versioned, append-only): opaque session ref, attempt,
  input/output artifact revision, fixed/new/persistent findings, strategy, actor, effective policy, evidence refs,
  outcome and stop reason. Every write is redacted with the shared #579 redaction; the raw session id is never stored.
- **Idempotent recovery**: `reserve_attempt` atomically creates a per-attempt reservation (create-exclusive) with a lease.
  A replay after a crash returns the existing receipt (`replay`, no turn, no budget). A live lease is `in-progress`;
  an expired lease without a receipt is recorded as `stale-timeout`/blocked, never silently resent. If same-session
  resume is unsupported the outcome is explicit `blocked`; no replacement agent is started.
- **Read model** (`read_model`): active repair, `N/max` rounds, fixed/new/persistent counts, strategy, exact stop reason,
  and history collapsed by default. `classify` separates running from stale timeout, validator error, unsuccessful
  implementation and governance stop.
- **Counters** (`counters`): repair success, no-progress, oscillation, per-rule recurrence, duration/token cost and provider cache usage when present.
- **Operator actions** (`operator_action`): `recover`/`replan` require an authenticated operator, are audited to
  `operator-audit.jsonl`, and are refused when policy/governance forbids; they never start a replacement agent.
- **Retention**: reads drop receipts older than the retention window (default 90 days); the ledger is otherwise never rewritten.
- History from #52/#55 is a hint only, never authority.
