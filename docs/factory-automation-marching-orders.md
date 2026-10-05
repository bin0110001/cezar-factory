# Factory Automation Marching Orders

## Purpose

Build a development factory in which routine work is performed by deterministic
tools first, bounded local models second, and premium coding/reasoning agents
only when the earlier layers cannot safely complete the work. The system must
reuse durable memory without treating memory as authoritative requirements.

This is the current execution plan. It supplements the historical integrated
workplan: completed entries there remain evidence, while this document orders
the remaining work and defines the implementation contracts.

## Operating model

```text
GitHub issue / PR / event
        |
        v
deterministic preflight, state and validation tools
        |
        +-- complete or reject --> recorded artifact and legal state
        |
        v
bounded local utility model (advisory JSON only)
        |
        +-- valid and sufficient --> deterministic consumer applies policy
        |
        v
premium agent in OpenHands worktree
        |
        v
deterministic validation, independent review, human gate where required
```

The model tier never bypasses the deterministic tier. A model may propose a
plan, summary, classification, patch, or memory candidate; it does not directly
change GitHub state, retain a memory, merge a PR, or override a risk gate.

## Non-negotiable boundaries

| Responsibility | Owner | Notes |
| --- | --- | --- |
| Work truth, requirements, PRs, approvals | GitHub | GitHub remains the durable record of intent and review. |
| Legal lifecycle transitions | Factory scripts/Cezar | `route-state.ps1` is the state authority; no agent edits `factory:*` labels directly. |
| Workflow initiation, retry and escalation | Cezar | Cezar decides when a legal workflow can run. |
| Isolated coding session and worktree | OpenHands | Do not recreate a custom worktree or premium-agent runtime. |
| Bounded local inference | LiteLLM + vLLM | Local jobs are advisory, JSON-constrained, temperature-zero utility work. |
| Durable operational memory | Hindsight | Memory informs work; it does not replace Git documentation or issue requirements. |
| Normative architecture, policies and skills | Version-controlled repository | Changes require an ordinary reviewed PR. |
| Observability | Langfuse, Prometheus, Grafana | Measure before optimizing routing. |

## Execution rules

1. Prefer a deterministic script whenever its inputs and correctness can be
   expressed as a contract.
2. Use a local model only for bounded, non-authoritative work with a schema or
   independently checkable result.
3. Escalate to a premium agent for non-mechanical coding, material ambiguity,
   architecture, conflicting evidence, or a local result that fails validation.
4. Escalate to a human for product decisions, security/privacy decisions,
   high-risk plan approval, merge, and any unresolved requirement conflict.
5. Every automated action must be idempotent or have a durable lease/marker.
6. Every action must have a bounded retry count, a recorded artifact, and a
   defined terminal outcome.
7. Automations start paused and advance from fixture evidence to a narrowly
   scoped live pilot before broader enablement.

## Phase 0 — Stabilize and establish the factual baseline

### Deliverables

- Repair the Factory self-test baseline before expanding behavior. The current
  test run reports failed strict-mode assertions for:
  `scripts/deploy/configure-cezar-opencode.sh`,
  `scripts/deploy/enable-cezar-boot-start.sh`, and
  `scripts/deploy/expose-cezar-lan.sh`.
- Reconcile claims in `cezar_factory_workplan.md` with corresponding live
  evidence. In particular, Hindsight itself is deployed and recalled from, but
  `docs/hindsight-live-evidence.md` says Cezar workflow connection remains
  unfinished. Mark the real integration state precisely rather than inferring
  completion from deployed infrastructure.
- Create an execution inventory that maps every existing workflow, automation,
  script, skill, local job, schema, and external dependency to an owner and a
  test/evidence source.
- Confirm the supported Cezar workflow syntax and lifecycle integration using
  the deployed version before adding workflow steps. Repository fixtures prove
  deterministic script behavior; they are not evidence that a live Cezar
  account has run it.

### Exit criteria

- `pwsh -NoProfile -File tests/run-tests.ps1` passes in a clean checkout.
- Each open external gate has a named operator action and evidence location.
- No document asserts that a live integration is complete without a matching
  successful live check.

## Phase 1 — Create the deterministic automation catalog

### Goal

