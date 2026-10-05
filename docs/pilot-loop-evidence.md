# Planning/implementation/review pilot evidence

Verified on 2026-10-03 by `pwsh -NoProfile -File tests/run-tests.ps1`.

The runtime-script portion of the Factory self-test pilots the existing
planning/implementation/review loop against a strict fake GitHub CLI and an
installed fixture project. It validates and routes these transitions:

```text
factory:needs-plan
  -> plan result
  -> factory:ready
  -> start
  -> factory:working
  -> implementation success
  -> factory:review
  -> review approval
  -> factory:human-review
```

The same pilot covers implementation failure to `factory:investigate`, bounded
investigation retry, review change requests, review-round escalation,
decomposition into linked sub-issues, idempotent reruns, and automation sync.
The command completed with `ALL PASSED`.

This is a deterministic workflow pilot, not a claim of an external Cezar
account or GitHub PR run. Those live boundaries remain separately tracked in
the workplan.
