# Historical: OpenHands Agent Canvas live evidence

This is historical evidence from a retired execution path. OpenHands is not
part of the active Factory deployment; current automation execution belongs to
Cezar. Do not interpret this document as proof that the OpenHands service is
required or currently enabled.

Verified on 2026-10-02 against the Bazzite Podman host.

- Container: `cezar-factory-openhands`
- Image: `ghcr.io/openhands/agent-canvas:1.24.0` (upgraded and revalidated on
  2026-10-03; the original 1.22.0 deployment is retained in the historical
  checks below)
- Binding: trusted-LAN Bazzite `0.0.0.0:3001` → container port `8000`
- Persistent volumes: `cezar-factory-openhands-data` and
  `cezar-factory-openhands-projects`

Checks performed inside the container after startup:

| Endpoint | Result |
| --- | --- |
| `/health` | HTTP 200 |
| `/ready` | HTTP 200 |
| `/alive` | HTTP 200 |
| `/openapi.json` | HTTP 200 |
| `/canvas/` | HTTP 200 |

The persisted Agent Canvas API-key and secret-key file hashes were identical
before and after a container restart, and `/ready` returned successfully after
the restart. Secret contents are not recorded here.

The protected `/api/conversations` route returned HTTP 401 without the session
header and HTTP 422 with the persisted session header (the latter indicates
authentication passed but the request lacked the route's required context).

This proves Agent Canvas startup, local reachability, frontend/API serving, and
credential persistence. It does not prove Codex/Claude authentication,
isolated worktrees, PR lifecycle, or a completed GitHub issue.

## 2026-10-03 configured-profile connectivity check

The active Agent Profile was queried without exposing secrets. It reported the
`gpt-5.6-luna` model and the GitHub MCP server enabled with a masked API-key
credential. A bounded read-only conversation was then started with that
profile, asking it to read repository metadata and open issues without changing
files or GitHub state.

The conversation reached `error` before the GitHub MCP call because the active
LLM profile had no usable credential: OpenHands emitted
`LLMAuthenticationError` with an upstream OpenAI `invalid_api_key` response for
a missing key. This is a reproducible authentication failure, not evidence of
successful Codex/ChatGPT subscription access. The GitHub MCP configuration is
present but remains unverified at tool-call time until the LLM connection is
fixed. LAN access remains intentionally enabled for configuration.

The checked-in adapter now supports the profile-only path with
`--agent-profile-id`/`OPENHANDS_AGENT_PROFILE_ID`, so a saved ChatGPT
subscription profile can be used without passing a premium API key through
Cezar. The local-model path remains separate and uses the Bazzite LiteLLM
gateway; its live Mac mini vLLM route returned HTTP 401 without the stored
gateway credential and HTTP 200 with it on 2026-10-03.

## 2026-10-03 Agent Canvas upgrade and subscription retest

The live container was upgraded from `ghcr.io/openhands/agent-canvas:1.22.0`
to `1.24.0`. The `health` endpoint returned HTTP 200 after the replacement,
the LAN binding remained `0.0.0.0:3001`, and both named OpenHands volumes were
present. The saved `Luna` profile remained active with
`auth_type=subscription`, `subscription_vendor=openai`, and no API key.

A second bounded, read-only terminal/GitHub-MCP smoke test using that profile
still stopped before tool execution with `LLMAuthenticationError`. The error
changed to the runtime's generic invalid/expired credential message, so the
remaining failure is in subscription transport/agent selection rather than
profile persistence or container deployment. Premium checklist items remain
open until a conversation reaches the LLM and GitHub MCP.

The deployed 1.24.0 image includes both `codex-acp` and
`claude-agent-acp`, but the saved `Luna` profile is currently typed as an
`openhands` profile rather than an ACP profile. This leaves ACP as a viable
next integration path, but it has not been enabled or authenticated here.
The workstation's GitHub CLI credential also currently reports HTTP 401, so
real issue/PR lifecycle execution remains unverified.

The latest host-local readiness check reports
`active-profile=default:openhands` with the `gpt-5.6-luna` model reference;
this is consistent with a stored Luna model setting, but it is not evidence
of an authenticated ACP launch profile.

## 2026-10-03 Mac mini local-model smoke test

To avoid consuming subscription tokens during stabilization, a bounded
read-only conversation was run with the OpenAI-compatible local model
`openai/qwen3.5-9b` at the authenticated Mac mini vLLM gateway
(`192.168.86.60:8000`). The model list endpoint returned HTTP 200 and exposed
`qwen3.5-9b`; the request was accepted by OpenHands after using the required
`openai/` provider prefix.

Conversation `1831382b-04c5-40cc-8e94-007511499840` reached `finished` and
reported `/projects/cezar-factory` with a clean Git status. No files, commits,
or GitHub state changed, and no premium/subscription credential was used.
This is the preferred test path while the subscription transport remains under
investigation.

The checked-in `scripts/openhands/run-job.py` adapter was then run against the
same Mac mini model with environment-only credentials. After seeding the
verified-empty persistent project directory with the repository's tracked HEAD
so it had a valid `main`/`HEAD`, the adapter created an isolated worktree and
returned `status: success` with `validationPassed: true` on issue fixture 9001.
The first attempt correctly failed closed when the workspace had no valid
`HEAD`; no worktree isolation was disabled to hide that deployment defect.

The checked-in `scripts/deploy/validate-openhands-workspace.sh` now guards this
deployment boundary. Its live Bazzite check returned the seeded `HEAD`
`bb9c351c25212039ad6402917b5740a5c18db099` and a clean base workspace before
the successful adapter run.

The adapter's observability fields were also exercised live against the Mac
mini model. It returned `model: openai/qwen3.5-9b`, `duration: 24.084`, and
coarse usage of 10,555 prompt tokens plus 378 completion tokens (10,933 total)
from the OpenHands server. That bounded run finished the conversation but did
not satisfy the validation command, so its compact status was correctly
`failure`; the metrics were retained with the failure artifact rather than
being discarded. This verifies coarse local-run accounting without consuming
subscription tokens.

## Trusted-LAN Canvas configuration access

On 2026-10-03, OpenHands was recreated from the dedicated
`integrations/bazzite/openhands-compose.yaml` definition with
`OPENHANDS_BIND_ADDRESS=0.0.0.0`. Only the Canvas/Agent Server port 3001 was
changed; the named `openhands-data` and `openhands-projects` volumes were
preserved, and the other control-plane ports remain loopback-bound.

From the operator workstation, `http://192.168.86.69:3001/canvas/` returned
HTTP 200 and `/health` returned HTTP 200. The LAN exposure is intended for the
trusted home network; restore `OPENHANDS_BIND_ADDRESS=127.0.0.1` after
configuration if remote access is no longer needed.

Because these checks were executed inside the Bazzite-hosted container reached
through the remote Bazzite Podman connection, they also verify the remote Agent
Server deployment surface. They do not verify an external Cezar client call.

## Bounded local-model smoke test

On 2026-10-02, OpenHands created conversation
`e4ef107a-d5f6-460d-9bb3-363f5eb96f42` against the disposable Git fixture at
`/projects/openhands-live-smoke` with `worktree=true` and
`max_iterations=1`. The conversation reached `finished` through the local
LiteLLM endpoint at `host.containers.internal:4001` using `factory-code`; the
runtime created the dedicated worktree under
`/tmp/conversation-worktrees/<conversation_id>/openhands-live-smoke`.

This proves bounded local-model orchestration and worktree creation. The
initial tool-enabled attempt exposed a missing vLLM parser configuration; the
Mac mini was then restarted with `--enable-auto-tool-choice
--tool-call-parser qwen3_xml`. A direct live request returned a structured
`tool_calls` array, and conversation
`4d1695f0-c868-4e4b-94c4-15672b064e1f` completed with OpenHands terminal
actions in its dedicated worktree. The agent read `README.md` and reported
the expected heading without modifying the fixture.

The deployed service now has the saved Luna Codex subscription profile, but
the subscription-backed conversation still fails before tool execution with
an authentication error. Claude Code is not connected. The local-model path
remains the active validation path while that transport issue is unresolved.

## Concurrent isolation check

Two additional bounded local conversations completed concurrently on
2026-10-03:

- `1cf59217-923a-4187-8c32-7237071ad196` used
  `/tmp/conversation-worktrees/1cf59217-923a-4187-8c32-7237071ad196/openhands-live-smoke`.
- `2980fac1-408e-4784-b6cc-61aa1987b274` used
  `/tmp/conversation-worktrees/2980fac1-408e-4784-b6cc-61aa1987b274/openhands-live-smoke`.

Both performed a terminal read of the fixture and reached `finished`; the
worktree paths are distinct. This verifies local parallel worktree isolation,
but does not substitute for the still-pending concurrent Codex/Claude test.

## Failed-task recovery check

Conversation `a24884fd-c1ac-4d1e-aa96-aa2d641e7939` deliberately ran `false`
and recorded exit code 1, then ran `printf recovery-ok` in the same isolated
worktree with exit code 0. The conversation reached `finished` and returned
the recovery value without modifying files. This verifies local terminal
failure observation and bounded recovery; provider-level retry and GitHub PR
recovery remain pending.

## Cezar provider-adapter check

On 2026-10-03, the checked-in adapter `scripts/openhands/run-job.py` was run
live on Bazzite with the local OpenHands/LiteLLM path and fixture
`tests/fixtures/openhands-job-request.json`. It created conversation
`43cb8a22-fb6c-4f8c-9100-568d0b06314f`, requested an isolated worktree, used a
bounded eight-iteration limit, polled the Agent Server, and read `/events/search`
before returning `status: success` with `validationPassed: true`.

This proves the checked-in Cezar-to-OpenHands provider boundary for a local
bounded job. It does not prove premium subscription authentication, GitHub
issue execution, pull-request creation, or external network exposure.

## Provider retry and bounded failure check

On 2026-10-03, the failure fixture
`tests/fixtures/openhands-failure-request.json` requested the deliberately
failing validation command `false` with `--max-attempts 2`. The adapter created
conversations `b0b1f575-4b42-451b-a736-684e06605941` and
`8389f81b-a0d8-469a-b742-eaa23de90a3e`; both reached `finished`, validation
remained false, and the compact result returned `status: failure`,
`attempts: 2`, and both conversations in `failureArtifacts`. This confirms
bounded provider retry and actionable failure evidence without an unbounded
agent loop.

## Local usage accounting check

On 2026-10-03, the same checked-in adapter completed a second bounded live
job through the Mac mini-backed model `openai/qwen3.5-9b`. The result was
`status: success`, `validationPassed: true`, and `attempts: 1` after
42.151 seconds. The adapter recorded coarse provider usage without exposing
credentials: 28,729 prompt tokens, 1,153 completion tokens, and 29,882 total
tokens. This verifies that local workload outcome, duration, model identity,
and available token accounting are carried through the Cezar provider result;
premium-agent accounting remains pending.