Make the routing order executable and reviewable instead of relying on prose in
skills. Keep the initial policy deterministic; do not create a learned router.

### Contract

Add a versioned catalog (YAML or JSON) with one entry per job class. Every entry
must state:

- stable job identifier and purpose;
- allowed input artifact(s) and maximum injected context;
- preferred execution tier (`tool`, `local`, `premium`, or `human`);
- eligible worker(s) and explicit fallback order;
- output schema or deterministic verifier;
- retry budget, timeout, and terminal state;
- persistence authority and required approval;
- observability fields and artifact location.

The catalog becomes the source of truth for the existing local-job policy and
future workflow selection. Labels remain user-facing overrides, but an override
cannot bypass risk, validation, or state-transition policies.

### Initial classification

| Class | First choice | Fallback | Required proof |
| --- | --- | --- | --- |
| State transitions, validation, labels, Git operations | Tool | Human on refusal | Exit code and structured artifact |
| Test/build/lint/package execution | Tool | Investigate on failure | Native report plus compact summary |
| Issue classification, risk suggestion, extraction | Local | Premium or human | JSON schema and deterministic policy checks |
| Log/diff/test-result compression | Local | Premium | References and exact failure excerpts retained |
| Memory-candidate extraction | Local | Human review | Candidate schema and retention filter |
| Mechanical documentation or narrow tests | Local pilot | Premium | Diff plus normal validation/review |
| Planning with requirements ambiguity | Premium | Human | Definition of Ready and risk gate |
| Non-trivial implementation, architecture, conflict resolution | Premium | Human | Validation and independent review |
| Product, legal, security, privacy, merge decisions | Human | None | GitHub approval/record |

### Exit criteria

- Catalog validates in Factory CI.
- Existing `routing/default.yaml` and `routing/local-jobs.yaml` either derive
  from it or are explicitly checked for consistency.
- Every workflow step has an artifact and terminal behavior, including failed
  local-model calls and unavailable providers.

## Phase 2 — Make Hindsight usage concrete, bounded and auditable

### Goal

Replace skill-only instructions to “recall memory when available” with an
actual reusable memory boundary.

### Implementation design

- Add a small cross-platform Python Hindsight client and PowerShell entry-point
  wrappers where installed Factory workflows require `.ps1` commands. Python is
  chosen for stable HTTP/MCP payload handling and focused unit tests, not as a
  replacement for the Factory's PowerShell installation interface.
- Provide `recall` and `retain` operations only. Do not build a custom memory
  store, embeddings service, or memory-ranking system.
- Recall inputs: project identifier, issue/PR objective, task class, compact
  keywords, and optional failure signature.
- Query the project bank first; query the Factory bank only for reusable
  workflow/tool lessons. Enforce the existing maximum of eight memories and
  12,000 characters across the combined recall.
- Write a compact `.factory/context/memory-recall.json` artifact containing the
  queried banks, memory IDs, scores if supplied, character count, and selected
  excerpts. Credentials, complete memory-bank contents, and raw responses are
  never written to the repository.
- Include the compact recall artifact in plan and investigation prompts. The
  plan/investigation result records the recall metadata, not copied memories.
- A missing, unauthorized, malformed, or timed-out memory service is a
  fail-open recall miss with an observable warning; it must never invent a
  recall result or block low-risk work merely because memory is unavailable.

### Retention pipeline

```text
completed or investigated task
        -> bounded local extraction of candidates
        -> deterministic allow/deny, schema, size and duplicate checks
        -> human approval during pilot
        -> Hindsight retain
        -> retention receipt artifact and observability event
```

Allowed candidates are architectural decisions, recurring failures, successful
fixes, project conventions, and environment discoveries. Exclude transcripts,
source files, raw logs, credentials, personal data, temporary state, and facts
already expressed in normative project documentation.

Start retain in approval-required mode. Consider automatic retain only after a
measured review period shows low false-positive and duplicate rates.

### Required tests

- Mocked success, empty recall, timeout, unauthorized response, malformed
  response, and context-budget trimming.
- Project-first and Factory-bank routing.
- Candidate allow/deny enforcement and idempotent duplicate behavior.
- No secret-bearing field appears in artifacts, failure output, or telemetry.
- Fixture workflow proof that plan and investigation can consume a recall
  artifact without changing legal lifecycle behavior.

