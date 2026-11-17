# Historical risk intelligence (#660)

`cezar/packages/cezar/src/verification/risk-intelligence.ts` turns observed events and change history into explainable, project-scoped
risk evidence for files, modules and contracts. It is a library with no scheduler and no classifier of its own: an existing classifier, the
impact manifest or a scheduling policy consumes its output, and the output is a dry run by default.

**Inputs.** Events (regression, reopening, revert, remediation, verification failure, merge conflict, security finding, flaky), each with an
incident key, a confirmed flag, optional confirmed attribution and optional resolution time; change records (churn); contract definitions
with consumer fan-out; renames; the paths changed now; and a versioned policy.

**Observation is not attribution.** An incident is counted once however many times it is reported (100 reruns of one failure is one
incident). A confirmed single-file incident weighs fully; a multi-file or unconfirmed one is shared across its files and capped as a
hypothesis; a confirmed cause takes the weight and the other files get none. Confidence is `high` only with enough confirmed evidence.

**Dimensions.** Likelihood, impact, concurrency, security and verification difficulty, each bounded 0 to 1. Incident weight decays with a
half-life (default 90 days); a resolved incident decays further but never disappears; fewer than the minimum distinct incidents damps
history so one incident cannot make a file look risky. Churn feeds concurrency only, and concurrency never raises the overall level, so a
stable, frequently edited file is not penalised for churn. Impact comes from contract consumer fan-out, and a contract changed now raises
impact and concurrency regardless of failure history.

**Roll-ups and scope.** Files roll up to modules (path prefix) and to contracts; history follows renames; events, changes, contracts and
renames from another repository are ignored, and output is deterministic for fixed inputs (it carries a digest). Sensitivity (`low`,
`normal`, `high`) moves the level thresholds, not the evidence.

**Mandatory floors, not delegated to a model.** Authentication, authorization, secrets, release and migration paths are `high` whatever
their history. `enforceFloor` lets a classifier or model suggestion be raised by a floor, never lowered. `applyOverride` is audited
(actor, reason, before) and refuses to go below a floor. `minimumGuards` derives required guards (full regression, independent review,
security scan, consumer-compatibility check) from the evidence alone.

Not done here: collecting the events from the ledger, runs and integration history, and the persistence and UI that surface the evidence,
are the adopting steps; the contract for exposing it to the Change Impact Manifest is not defined by this change.
