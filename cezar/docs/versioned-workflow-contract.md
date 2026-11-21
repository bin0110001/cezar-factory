# Versioned workflow contract (v1)

The shared typed contract is `cezar/packages/contract/src/versioned-workflows.ts` in
the Cezar checkout. It is additive to `workflowDefSchema`: existing `.ai/cezar/workflows/*.yaml`
files continue to load as ordered steps and keep their existing retry behavior.
The new graph shape is declarative; it does not create a second executor or
policy store. Runtime adoption is a separate step.

## Identity and pinning

Each definition has a stable lowercase `id`, a semantic `version`, and
`schemaVersion: 1`. A run that adopts this contract records the validated
definition plus its SHA-256 digest of canonical JSON (object keys sorted,
array order preserved) and the exact policy references (`id`, `version`,
digest). The producer declares required `capabilities`; a consumer must support
the schema version and every required capability before accepting a run. The
compatibility range is inclusive. Major changes that alter interpretation
require a new major definition version; minor additions must be optional;
patch changes cannot change valid execution semantics.

The current ordered-step executor persists an immutable `legacy` definition pin in
the initial run record write. It hashes the effective definition (including inherited
Factory release provenance), rejects updates to the definition or pin, and checks the
definition digest and exact inherited release policy pins before restart recovery. A mismatch
fails the run and reports it to the parent. Versioned graph runs use this same run record
and event history, and the HTTP start path accepts an exact `id@version` plus typed inputs.
A legacy pin is never presented as a versioned graph pin.

Versioned definitions use `*.workflow.json` files alongside legacy YAML in
`.ai/cezar/workflows/` and shared workflow directories. The loader indexes each
exact `id@version`; the repository catalog shadows a shared definition with the
same identity, and invalid files are reported without hiding valid entries.

## Graph and outcomes

Nodes have stable IDs, explicit typed ports, a supported `kind`, and named
outcomes. Transitions name source, outcome, target, and explicit order. The
runtime evaluates them in ascending order; the first guard evaluating true
wins. A guard that evaluates unknown fails closed with workflow outcome
`unknown`; arbitrary executable expressions are not part of the contract.
The closed outcome set is `passed`, `changes_required`, `needs_input`,
`investigate`, `blocked`, `skipped`, `unknown`, `interrupted`, and `exhausted`.
These are workflow results; run status and finding disposition remain separate
fields and are mapped by the runtime adapter.

Every nonterminal node outcome has a transition. Terminal nodes have no outgoing
transitions. References to nodes, child nodes, and guard outcome sources must
resolve. Runtime implementations reject capabilities they do not advertise.

## Resource, budget, child, and parallel semantics

Node timeout and retry bounds cannot expand the parent workflow's budget. A
child workflow inherits the parent's remaining attempts, time, and token budget
unless a smaller child budget is declared; it cannot mint a new parent budget.
Session ownership is explicit: `continue` reuses the named owning run's session,
`new` allocates a child-owned session, `none` forbids agent-session use, and
`external` requires the `session.external` capability. `inherit` remains a
compatibility alias for `continue`. A wait node carries a stable reason so a
parked run can explain what event it awaits.
Compensation names a registered action to invoke after failure; it does not
undo external effects unless that action explicitly does so.

Fork fanout is capped at 32 and is explicitly sealed when its final child is
registered. `all` waits for all children; `any` accepts the first successful
terminal child after the fanout is sealed; `quorum` accepts the configured
number of successful children after the fanout is sealed. For `any` and
`quorum`, remaining children are cancelled once the result is decided; children
are also cancelled when success becomes impossible. Cancellation is cooperative,
and the parent remains responsible
for joining child terminal records before its own terminal result. Child
failures are retained as structured results rather than collapsed into a
single boolean.

Dispatch reports may carry the closed typed workflow `outcome` in addition to
legacy run status. Parent join evaluation accepts only a `done` child with no
adverse report and, when supplied, `outcome: passed`. The shared transition
selector evaluates edges by explicit order; an unknown guard returns an
`unknown` result instead of falling through to another edge.

The contract package exposes graph snapshot, claim, completion, and wait-resume transitions.
They validate declared input/output ports, preserve outcomes and outputs on the run, derive stable
transition IDs, bound retries, and make identical completion replays idempotent. The existing
RunManager drives agent, fork/join, nested-workflow, and human/event/time wait nodes through the
existing RunStore and dispatch child records. It restores active attempts, child links, waits, and
timeouts after restart; dispatch transition IDs prevent a replay from opening duplicate child runs.
Graph-wide duration and per-node timeout budgets are enforced from persisted deadlines. Provider
token usage is summed once from the existing terminal child-run records; an over-limit total or
missing usage evidence fails the graph. This detects concurrent overrun before the graph can pass,
but does not reserve or interrupt provider tokens mid-turn. Review nodes dispatch in a distinct
session with only `Read`, `Grep`, and `Glob` tools on the Claude and
Pi runners; other runners fail closed for review nodes because they do not enforce that allowlist.
Event deliveries use `POST /api/v1/runs/:id/events` with a stable event ID; the run record stores
the receipt and replays with the same ID are no-ops. Action nodes require an injected registered
adapter with both `execute` and `reconcile`: the coordinator persists a stable idempotency key
before execution, stores the adapter's exact structured receipt, and reconciles a pending effect
after restart before retrying it. Unknown, cancelled, timed-out, and untyped child results cannot
produce a passing terminal run.

The shared server does not yet register built-in GitHub action adapters, so action definitions fail
closed there until the host supplies one. The runtime also fails closed for `validator` and
`policy_gate` nodes because adapters for those node kinds are not yet available. It persists policy
pins but does not yet resolve arbitrary workflow `policyRefs` from a policy catalog. These nodes
must not be used as if they were executed until their adapters and policy resolution are implemented.

## Compatibility

Legacy YAML maps to the existing ordered step adapter, preserving `steps`,
`skills` shorthand, retries, and all current defaults. Legacy definitions are
not rewritten or assigned fabricated graph versions. New-format definitions
must be validated and pinned before execution. Mixed-version producers and
consumers negotiate the declared schema and capability set before any run is
created; unsupported input is rejected rather than silently downgraded.

## Contract fixtures

`cezar/packages/cezar/src/workflows/versioned-contract.test.ts` contains four representative
contract fixtures: issue delivery through a registered action, investigation
through an agent, review through a policy gate, and repair through a validator.
The test suite also covers missing outcomes, invalid node references, unknown
capabilities, invalid quorum, executable guard rejection, deterministic
canonicalization, unknown guard results, and legacy adapter compatibility.
