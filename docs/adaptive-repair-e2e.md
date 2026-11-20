# Adaptive repair end-to-end fixtures

`tests/adaptive-repair-e2e.ps1` proves deterministic in-session repair (issue #742, parent #736) with no
provider calls and no GitHub Actions. It runs from `tests/run-tests.ps1`.

- `tests/fixtures/adaptive-repair/fake-session.ps1`: fake session counting create vs continue calls (and
  worktree/cache builds), a fake clock, secret canaries, and a bounded reference driver.
- Covers: one session create with N continuations, table-driven stop/continue scenarios, test-tampering and
  stale-revision rejection, baseline acceptance, duplicate dispatch, crash after reservation, resume
  unavailable, seeded property invariants, and ledger/receipt canary scans.
- The coordinator, evaluator and policy modules (#739-#741) are gated on file presence and reported as
  `SKIP`. When one lands, the test fails until its scenarios are bound to the real module.
