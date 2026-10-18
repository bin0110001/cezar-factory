<!-- factory-audit-2026-10-16:deploy-retry -->

Parent: #17. Related intake defect: #1. Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24.

## Objective and evidence

scripts/deploy/factory-autodeploy.sh advances the checkout before checking container parity and reconciling automations. A failure there leaves HEAD at stable. The next timer run sees changed=0 and exits before either failed operation, so recovery requires --force or another commit. The current parity check compares VERSION only, which cannot distinguish same-version source drift.

Source: local 767ac01, cross-checked against dev addbd38. This is a source finding, not proof of a live incident.

## Proposed implementation

Track last successfully reconciled SHA separately from checkout HEAD, retry incomplete parity/synchronization on unchanged SHA, and record success only after every configured target and runtime check passes. Include commit/content identity in runtime parity. Keep the existing lock and dirty/divergent refusal semantics.

## Dependencies

None: deployment retry/parity can be implemented and tested independently. Required by #29. See the completed implementation-plan comment; it supersedes the earlier #21 prerequisite.

## Acceptance criteria

- [ ] Inject a one-time reconciliation failure after checkout advancement; the next ordinary timer invocation retries and succeeds without --force.
- [ ] Container parity failure is retried until fixed and cannot write a successful receipt.
- [ ] A fully successful unchanged SHA follows an explicitly documented health/drift reconciliation policy.
- [ ] Dirty/divergent checkout and missing target config fail without overwriting state.
- [ ] Parity detects stale same-VERSION runtime content.

## Validation

Use a temporary Git remote and stub podman/sync commands to cover failure then retry, process interruption, concurrent lock, same-version drift, dirty and divergent trees. Validate shell syntax and run repository checks.

## Scope and gates

No host checkout edits, reset/clean/stash operations, or unapproved service rollout. Human plan approval is required.

Human plan approval is required before implementation. This proposed plan is not that approval.

Required reading: AGENTS.md, policies/definition-of-ready.md, policies/risk.yaml, the files cited above, docs/shared-factory.md and the audit report. Factory-managed changes must be committed, pushed, independently reviewed through a dev PR, released to every explicitly configured target, and verified before closure.




