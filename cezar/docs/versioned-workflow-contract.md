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
Session ownership is explicit: `inherit` reuses the parent's session, `new`
allocates a child-owned session, and `none` forbids agent-session use. A wait
node carries a stable reason so a parked run can explain what event it awaits.
Compensation names a registered action to invoke after failure; it does not
undo external effects unless that action explicitly does so.

Fork fanout is capped at 32. `all` waits for all children; `any` accepts the
first successful terminal child; `quorum` accepts the configured number of
successful children. For `any` and `quorum`, remaining children are cancelled
once the result is decided; children are also cancelled when success becomes
impossible. Cancellation is cooperative, and the parent remains responsible
for joining child terminal records before its own terminal result. Child
failures are retained as structured results rather than collapsed into a
single boolean.

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