### Exit criteria

- A live authenticated bounded recall occurs before one planning task.
- One human-approved durable lesson is retained after an investigation or
  resolved task and can be recalled later.
- Both events carry project/workflow/issue/worker/model metadata in observability.

## Phase 3 — Build a Factory-native backlog reconciler

### Goal

Provide the useful “work the backlog” behavior without importing another
repository's labels, auto-merge policy, or direct state ownership.

### Scope

The reconciler is a deterministic policy tool, not a coding agent. It inspects
GitHub state and emits a proposed action list. It does not implement an issue,
merge a PR, make product decisions, or silently relabel blocked work.

### Reconciliation algorithm

1. Read open issues and validate exactly one `factory:*` state label per issue.
   Report invalid combinations; do not repair them automatically on the first
   release.
2. Exclude issues with an active Factory/OpenHands lease, an open human gate,
   or a current blocker.
3. Order candidates deterministically: explicitly prioritized work first, then
   dependency-ready work, then oldest eligible issue. The exact ordering fields
   must be documented in the catalog.
4. Emit only legal next actions, such as `plan`, `implement`, `review`, or
   `investigate`, according to the state machine.
5. Enforce a configurable batch cap and per-project concurrency cap. Stop and
   report when a cap is reached; an explicit later user/operator enablement is
   required for a new unattended batch.
6. Use a GitHub-visible claim/lease marker before dispatch. Claims must have
   an owner, timestamp, expiry, and idempotent release/finalization behavior.
7. Dispatch through Cezar only after dry-run and live-read-only evidence have
   passed. Cezar owns state transitions; OpenHands owns premium worktrees.

### Rollout

- Version 1: read-only report plus `-DryRun` artifact.
- Version 2: creates/reclaims leases but does not dispatch.
- Version 3: dispatches one low-risk, single-project issue while all other
  automations remain paused.
- Version 4: enables bounded scheduled operation after successful evidence for
  duplicate prevention, recovery, and escalation.

### Exit criteria

- Fixture tests cover ordering, illegal states, blocked work, claim collisions,
  expired claims, duplicate runs, batch caps, and no-candidate behavior.
- A live dry run matches the expected GitHub queue without mutating it.
- One deliberate low-risk dispatch produces exactly one workflow run and a
  compact execution record.

## Phase 4 — Align skills and workflows to the contracts

### Skills

Keep skills short, role-specific, and declarative. They should point to the
catalog and artifacts rather than reproduce workflow mechanics.

- Update `factory-plan` and `factory-investigate` to require the bounded recall
  artifact when memory is configured, and to record a genuine recall miss when
  it is not.
- Update `factory-learn` so it creates retention candidates and recommendations
  but never directly edits shared skills or normative documentation.
- Create `factory-work-backlog` only after the reconciler exists. It invokes the
  reconciler, explains eligible work, and honors leases/caps; it never manually
  duplicates the lifecycle algorithm.
- Keep `factory-implement`, `factory-review`, and `factory-fix` focused on
  execution and validation. They must not choose their own model tier or change
  lifecycle labels.

### Workflows

- Add deterministic preflight steps before model invocation: source state,
  issue identity, lease, project validation interface, and relevant context
  artifact creation.
- Add memory recall as an explicit command step in planning and investigation,
  rather than leaving it implicit in a prompt.
- Add retention only after the normal task has reached a successful/reviewed
  outcome and the candidate has passed the pilot approval gate.
- Keep local-model steps advisory. A following deterministic validator decides
  whether their output can influence workflow behavior.
- Every workflow result must name its selected tier/worker, inputs, artifacts,
  validation outcome, retry count, and terminal reason.

### Exit criteria

- Workflow fixtures demonstrate all new steps and refusal paths.
- Skills have no duplicated state-transition logic.
- A workflow is safe to rerun after an interrupted process.

## Phase 5 — Establish local-model promotion rules

### Pilot protocol

For each candidate task class, run a representative set of tasks in shadow
mode: local output is recorded and compared with the existing deterministic or
human/premium outcome, but does not act on production state. Store only compact
evaluation records, not prompts containing secrets or full repository context.

Track:

