# Native workflow dry-run simulator (#771)

The simulator is a deterministic, read-only preview for `cezar.workflow` v1 definitions. It accepts explicit scenario fixtures and uses the same closed-world guard and transition selector as the executor. A missing fixture produces `unknown`; waits remain `waiting` until a matching human, event, or time trigger is supplied. Repeated transitions are bounded by `maxSteps` and include a cycle witness.

Simulation never dispatches an agent, starts a child workflow, executes an action or verification suite, writes a run, or calls GitHub. Fork, join, and child-workflow nodes are interpreted from the supplied outcome fixture. A comparison reports definition digests by identity, reachability, permissions, required gates, budget, compatibility, terminal GitHub projection outcomes, and full definition. Active runs pinned to the compared definition are counted; migration is always `none` because a preview cannot change a running workflow's pin.

## CLI

Save the request below as `scenario.json`, then run `cezar workflow simulate scenario.json` from the directory containing the file. The request contains the complete graph, so this entry point works offline and does not edit the source definition.

```json
{
  "workflow": { "contract": "cezar.workflow", "schemaVersion": 1, "id": "example.flow", "version": "1.0.0", "entry": "start", "terminals": ["done"], "nodes": [{ "id": "start", "kind": "action", "action": "fixture", "outcomes": ["passed"] }, { "id": "done", "kind": "action", "action": "fixture", "outcomes": ["passed"] }], "transitions": [{ "from": "start", "outcome": "passed", "to": "done", "order": 0 }], "compatibility": { "mode": "versioned-only", "minConsumer": "1.0.0", "maxConsumer": "1.0.0" } },
  "scenarios": [{ "id": "happy-path", "outcomes": { "start": ["passed"] } }]
}
```

The read-only native workflow designer has a **Dry-run fixtures** panel. Its JSON contains a `scenarios` array; add `compareTo: { "id": "...", "version": "..." }` to compare against another catalog definition. Scenario entries accept `inputs`, per-node ordered `outcomes`, `waitTriggers`, and `maxSteps`.

## Scenario fields

- `outcomes` maps node IDs to explicit outcome sequences; successive visits consume successive values. No result is inferred for a worker, verifier, action, child, fork, or join.
- `waitTriggers` maps wait-node IDs to `{ "kind": "human" }`, `{ "kind": "event", "event": "name" }`, or `{ "kind": "time", "now": "ISO-8601" }`. Event names and time thresholds must match the definition.
- `inputs` supplies guard context. A missing guard value stays unknown, and an unknown earlier transition never falls through to later edges.
- `maxSteps` bounds intentional cycles (default 256, maximum 10,000). An exhausted fixture is reported as unknown; reaching the bound returns a cycle witness.

The simulator contract and runtime live in `cezar/packages/contract/src/workflow-simulation.ts` and `workflow-simulator.ts`. Focused cases are in `cezar/packages/cezar/test/unit/workflow-simulator.test.ts`.
