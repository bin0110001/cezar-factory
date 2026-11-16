# Changelog

## [Unreleased]

- Acceptance-criteria verification ledger (#132): per-criterion verified/unverified/failed state bound to commit and policy revision, stale evidence invalidated on new commits, self-assessment never verifies, idempotent PR-description table. See `docs/acceptance-ledger.md`.

- Autodeploy parity now compares one Git-indexed managed-file manifest on host and container, excludes untracked/generated artifacts, and records the differing paths when a real mismatch blocks deployment (#561).

- Route the low-complexity jobs (intake, investigate, fix-review/changes-requested, maintenance) back to the local gateway model (`codex` / `factory-gateway/factory-code`, Qwen on the model host). Planning, review, implement and repair stay on Claude. The earlier temporary Claude routing (#321) is reverted for these four only.
- Coding-agent trust boundaries (#133): `docs/trust-boundaries.md` maps each untrusted input to its owning control (#104/#113/#101) and records residual risks (#166). The Python redactors now also remove bare GitHub/`sk-` tokens, `api_key`, and `Authorization` values, matching the PowerShell collector. Adversarial tests in `tests/test_factory_trust_boundaries.py`.

