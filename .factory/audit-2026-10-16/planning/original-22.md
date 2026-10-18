<!-- factory-audit-2026-10-16:collector -->

Parent: #17. Related intake defect: #1. Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24.

## Objective and evidence

scripts/audit-factory-failures.ps1 creates project and Factory issues although factory-failure-audit skill promises at most one. $evidenceText is assigned only when creating a new project issue; a deduplicated project issue can leave the Factory issue without evidence. Existing issue #1 has blank affected-project/recovery fields and no run evidence in its body; historical comments do contain two failed run IDs, affected project issue #371 and validation errors (https://github.com/bin0110001/cezar-factory/issues/1#issuecomment-6020442037). gh lookup failures are treated as no matches without checking LASTEXITCODE. /runs responses and handoff text are read before applying any bound; the limited status does not reflect all limitations.

Source: local 767ac01, cross-checked against dev addbd38. This is a source finding, not proof of a live incident.

## Proposed implementation

Build a compact, redacted evidence object before any write; use explicit registry/API project identity rather than guessing from a folder name; bound source reads/pagination, time window and output size. Use one canonical Factory issue per registered project and normalized signature, with qualified links to existing project references, and use stable fingerprints plus qualified URLs. Fail closed on lookup/auth failures and preserve available evidence on partial writes. Separate recovery side effects from read-only collection.

## Dependencies

Decomposed: #30 bounded collection precedes #31 canonical publication. Existing intake defect #1 remains separate. See the completed decomposition plan.

## Acceptance criteria

- [ ] New-project, existing-project and same-repository cases all preserve run/step/command evidence with full cross-repository links.
- [ ] A failed lookup creates no speculative duplicate; repeated audit runs deduplicate by stable fingerprint.
- [ ] Large handoffs/API histories obey declared read/output bounds and report truncation/time-window limitations.
- [ ] Ambiguous or partial canonical publication has an actionable receipt and can retry idempotently without creating a second project issue.
- [ ] The skill, workflow switches and collector agree on read/write and issue-count behavior; existing #1 is linked for triage without inventing evidence.

## Validation

Add fake-gh and fake-Cezar fixtures covering authentication failure, exact dedupe, existing project issue/new Factory issue, same repository, oversized evidence, missing runs and partial publication. Run the full suite.

## Scope and gates

Do not close or claim to fix existing intake issue #1, broaden filesystem discovery, or restart production workflows during tests.

Plan before execution; independent review and validated release are required.

Required reading: AGENTS.md, policies/definition-of-ready.md, policies/risk.yaml, the files cited above, docs/shared-factory.md and the audit report. Factory-managed changes must be committed, pushed, independently reviewed through a dev PR, released to every explicitly configured target, and verified before closure.





