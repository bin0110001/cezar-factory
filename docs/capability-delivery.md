# Capability policy delivery

`policies/capability-policy.json` (gateway profile plus approved skill-catalog references, each with a
`sha256` content hash) is part of the pinned Factory release, so it follows the same dev auto-update and
stable reviewed-promotion path as every other managed asset. There is no separate Obot push pipeline.

`scripts/release/factory_capability_delivery.py` activates one verified policy per channel:

1. **stage** the policy as an immutable snapshot keyed by its digest (idempotent);
2. **verify** against the gateway: extra, missing or changed capabilities all fail;
3. **swap** the per-channel `active.json` pointer atomically, remembering the last good digest.

If any step fails, including Obot being down, the pointer does not move and nothing new is enabled.
`recover` finishes or undoes an interrupted activation; `rollback` returns to the last good digest;
`drift` reports gateway divergence. Evidence is appended to `evidence.jsonl` (ids, digests and outcomes only).

Tasks pin their policy at first resolution (`pins/<task>.json`); retries and later promotions never change it.
Precedence is policy over project: a project may opt in only to approved entries and may not opt out of
`required` ones. Policies containing credential-like keys or values are rejected; tokens never go in `.ai`.
`stable` activation requires `--approved-by`. #169 owns resolution semantics; this owns delivery only.
