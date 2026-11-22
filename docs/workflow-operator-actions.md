# Workflow operator actions

Native workflow controls are exposed through the run-scoped operator action API. The server accepts only `resume`, `reconcile`, `cancel`, `escalate`, and `approve`; it resolves the run from the selected project and applies actions through that project's `RunManager` and `RunStore`.

## Identity and authorization

These controls require the local operator surface (`localHandoff`). The caller cannot submit an actor or role. The server derives the actor from the operating-system account running Cezar and grants that local operator `operator` and `admin` roles. `resume`, `reconcile`, `cancel`, and `escalate` require `operator`; approval of a human workflow gate requires `admin`. Hosted mode has no project user identity in the current server contract and therefore refuses these controls.

This is a single-host trust boundary, not per-user authentication for a remotely shared cockpit. A future multi-user deployment must provide a verified project principal and role mapping before enabling the endpoint there.

## Durability and replay

Actions are journaled in `<project>/.ai/cezar/workflow-actions.ndjson` as write-ahead `started` records followed by `completed` or `failed` records. Permission denials and stale/invalid targets are recorded as `denied` or `rejected`. The run snapshot is a SHA-256 of the current status, workflow execution, and step state; the API rejects stale snapshots. Idempotency keys are scoped to a run and actor/action/version tuple. Completed keys return the stored outcome. An action left unfinished after interruption is not executed a second time; the operator must reconcile the run and issue a fresh action.

Escalation rationale is required as an intent check but is not persisted because free text can contain credentials or host paths. The durable event records only the escalation action and actor. Approval remains distinct from GitHub approval and resumes only a workflow waiting at a human gate.
