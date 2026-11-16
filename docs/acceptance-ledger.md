# Acceptance-criteria verification ledger

`scripts/acceptance-ledger.ps1` (dot-source; schema `schemas/acceptance-ledger.schema.json`) maps each
issue acceptance criterion to deterministic evidence and an explicit `verified` / `unverified` /
`failed` state (#132, parent #125).

- **Criteria** come from the issue's "Acceptance" section (`ConvertFrom-AcceptanceCriteria`), with
  stable ids `AC-<8 hex of sha256(normalised text)>`. Unparseable criteria are not dropped; no
  section means no criteria.
- **Evidence** (`New-AcceptanceEvidence`) has a kind (`test`, `file`, `commit`, `artifact`,
  `human-review` with a reviewer, `baseline`, `finding`, `self-assessment`), a reference, a result and
  the commit and policy revision it was recorded for.
- **States** (`Update-AcceptanceLedger`): evidence for another commit or policy revision is stale and
  ignored; any live `fail` makes the criterion `failed`; a live `pass` verifies it; anything else —
  including no evidence, skipped or inconclusive results, and `self-assessment` — is `unverified`.
  A new commit therefore reverts criteria to `unverified` until re-checked.
- **Reuse**: `ConvertFrom-BaselineComparison` adapts baseline comparison pages from
  `Invoke-VerificationQuery` (#99–#101) and `ConvertFrom-FindingsSummary` adapts concise findings (#103).
- **PR description**: `ConvertTo-AcceptanceMarkdown` renders the per-criterion table (with the GitHub
  review decision, when supplied); `Update-AcceptancePrBody` replaces the section between
  `<!-- factory-acceptance-ledger:begin/end -->` markers, so repeated updates are idempotent.

No GitHub Actions or hosted checks are used; evidence comes from local receipts. Merge-eligibility does
not read the ledger yet (follow-up). Tests: `tests/acceptance-ledger.ps1`.
