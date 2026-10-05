# OpenHands execution boundary

The clean launch boundary is a provider request from Cezar to an OpenHands
Agent Server on Bazzite. Agent Canvas remains the operator-facing control and
inspection surface; it is not mirrored into Cezar.

## Request

Cezar sends the issue number, repository, approved task text, selected agent,
risk classification, validation command, and desired branch name. The provider
creates an isolated worktree and returns a provider job identifier.

## Completion

OpenHands owns the coding session, tool trace, worktree, branch, and PR update.
It returns a compact result containing status, branch, PR URL, changed files,
validation status, attempts, duration, model, coarse usage when available, and
failure artifacts. Cezar writes only the
workflow decision record and advances the GitHub lifecycle label.

## Recovery

Provider failures are retried within the Factory retry policy. A second failure
returns structured evidence to `factory-investigate`; it does not create an
unbounded agent loop. A failed or abandoned worktree remains provider-owned and
is cleaned up by the Agent Server policy.

The Bazzite deployment template supplies the Agent Server URL through
`OPENHANDS_AGENT_SERVER_URL`; credentials and repository tokens remain
host-local.

## Checked-in provider adapter

`scripts/openhands/run-job.py` is the bounded provider adapter used by Cezar
automation. It accepts a validated JSON request, creates an OpenHands
conversation with `worktree=true` and a finite `max_iterations`, polls the
conversation to completion, and reads the event search endpoint before
returning a compact result. A job succeeds only when the conversation finishes
and every requested validation command has a successful terminal observation.
Transient or validation failures are retried only up to `--max-attempts` (two
by default). Each attempt gets a new provider conversation, and a final
failure reports every conversation ID and terminal status as failure evidence.

The adapter does not persist provider credentials in its result. Pull-request
creation, premium subscription authentication, and GitHub lifecycle updates
remain separate responsibilities until those capabilities are connected.

For a saved OpenHands Agent Profile, pass `--agent-profile-id` or set
`OPENHANDS_AGENT_PROFILE_ID`. The adapter then sends only the profile UUID;
OpenHands resolves subscription authentication, MCP servers, and model settings
server-side, without a premium provider API key crossing the Cezar boundary.
For bounded local-model jobs, use the Bazzite LiteLLM gateway as the adapter's
local-model endpoint; that gateway is configured to reach the authenticated Mac
mini vLLM proxy at `192.168.86.60:8000`.
