# Factory skills, workflows and error handling audit

Audit date: 2026-10-16. Tracking issue:
[#17](https://github.com/bin0110001/cezar-factory/issues/17).

The source suite passes, but negative probes demonstrate that a passing suite
does not establish trustworthy project validation or a safe release handoff.
Structural fixes are decomposed below. This change corrects the workflow map's
outdated risk-based merge guidance and records the implementation plan.

## Scope and evidence

Inspected Factory skills, workflow commands, result schemas/validators, routing,
failure collection, release/promotion, deployment reconciliation and existing
test coverage. Source baseline: local `767ac01` (Factory `0.3.44`), cross-checked
against freshly fetched `dev` at `addbd38`. The local validation-failure routing
commit and uncommitted maintenance/backlog changes were preserved. The audit
documentation branch starts at `addbd38` and contains none of those edits.

GitHub inspection confirmed auto-merge disabled and a 404 from the `dev` branch
protection endpoint on the audit date. These are current configuration findings,
not authorization to change repository settings. No live Bazzite/Cezar run was
restarted and runtime parity was not established by this audit.

## Findings and implementation boundaries

| Priority | Finding | Evidence | Work item |
| --- | --- | --- | --- |
| P1 | Project validation can report success without testing; shared artifacts collide | `scripts/factory/test-full.ps1`, `test-changed.ps1`: heuristic source execution, shared `scripts/artifacts/*-results.json`, outer catch does not guarantee failed exit | [#19](https://github.com/bin0110001/cezar-factory/issues/19) |
| P1 | Results and merge routing lack authoritative current-PR gates | `scripts/validate-result.ps1` accepts contradictory success; `scripts/route-state.ps1` sends supplied PR directly to auto-merge, without current head/base/check/review verification | [#20](https://github.com/bin0110001/cezar-factory/issues/20) |
| P1 | Release instructions and promotion do not enforce reviewed merged dev ancestry | Release skill omits merge prerequisite and has a broken promotion path; finish skill orders release before PR handoff; promotion accepts clean arbitrary HEAD and a replacement `-TestScript` | [#21](https://github.com/bin0110001/cezar-factory/issues/21) |
| P1 | Failed post-checkout reconciliation is skipped on the next timer tick | `scripts/deploy/factory-autodeploy.sh` advances HEAD before parity/sync; unchanged HEAD exits before retrying failed operations | [#18](https://github.com/bin0110001/cezar-factory/issues/18) |
| P2 | Failure collection can lose evidence, duplicate issues and exceed claimed bounds | `scripts/audit-factory-failures.ps1`: evidence initialized inside only one creation branch, lookup exit codes unchecked, two-issue behavior conflicts with skill, full API/handoff reads precede filtering | [#22](https://github.com/bin0110001/cezar-factory/issues/22) |
| P2 | Static checks do not validate complete skill/workflow contracts | Missing required fields in fix/review examples; incomplete startup script manifests; planning comment ownership conflicts; tests mostly inspect headings and line patterns | [#23](https://github.com/bin0110001/cezar-factory/issues/23) |

Existing [intake defect #1](https://github.com/bin0110001/cezar-factory/issues/1)
has blank affected-project/recovery fields and no run evidence in its body.
Its [historical evidence comment](https://github.com/bin0110001/cezar-factory/issues/1#issuecomment-6020442037)
does identify two failed runs, affected project issue #371 and schema errors.
The incomplete body is consistent with the collector's deduplication path;
this audit does not independently establish the intake defect's current status.
It remains open and is cross-referenced to collector work.

## Verification

- The full local `tests/run-tests.ps1` suite finished with `ALL PASSED` and
  exit 0. It ran against the initial working tree, including the pre-existing
  maintenance edits; it is not a test result for deployed infrastructure.
- Automation catalog validation passed (10 jobs). Release metadata validation
  passed for `0.3.44` with tests skipped only in that metadata invocation; the
  full suite was run separately.
- A copy of the full-test wrapper, invoked in an empty isolated project,
  produced `status: passed`, `total: 0`, and exit 0. Its result was written
  relative to the copied runtime, confirming artifact ownership.
- An implementation result with `status: success`, `testResult: failed`,
  `acceptanceCriteriaStatus: Not met`, and `knownConcerns: Unresolved blocker`
  was accepted as `valid` with exit 0. No GitHub mutation was involved in
  either negative probe.
- The relevant implementation files were compared with fetched `dev`;
  the local validation-failure routing additions do not repair these semantic
  validation gaps.

Local evidence is retained under `.factory/audit-2026-10-16/`; generated logs,
probe fixtures and issue-publication receipts are not committed as source.
The issue bodies preserve reproducible cases and required regression tests.

## Delivery order and completion

```text
#19 explicit project validation -> #20 verified merge gates
                              -> #21 reviewed-SHA release
                              -> #18 resumable reconciliation
#22 bounded evidence collector: independent
#23 skill/workflow contract checks: independent
```

Each child is scoped to one reviewable implementation and contains acceptance
criteria, validation, non-goals, dependencies and required reading. All children
enter planning, rather than being represented as implementation-ready.
High-risk merge/release/deployment plans require human approval under
`policies/risk.yaml`; this audit does not grant that approval.

The parent uses a tracking classification and native GitHub sub-issues. Child
bodies link to the parent, prerequisites and dependents; #1 links back to the
audit and collector repair. Completion requires independent review, a validated
`dev` PR, the required release to every explicitly configured target, and
runtime parity evidence. Missing repository gates, target configuration or
dirty/mismatched host state must remain visible blockers.

No Factory-managed runtime asset is changed by this documentation PR. Runtime
remediation and release are tracked in the children, so this audit must not be
reported as deployment or resolution of the operational defects.
