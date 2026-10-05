# Local-model shadow evaluation

Use `scripts/record-local-evaluation.ps1` to append compact, prompt-free shadow records. The record contains task class, difficulty and risk, bounded context size, worker/model, schema and deterministic-validation results, corrections, retries, duration, token estimate, premium fallback, and human outcome.

`scripts/evaluate-local-promotion.ps1` reads the ledger and compares it with the task class's predeclared catalog gate. Its output is evidence only: an eligible result never changes routing or grants lifecycle, risk, security, persistence, or merge authority. Promotion remains a reviewed catalog-policy change.

The ledger and reports live under `.factory/evaluations/` and are excluded from version control. Do not store prompts, source, raw logs, or credentials there.
