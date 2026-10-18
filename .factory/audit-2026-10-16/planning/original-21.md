<!-- factory-audit-2026-10-16:release -->

Parent: #17. Related intake defect: #1. Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24.

## Objective and evidence

skills/factory-release/SKILL.md shared procedure omits merge-to-dev and contains a broken scripts/release path. skills/factory-finish-release/SKILL.md places promotion/synchronization before its reviewed PR step. scripts/release/promote-stable.ps1 promotes arbitrary clean HEAD and exposes a public -TestScript replacement despite claiming no test bypass; tests/run-tests.ps1 uses that hook. It does not verify HEAD belongs to reviewed merged dev history.

Source: local 767ac01, cross-checked against dev addbd38. This is a source finding, not proof of a live incident.

## Proposed implementation

Define one lifecycle: validate source -> reviewed dev PR -> observed merge -> resolve exact merged SHA -> full mandatory suite on that immutable tree -> stable promotion -> target synchronization -> runtime parity receipts. Keep test seams outside the production CLI, distinguish initial stable creation from fetch failures, and make shared/legacy target behavior explicit. Put operational scripts in workflow command steps and keep skills as artifact/gate guidance.

## Dependencies

Decomposed: #28 depends on #27; #29 depends on #28 and #18. #18 is independent of this tracking parent. See the completed decomposition plan.

## Acceptance criteria

- [ ] Unmerged feature commits and an unreviewed/mismatched SHA cannot advance stable.
- [ ] The production entry point cannot replace/skip the mandatory full suite.
- [ ] Authentication/network failures fetching stable fail closed rather than being treated as a missing ref.
- [ ] Release and finish-release skills agree with AGENTS.md and docs/shared-factory.md, including command ownership.
- [ ] Each explicit target gets a receipt for the same reviewed source SHA; absent registry or parity mismatch stops safely.

## Validation

Test with temporary bare remotes: unmerged HEAD, failed suite, fetch error, absent stable, divergent stable, reviewed merged SHA, missing targets and parity mismatch. No external target writes in tests.

## Scope and gates

Do not alter host files by hand, invent targets, or implement infrastructure deployment beyond the supported flow. Human plan approval is required.

Human plan approval is required before implementation. This proposed plan is not that approval.

Required reading: AGENTS.md, policies/definition-of-ready.md, policies/risk.yaml, the files cited above, docs/shared-factory.md and the audit report. Factory-managed changes must be committed, pushed, independently reviewed through a dev PR, released to every explicitly configured target, and verified before closure.




