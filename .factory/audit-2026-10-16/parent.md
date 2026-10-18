<!-- factory-audit-2026-10-16:parent -->
Audit Factory skills, workflow contracts, validation, failure reporting and release reliability.

Source inspected: local 767ac01 and refreshed dev addbd38. The local full Factory suite passed, but targeted negative probes found false-positive validation. This is a tracking issue, not implementation authorization for high-risk changes.

Delivery plan: independent validation, collector and contract work first; verified merge gates follow validation; reviewed-SHA release follows merge gates; deployment reconciliation follows release. Each child will include concrete evidence, acceptance criteria, validation, non-goals and dependencies. High-risk children require human plan approval under policies/risk.yaml.

Existing intake defect: #1. Its body lacks run evidence, but historical comments identify two failed runs, affected project issue #371 and schema errors (https://github.com/bin0110001/cezar-factory/issues/1#issuecomment-6020442037). Collector repair must preserve and improve those cross-references without claiming the defect resolved.

Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24 (dev, commit 7708c1e; independent review approved). Auto-merge handoff is blocked because repository auto-merge is disabled and dev has no protection rule. This audit does not establish live Bazzite/Cezar parity.

Completion: all children independently reviewed and validated; runtime changes released to every explicitly configured target via the corrected release procedure; runtime parity and issue links verified. Do not close on source-only fixes.


## Decomposed work

- [ ] #19 - Replace heuristic test execution with explicit project validation adapters; depends on: None; can be planned independently. / Required by: #20
- [ ] #20 - Verify semantic results and current PR gates before requesting auto-merge; depends on: #19 / Required by: #21
- [ ] #21 - Make Factory release follow a reviewed merged-SHA state machine; depends on: #20 / Required by: #18
- [ ] #18 - Retry incomplete Factory reconciliation when the deployed SHA is unchanged; depends on: #21
- [ ] #22 - Make failure-audit evidence bounded, deduplicated and reciprocally linked; depends on: None; can be planned independently.
- [ ] #23 - Validate workflow command contracts and executable skill examples; depends on: None; can be planned independently.


