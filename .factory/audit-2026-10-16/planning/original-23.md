<!-- factory-audit-2026-10-16:contracts -->

Parent: #17. Related intake defect: #1. Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24.

## Objective and evidence

tests/run-tests.ps1 checks workflow shape with line regexes, skill existence/headings, and command-ownership phrases; it does not validate complete command contracts. plan/investigate startup RequiredScripts omit downstream validators/routers; intake omits downstream scripts. factory-fix JSON omits required issue and documentationUpdated; factory-review JSON omits required issue. factory-plan still instructs posting a comment although workflow routing owns it. factory-implement command discipline also says to invoke Factory scripts, contradicting its later prohibition and AGENTS.md. docs/workflow-map.md describes a superseded risk-based human merge path.

Source: local 767ac01, cross-checked against dev addbd38. This is a source finding, not proof of a live incident.

## Proposed implementation

Parse workflows with the same contract as the bundled Cezar runtime, validate skill references/retry targets/parameters and startup dependency coverage, and check copyable JSON examples against schemas. Separate schema-valid concrete examples from descriptive alternatives. Align skill responsibilities with workflow-owned routing and prepared artifacts; add negative mutations proving the checker catches drift. Cover all workflows, including scheduled and upgrade workflows.

## Dependencies

Decomposed: #32 focused contract repairs precedes #33 executable contract enforcement. Merged PR #24 already repaired the workflow-map text.

## Acceptance criteria

- [ ] Missing command script, unknown parameter, missing skill, invalid retry edge and incomplete startup dependency manifest fail checks with file/step diagnostics.
- [ ] Concrete skill examples validate against their result schemas; required issue/documentation fields are present.
- [ ] Skills cannot instruct duplicate issue discovery, routing/comments, or execution of workflow-owned scripts.
- [ ] A negative fixture for each contract class fails for the intended reason on Windows/Linux.
- [ ] Preserve the existing in-progress maintenance/backlog edits; reconcile rather than overwrite them.

## Validation

Run schema/contract checks against the real workflow inventory and deliberately mutated fixtures, followed by the full suite. Avoid relying only on source-string presence assertions.

## Scope and gates

Do not replace Cezar's engine, change model routing, or fold unrelated skill rewrites into this PR.

Plan before execution; independent review and validated release are required.

Required reading: AGENTS.md, policies/definition-of-ready.md, policies/risk.yaml, the files cited above, docs/shared-factory.md and the audit report. Factory-managed changes must be committed, pushed, independently reviewed through a dev PR, released to every explicitly configured target, and verified before closure.





