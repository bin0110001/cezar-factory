# Coding run trace context

Cezar uses W3C Trace Context (`traceparent`) to correlate a workflow run and its agent, command, and verification attempts. The run trace ID is a stable SHA-256 derivation from the opaque Cezar run ID, or from the registered Factory execution ID for Factory-managed work. Each step attempt gets its own child span ID. Dispatch-tree runs share their root run identity. Invalid or unsupported incoming context is ignored and a new trace is started.

The Cezar server passes `TRACEPARENT`, `CEZ_TRACE_ID`, `CEZ_RUN_ID`, and `CEZ_ATTEMPT_ID` to agent and command processes. These values identify work only; Langfuse credentials stay in the Cezar host process. Context flags are unsampled by default. Setting `CEZ_OTEL_SAMPLE=1` opts the host into sampled context; configuring the host-local Langfuse OTLP sink also enables the durable coarse workflow span outbox.

Workflow spans are recorded after an agent, command, or verification attempt settles. The Langfuse exporter accepts only an explicit attribute allowlist: workflow and step IDs, opaque run/attempt IDs, project/issue IDs, agent/model identities, outcome, error code, and retry count. Prompt text, source files, command lines, output, exception messages, and credentials are excluded. The full coding-run ledger remains the authoritative audit history; telemetry is optional and never gates workflow success. Telemetry delivery failures remain in the local outbox for bounded retry.

The existing routing-event contract (#94) remains the source for quota, fallback, and routing semantics. Subscription CLI token counts and hidden internal calls are `unknown` unless the provider exposes them. No token estimates are written to spans.

The Langfuse v4 OTLP/HTTP endpoint and credentials are configured on the host as described in [the Langfuse integration contract](../integrations/langfuse/README.md). Langfuse owns telemetry sampling and retention. Coding-run audit retention is independent and permanent.