- task class and difficulty/risk;
- context size and model identity;
- schema validity and deterministic-validation outcome;
- correction/rejection reason;
- retries, duration, token/usage estimate, and premium fallback;
- human-review outcome where applicable.

### Promotion criteria

A task class may move from shadow to advisory production only when it has a
predefined sample size, schema-valid output rate, independently verified
success rate, and no unacceptable safety failure. Set those thresholds per task
class in the catalog before collecting results; do not retrofit them after a
good-looking sample.

Local models do not become final decision makers for lifecycle, risk, security,
or persistence merely because they score well on summaries or classification.

### Exit criteria

- One dashboard/query shows local vs premium vs tool outcomes by task class.
- Routing remains deterministic, with promotions documented as policy changes.
- No confidence-based or learned router is introduced until meaningful premium
  comparison data exists.

## Phase 6 — Prove premium execution and run end-to-end pilots

### External gates

- Create authenticated Codex and Claude profiles compatible with OpenHands.
- Confirm a single low-risk issue run for each provider before concurrent runs.
- Confirm branch/PR lifecycle with real GitHub credentials and a bounded issue.
- Confirm a provider failure leaves an actionable compact record and does not
  trigger an unbounded retry loop.

### Pilot ladder

1. Fixture-only workflow tests.
2. Local-model utility job against the live gateway, no GitHub mutation.
3. Hindsight recall/approved retain pilot.
4. Read-only backlog reconciliation against one project.
5. One low-risk issue through plan, implementation, validation, review and
   human merge.
6. One provider-recovery case.
7. One concurrent, isolated two-agent run after the two single-provider paths
   have independently passed.
8. Enable a single paused automation with a batch cap of one.

At every stage, failure returns to the preceding safe stage; it never broadens
automation scope as a workaround.

## Phase 7 — Operate, review and evolve safely

### Regular review

- Review dispatches, escalations, lease expirations, validation failures,
  retention approvals/rejections, and local-model correction rates weekly while
  the factory is maturing.
- Review routing policy only from collected evidence.
- Treat recurring manual intervention as a candidate for a deterministic tool
  first, then a bounded local job, then a premium-agent procedure.
- Promote a durable lesson to Git documentation or a shared skill only through
  a reviewed PR; Hindsight can suggest it but is not the source of truth.

### Stop conditions

Pause the affected automation and require human review after a safety violation,
duplicate dispatch, unauthorized mutation, unexpected state transition, memory
privacy breach, repeated provider failure, or unexplained validation regression.
The pause must preserve evidence and leave the underlying issue in a clear
human-actionable state.

## Ordered implementation backlog

The following sequence is the working engineering backlog. Complete each item
with tests and evidence before beginning the next item unless it is explicitly
blocked by external credentials or infrastructure.

1. Repair the three Factory test-baseline failures and record the clean result.
2. Add the execution inventory and reconcile the workplan/evidence discrepancy.
3. Define and validate the deterministic automation catalog; add consistency
   tests against existing routing configuration.
4. Implement the Hindsight recall client, PowerShell wrapper, artifact schema,
   mock tests, and plan/investigation workflow preflight integration.
5. Implement retention candidate schema/filter/receipt handling in
   approval-required mode, with mocked Hindsight tests.
6. Run and document the live memory recall plus approved-retain pilot.
7. Implement the backlog reconciler in read-only dry-run mode with exhaustive
   fixture coverage.
8. Add lease support and its collision/expiry/retry tests; keep dispatch off.
9. Add `factory-work-backlog` skill and Cezar dispatch integration, guarded by
   project concurrency and batch caps.
10. Run the one-issue end-to-end pilot once authenticated premium providers and
    GitHub lifecycle credentials are available.
11. Establish local-task shadow evaluation and dashboards; promote only task
    classes that meet their predeclared gates.
12. Enable paused automations incrementally, beginning with one project and a
    batch cap of one, then reassess with recorded evidence.

## Definition of success

The Factory is ready for broader rollout when a low- or medium-risk issue can
move from `factory:needs-plan` to a reviewed, human-merged PR with no manual
orchestration beyond required approval gates; all state changes are
deterministically validated; memory recall and retention are bounded and
auditable; local work is measurably useful without having authority it should
not possess; premium execution is isolated and bounded; and failures produce a
clear, actionable human decision rather than an unbounded agent loop.
