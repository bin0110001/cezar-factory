# Langfuse integration contract

Langfuse runs on Bazzite using the official self-hosted Compose stack. LiteLLM
is the first instrumentation boundary for local-model traffic. For Langfuse v4,
use LiteLLM's `langfuse_otel` callback and query the v2 Observations API; the
legacy `langfuse` callback is incompatible with the default `events_only` mode.
The deployment health check is `scripts/deploy/validate-langfuse.sh`.

Each request should carry these metadata fields when they are available:

- `project`;
- `workflow`;
- `github_issue`;
- `worker`;
- `provider`;
- `model`.

Subscription-agent token counts may be unavailable, so those executions record
coarse duration, attempts, changed-file count, and validation status instead.
Langfuse credentials remain host-local.
