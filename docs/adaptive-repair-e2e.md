# Adaptive repair end-to-end fixtures

`tests/adaptive-repair-e2e.ps1` proves bounded policy behavior with fake sessions and no provider
calls or GitHub Actions. The Cezar runtime integration test in
`cezar/packages/cezar/src/workflows/run.test.ts` executes an opted-in workflow and proves that a
repair turn reruns the full matrix while starting exactly one provider session. It runs in the
Cezar Vitest suite.

- `tests/fixtures/adaptive-repair/fake-session.ps1`: fake session counting create vs continue calls (and
  worktree/cache builds), a fake clock, secret canaries, and a bounded reference driver.
- Covers: one session create with N continuations, table-driven stop/continue scenarios, test-tampering and
  stale-revision rejection, baseline acceptance, duplicate dispatch, crash after reservation, resume
  unavailable, seeded property invariants, and ledger/receipt canary scans.
- The PowerShell harness also asserts that the real Cezar runner and default implement workflow keep
  the continuation adapter, artifact revision binding, and validation-before-publication wiring.
- The `repair-progress` and `repair-policy` workflow command steps invoke the pure progress evaluator
  and the bounded repair policy; validation evidence is serialized with the exact worktree artifact
  digest before the decision step can authorize repair or publication.
