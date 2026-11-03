# Predicted/actual impact on workspace leases (#197; epic #192)

Extends the existing workspace lifecycle registry (`cezar/packages/cezar/src/workspace/lifecycle.ts`,
SQLite `registry.sqlite` per repo, fenced executions, events). **No second lease store.**

## Audit of the existing protocol (integration points)
- One active execution per `{repo, issue}` (unique partial index), `fencing_token` bumps on takeover,
  `lease_expires_at` + heartbeat, `integration_locks` serialize merges per target branch, `events`
  is the append-only audit log (the #127 ledger source), `workspaceOverlaps()` already reports
  actual changed paths advisory-only. Crash/stale recovery is `recoverWorkspace` (higher fence,
  workspace preserved); abandoned worktrees go through `recoverable` before `pruneWorkspace`.
- Issue ownership and the merge lock stay **enforced**; impact reservations are **advisory**.

## Additions
- Table `impact_reservations(execution_id PK -> executions, base_sha, manifest_revision, predicted_json, expires_at)`;
  created idempotently with the registry, ignored by older builds.
- `recordPredictedImpact` — fenced (rejects a stale `executionId`/`fencingToken`), upserts the
  reservation, emits `impact_predicted`. Reservations expire (default 120 min), so a stale one is never permanent.
- `reconcileActualImpact` — actual paths from git (committed + staged + unstaged + untracked, shared
  `changedPaths` helper also used by `workspaceOverlaps`) versus the prediction: `unpredicted`,
  `untouched`, `mismatch`; emits `impact_mismatch` once per distinct unpredicted set (replay-safe).
  No reservation is reported as `none` — never as "no impact".
- `impactSnapshot` — normalized view (owner, state, lease, reservation status, actual paths) plus
  predicted/actual overlaps among live, unexpired claims. `coordination.domain` is always
  `local-host`; with `multiHost: true` it is flagged `degraded` ("absence of overlap is NOT guaranteed").

## Honest limits
Local SQLite gives mutual exclusion on one host only. Multi-host edits to one repository need the
designated coordinator; until then the snapshot says so rather than reporting global absence.
Not built here: the external-developer skill text, CLI verbs (`inspect/claim/heartbeat/release/notify`
exist for claim/heartbeat; impact verbs to follow), drift-triggered replanning (#200).

Tests: `cd cezar/packages/cezar && npx vitest run src/workspace/lifecycle.test.ts`.
(10 unrelated `src/workspace` home-safety/config tests already fail on `dev` in this Windows environment.)
