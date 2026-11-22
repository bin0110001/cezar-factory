# Workflow operator views

The Control Center exposes native workflow definitions at `GET /workflows/versioned` and a
sanitized execution view at `GET /runs/:id/workflow-view`. Both are read-only projections. They
do not change the workflow execution, verification, policy, or GitHub review records.

## Definition catalog

The catalog includes graph identity and digest, entry and terminal nodes, typed ports, outcomes,
guard descriptions, retry/timeout metadata, compatibility, budgets, and policy pins. Nested child
workflow references can be expanded when the pinned definition is present in the loaded catalog.
Configuration errors contain a basename and a redacted message. Prompts, input literals, and host
paths are omitted.

## Execution view

The task thread shows the current node progress, completed attempts and outcomes, attempt budget,
wait reason and responsible actor, stop reason, child runs, changed revision, and available review
evidence. Finding paths must be safe relative paths. Finding text is secret-redacted; host paths,
raw tool output, and arbitrary attempt output fields are not returned. When a versioned execution
view cannot be refreshed, the thread keeps its ordinary activity view and labels cached evidence
as stale when available.

The projection may show the Factory workflow outcome and the GitHub approval distinction, but it
does not claim a GitHub approval or substitute workflow outcomes for a human review. Existing
task-thread controls and audited server routes own operator mutations.

## Compatibility

These endpoints and UI views are additive. They do not alter the versioned workflow definition or
execution schemas, YAML workflow behavior, existing runner, or persisted records. The output
contracts live in `@open-mercato/cezar-contract` so the server and web client share the same view
shape.
