# Cezar Factory — Integrated Architecture and Revised Workplan

## 1. Goal

Build a reusable, version-controlled development factory in which:

- **GitHub** is the durable source of truth for work.
- **Cezar** is the control plane deciding *when* and *why* work runs.
- **OpenHands Agent Canvas / Agent Server** is the coding-agent execution plane.
- **Codex CLI** and **Claude Code** remain subscription-backed premium agents.
- **vLLM** provides local inference.
- **LiteLLM** provides a common gateway/routing layer where it adds value.
- **Hindsight** provides durable agent/project memory.
- **Langfuse** provides LLM observability.
- **Prometheus/Grafana** provide infrastructure observability.
- Existing tools provide repository context, Git isolation, telemetry, model serving, and memory wherever possible.
- Custom Factory code is limited primarily to configuration, workflows, policies, thin adapters, and project-specific validation.

The central principle is:

> **Integrate before building.**

---

# 2. Target Architecture

```text
                         GitHub
                Issues / PRs / Repository
                           │
                           ▼
                    ┌─────────────┐
                    │    Cezar    │
                    │ Control     │
                    │ Plane       │
                    └──────┬──────┘
                           │
          planning / policy / routing / automation
                           │
           ┌───────────────┼────────────────┐
           │               │                │
           ▼               ▼                ▼
      Local Utility    OpenHands        Deterministic
       LLM Tasks      Agent Canvas         Tools
           │               │                │
           │        ┌──────┼───────┐        │
           │        ▼      ▼       ▼        │
           │      Codex  Claude   Local      │
           │                       Agent     │
           │                                 │
           ▼                                 ▼
        LiteLLM                          Tests / CI
           │                             Linters
           ▼                             Compilers
         vLLM                            Git / SARIF
           │
     Local GPU Compute
```

Supporting services:

```text
Hindsight
   └── durable project/factory memory

Langfuse
   └── LLM tracing and usage

Prometheus + Grafana
   └── infrastructure / GPU / containers

HashiCorp Vault
   └── Factory and cross-project secret management

Factory Dashboard
   └── lightweight launcher + health overview
```

---

# 3. Architecture Responsibility Boundaries

## GitHub — Work Truth

GitHub owns:

- issues;
- requirements;
- plans;
- acceptance criteria;
- PRs;
- review state;
- human decisions;
- durable work status.

Existing Cezar Factory GitHub state model remains authoritative.

### Keep Existing Work

- [X] `factory:new`
- [X] `factory:needs-plan`
- [X] `factory:needs-help`
- [X] `factory:ready`
- [X] `factory:working`
- [X] `factory:review`
- [X] `factory:changes-requested`
- [X] `factory:human-review`
- [X] `factory:blocked`
- [X] `factory:done`

The existing mutually exclusive lifecycle and transition rules remain valuable and should not be replaced.

---

# 4. Cezar — Factory Control Plane

Cezar should **not** become the execution runtime for every tool.

Cezar owns:

- workflow initiation;
- GitHub label/state transitions;
- planning;
- risk policy;
- routing policy;
- retries at the workflow level;
- escalation;
- scheduled maintenance;
- deciding which execution system gets a task.

## Existing Cezar Work to Keep

### Core Skills

- [X] `factory-plan`
- [X] `factory-implement`
- [X] `factory-review`
- [X] `factory-fix`
- [X] `factory-investigate`

### Core Workflows

- [X] `plan`
- [X] `implement`
- [X] `review`
- [X] `fix-review`
- [X] `investigate`

### Automations

- [X] `needs-plan`
- [X] `ready-to-implement`
- [X] `ready-to-review`
- [X] `changes-requested`
- [X] investigation/retry automation

### Policies

- [X] Definition of Ready.
- [X] Definition of Done.
- [X] Retry policy.
- [X] Escalation policy.
- [X] Risk classification.
- [X] GitHub lifecycle.

### Structured Outputs

Keep the existing:

- [X] planning result schema;
- [X] implementation result schema;
- [X] review result schema;
- [X] investigation result schema.

These are valuable because downstream stages do not need to re-parse large free-form responses.

---

# 5. Preserve the Existing Factory Repository

The existing versioned `cezar-factory` repository remains useful.

Keep:

```text
cezar-factory/
├── skills/
├── workflows/
├── automations/
├── policies/
├── schemas/
├── templates/
├── scripts/
└── docs/
```

The existing synchronization system is also worth retaining.

## Existing Completed Work

- [X] Semantic versioning.
- [X] Factory version pins.
- [X] Managed-file markers.
- [X] Install process.
- [X] Update process.
- [X] Diff/drift process.
- [X] Verification process.
- [X] Automation reconciliation.
- [X] Project overrides.
- [X] Factory/project ownership boundaries.

This remains the mechanism for distributing reusable Factory configuration between projects.

---

# 6. Finish the Remaining Synchronization Work

Existing remaining items:

- [X] Finish project-owned override preservation.
- [X] Finish dry-run support.
- [X] Verify rollback against an earlier Factory release.
- [X] Add CI coverage for synchronization.

Do this before substantially extending Factory configuration.

---

# 7. Add OpenHands as the Agent Execution Plane

Rather than building custom process management around Codex and Claude, evaluate **OpenHands Agent Canvas** first.

Agent Canvas currently supports:

- Codex;
- Claude Code;
- ACP-compatible agents;
- simultaneous agents;
- separate Git worktrees;
- local or remote Agent Servers;
- GitHub/event/cron automation.

## Proof of Concept

- [X] Deploy OpenHands Agent Canvas.
- [ ] Connect existing Codex subscription. (The saved `Luna` profile is now
  subscription-backed and Agent Canvas 1.24.0 is deployed, but the live
  conversation still fails in subscription transport before tool execution;
  see `docs/openhands-live-evidence.md`.)
- [ ] Connect existing Claude Code subscription.
- [ ] Execute a real low-risk GitHub issue using Codex.
- [ ] Execute a second using Claude.
- [ ] Run both concurrently.
- [X] Confirm separate worktree behavior.
- [ ] Confirm branch/PR lifecycle.
- [X] Test failed-task recovery.
- [X] Test remote Agent Server.
- [X] Determine the cleanest way for Cezar to launch an OpenHands job.

## Decision Gate

If OpenHands works satisfactorily:

- [X] Do **not** build a custom Codex runner.
- [X] Do **not** build a custom Claude runner.
- [X] Do **not** build a custom worktree manager.
- [X] Do **not** build a custom agent process supervisor.
- [X] Do **not** build a custom remote coding-worker protocol.

---

# 8. Revised Implement Workflow

Existing:

```text
Cezar
  ↓
agent implementation
  ↓
tests
  ↓
PR
```

Revised:

```text
GitHub: factory:ready
        ↓
Cezar Implement Workflow
        ↓
Select Execution Worker
        ↓
OpenHands Agent Canvas
        ↓
Codex / Claude / Local Agent
        ↓
isolated worktree
        ↓
implementation
        ↓
project validation
        ↓
PR
        ↓
factory:review
```

## Work

- [X] Replace direct implementation-agent invocation with an execution-provider abstraction.
- [X] Add `openhands` as the initial premium execution provider.
- [X] Keep Cezar responsible for lifecycle state.
- [X] Keep OpenHands responsible for coding session execution.

---

# 9. Do Not Duplicate OpenHands State in Cezar

Cezar only needs enough execution information to make workflow decisions.

Store:

```yaml
execution:
  provider: openhands
  agent: codex
  status: complete
  branch: factory/issue-412
  pr: 521
  result: success
```

Avoid mirroring:

- internal agent conversation state;
- command history;
- worktree internals;
- entire tool traces.

---

# 10. Switch Local Inference to vLLM

Use **vLLM instead of Ollama as the standard Factory inference server**.

Reasons:

1. It exposes OpenAI-compatible APIs.
2. It supports tensor parallelism for multi-GPU machines.
3. It supports pipeline parallelism.
4. It supports multi-node deployments.
5. It supports Ray as a distributed execution backend.
6. The operational experience transfers much better to future compute-cluster work.

## Initial vLLM Deployment

- [X] Deploy vLLM natively on the Mac mini under launchd (Podman is not used for model serving).
- [X] Expose and validate the OpenAI-compatible endpoint.
- [X] Put endpoint behind trusted-network controls/reverse proxy; the live Mac endpoint is loopback-only behind the allowlisted/authenticated launchd proxy.
- [X] Do not rely solely on vLLM's built-in API key protection because not every endpoint is covered by it.
- [X] Select one small general model.
- [X] Select one coding-oriented model.
- [X] Benchmark latency.
- [X] Benchmark throughput.
- [X] Benchmark memory requirements using the Apple Silicon unified-memory footprint; dedicated VRAM is not exposed on this host.
- [X] Document repeatable deployment.

---

# 11. Make vLLM Deployment Cluster-Friendly From Day One

Initial architecture:

```text
GPU Machine
    │
    └── vLLM
          │
          └── OpenAI-compatible API
```

Future:

```text
                vLLM
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      GPU-01    GPU-02    GPU-03

Tensor / Pipeline / Data Parallelism
```

vLLM supports both single-node multi-GPU and multi-node execution; Ray is one supported backend for multi-node deployments.

## Work

- [X] Keep model paths/config externally configurable.
- [X] Containerize vLLM deployment.
- [X] Record GPU topology.
- [X] Record model compatibility.
- [ ] Experiment with tensor parallelism when multiple GPUs are available.
- [ ] Experiment with Ray once multiple nodes become available.
- [X] Write internal notes documenting lessons applicable to work clusters.

---

# 12. LiteLLM — Keep, but Keep Its Role Small

vLLM is the inference server.

LiteLLM is the optional **model gateway** above it.

```text
Factory
   │
LiteLLM
   │
   ├── vLLM deployment A
   ├── vLLM deployment B
   └── future model endpoints
```

LiteLLM already supports deployment load balancing, retries, fallbacks, queueing and multiple routing strategies.

## Deploy When Useful

- [X] Deploy LiteLLM after the first vLLM endpoint works.
- [X] Register vLLM endpoint(s).
- [X] Define logical models.

Example:

```yaml
factory-small
factory-code
factory-large-local
```

- [X] Add fallback configuration.
- [X] Add health-aware routing.
- [X] Add usage tracking.
- [X] Back LiteLLM with a dedicated persistent PostgreSQL service.
- [X] Use Redis only when multi-instance routing/coordination requires it.

## Do Not Use LiteLLM For

- [X] Codex subscription authentication.
- [X] Claude subscription authentication.

Those remain native agents under OpenHands.

---

# 13. Local Model Job Classes

Local models should handle bounded, easy-to-verify work first.

## Phase A Candidates

- [X] Classify GitHub issues.
- [X] Recommend work-type labels.
- [X] Recommend risk labels.
- [X] Summarize long issues.
- [X] Extract acceptance criteria.
- [X] Normalize test errors.
- [X] Summarize logs.
- [X] Summarize diffs.
- [X] Draft commit/PR summaries.
- [X] Extract potential Hindsight memories.

## Phase B Candidates

After measuring quality:

- [X] Write simple documentation.
- [X] Generate straightforward tests.
- [X] Perform small mechanical refactors (portable SHA-256 hashing and stricter child-process test handling).
- [X] Perform trivial bug fixes (real `gh` argument handling and PowerShell command-shadowing fixes are recorded in the changelog).

---

# 14. Add Execution Routing to Existing Cezar Policy

Current labels already include:

- [X] `agent:codex`
- [X] `agent:claude`
- [X] `agent:either`

Keep these initially.

Extend later with:

```text
agent:local
agent:auto
```

## Routing v1

Use deterministic policy.

Example:

```yaml
routing:

  classify:
    worker: local

  summarize:
    worker: local

  docs:
    preferred: local
    fallback: codex

  implementation:
    preferred: codex

  architecture:
    preferred: claude

  review:
    different_from_implementation: true
```

- [X] Add routing policy file.
- [X] Allow project override.
- [X] Allow issue label override.
- [X] Record selected worker.

Do **not** build an intelligent router yet.

---

# 15. Replace `factory-learn` With Hindsight-Backed Learning

The existing `factory-learn` concept was good, but we should avoid implementing our own memory system.

Hindsight already provides:

- retain;
- recall;
- reflect;
- persistent memory banks;
- MCP connectivity.

## Change

Existing:

```text
factory-learn
    ↓
edit skills/docs
```

Replace with:

```text
Task result
    ↓
cheap/local reflection
    ↓
Hindsight retain
```

and:

```text
New task
    ↓
Hindsight recall
    ↓
relevant memory only
    ↓
planner / implementation agent
```

---

# 16. Deploy Hindsight

- [X] Deploy Hindsight in Podman.
- [X] Create Factory-level memory bank.
- [X] Create per-project memory banks.
- [X] Enable MCP endpoint.
- [X] Configure authentication before exposing beyond localhost/trusted network.
- [ ] Connect Claude Code where useful.
- [ ] Connect other MCP-capable clients.
- [X] Connect Cezar workflow through the checked-in OpenHands provider interface; live bounded execution is recorded in `docs/openhands-live-evidence.md`.

Hindsight's MCP server is already built in, so there should be no need for a custom memory API.

---

# 17. Memory Scope

## Project Memory

Store:

- architectural decisions;
- test quirks;
- framework pitfalls;
- recurring failures;
- successful debugging approaches;
- project conventions;
- environment discoveries.

## Factory Memory

Store:

- workflow lessons;
- agent/tool behavior;
- reusable testing approaches;
- routing observations;
- cross-project Factory lessons.

## Do Not Store Automatically

- entire transcripts;
- entire source files;
- raw logs;
- temporary task state;
- every GitHub comment.

---

# 18. Modify Existing Planning Workflow

Current planning flow remains.

Add:

```text
GitHub Issue
    ↓
Hindsight recall
    ↓
factory-plan
    ↓
Definition of Ready
    ↓
GitHub
```

## Work

- [X] Retrieve limited relevant memory before planning.
- [X] Apply strict context/token limit.
- [X] Record which memory bank was queried.
- [X] Do not dump all project memories into the prompt.

---

# 19. Modify Existing Investigation Workflow

The existing investigation workflow is already designed to gather compact evidence rather than dump logs. Keep that design.

Add Hindsight recall:

```text
failure
   ↓
structured test evidence
   ↓
Hindsight:
"Have we seen this before?"
   ↓
factory-investigate
```

- [X] Query prior similar failures.
- [X] Include successful historical fixes where relevant.
- [X] Record newly discovered durable solution after resolution.

---

# 20. Replace the Planned Knowledge Feedback Phase

Existing Phase 15 proposed a later custom knowledge loop.

Retire most of that implementation.

## Replace With

- [X] Use Hindsight for operational memory.
- [X] Keep durable architecture documentation in Git.
- [X] Keep Factory policies/skills in Git.
- [X] Use Hindsight to propose documentation changes.
- [X] Require normal PR review before changing durable documentation.

The rule becomes:

```text
Hindsight = learned operational knowledge

Git = normative/project documentation
```

---

# 21. Keep the Standard Project Validation Interface

This part of the original plan is still important.

Every project should expose a predictable validation interface.

Existing target:

```text
scripts/factory/test-changed.ps1
scripts/factory/test-full.ps1
scripts/factory/verify.ps1
```

Keep the interface, but avoid custom output parsing whenever standard formats exist.

---

# 22. Finish Project Validation

## `test-changed`

- [X] Identify tests associated with changed work.
- [X] Run targeted tests.
- [X] Return reliable exit status.
- [X] Save detailed artifacts.

## `test-full`

- [X] Run project test suite.
- [X] Save structured reports.
- [X] Return reliable exit status.

## `verify`

- [X] Build.
- [X] Lint.
- [X] Static analysis.
- [X] Syntax validation.
- [X] Tests.
- [X] Packaging/export validation where relevant.

---

# 23. Prefer Standard Test Formats

Use existing outputs instead of writing custom parsers.

Prefer:

```text
JUnit XML
TRX
SARIF
coverage XML/JSON
native JSON reports
```

Then create only a thin summary stage for the LLM.

Example:

```json
{
  "status": "failed",
  "passed": 417,
  "failed": 2,
  "failure_reports": [
    "artifacts/junit.xml"
  ]
}
```

- [X] Keep verbose logs outside normal LLM context.
- [X] Supply exact failure sections first.
- [X] Let agents retrieve larger artifacts only if needed.

---

# 24. Keep Risk-Based Human Gates

The existing risk gate design remains valuable.

## Low Risk

Examples:

- documentation;
- tests;
- minor isolated bug fixes.

```text
implement
 → validate
 → AI review
 → human review
```

## Medium Risk

- features;
- networking;
- persistence;
- meaningful refactoring.

Require:

- [X] independent AI review;
- [X] human PR review.

## High Risk

- security;
- authentication;
- migration;
- billing;
- deployment;
- major architecture.

Require:

- [X] human plan approval;
- [X] implementation;
- [X] full validation;
- [X] independent review;
- [X] human merge.

---

# 25. Retire Most of Existing Phase 14: Cezar Parallel Dispatch

The original plan intended Cezar child-task dispatch for:

- parallel test creation;
- research;
- code analysis;
- isolated implementation work.

OpenHands now overlaps significantly with this.

## Revised Decision

- [X] Do not prioritize Cezar as the coding-agent parallelism layer.
- [X] Use OpenHands worktree isolation and parallel agents first.
- [X] Keep Cezar child tasks only for workflow-level decomposition.

Good Cezar parallel use:

```text
Research dependency options
Analyze API requirements
Run external data task
Generate asset
```

Good OpenHands parallel use:

```text
Agent A → implementation
Agent B → independent review
Agent C → isolated test work
```

---

# 26. Repository Context — Do Not Build Anything Yet

Retire plans for a custom:

- repository indexing service;
- Tree-sitter service;
- symbol graph;
- embeddings pipeline;
- context compiler.

First use agent-native tooling.

Evaluate:

- [X] OpenHands repository/context handling.
- [ ] Codex native repo exploration. (The installed CLI was tested against
  the Mac mini endpoint, but its ChatGPT-account provider rejected the local
  `qwen3.5-9b` model before repository access; see
  `docs/local-coding-tool-evaluation.md`.)
- [ ] Claude Code native repo exploration.

Only if token usage remains problematic:

- [X] Test Aider repository maps. Deferred after evaluation: Aider is not
  installed and the current bounded OpenHands path does not show a context
  pressure problem; see `docs/local-coding-tool-evaluation.md`.
- [X] Test Continue context providers. Deferred after evaluation: Continue is
  not installed and the current workflow is headless; see
  `docs/local-coding-tool-evaluation.md`.

Build custom tooling only after demonstrating a specific gap.

---

# 27. Context Optimization Policy

Default context strategy:

```text
Issue
  +
acceptance criteria
  +
project instructions
  +
relevant Hindsight recall
  +
agent-native repo discovery
```

Not:

```text
Entire repository
Entire documentation set
Entire issue history
Entire previous agent conversation
```

## Rules

- [X] Never proactively inject full test logs.
- [X] Never inject unrelated architectural documentation.
- [X] Prefer Git diffs during review.
- [X] Prefer references to artifacts over artifact bodies.
- [X] Give agents additional context on demand.

---

# 28. Add Langfuse for Model Observability

Use Langfuse for:

- local model calls;
- LiteLLM traffic;
- prompts;
- outputs;
- token counts;
- latency;
- traces.

## Work

- [X] Deploy Langfuse.
- [X] Instrument LiteLLM.
- [X] Add project metadata.
- [X] Add workflow metadata.
- [X] Add GitHub issue metadata.
- [X] Add model metadata.

Do not build a custom LLM telemetry product.

---

# 29. Subscription Agent Metrics

Exact token telemetry may not always be available through subscription agents.

That is acceptable.

Record coarse metrics:

```yaml
project: tableflux
issue: 412
worker: codex
provider: openhands

result: success
attempts: 1
duration: ...

files_changed: 6

validation:
  passed: true
```

This is enough for routing analysis.

---

# 30. Infrastructure Monitoring

Use:

```text
Prometheus
+
Grafana
```

Optionally:

```text
Loki
```

for centralized logs.

Monitor:

- vLLM;
- GPUs;
- VRAM;
- CPU;
- RAM;
- Podman;
- OpenHands Agent Servers;
- Cezar;
- Hindsight;
- LiteLLM;
- Langfuse.

---

# 31. Factory Dashboard

Continue the previously planned Factory homepage/dashboard, but keep it thin.

The dashboard should be a **portal**, not a replacement UI.

Example:

```text
Factory

Development
────────────────────────
GitHub          ✓
Cezar           ✓
OpenHands       ✓

AI Services
────────────────────────
vLLM GPU-01     ✓
LiteLLM         ✓
Hindsight       ✓
Langfuse        ✓

Infrastructure
────────────────────────
Grafana         ✓
GPU-01          ✓
Linux-01        ✓

Projects
────────────────────────
Tableflux       ✓
Book Factory    ✓
Asset Generator ✓
```

## Build Only

- [X] health indicators;
- [X] direct links;
- [X] basic workload counts;
- [X] machine availability;
- [X] important alerts.

Use product-native dashboards for detailed management.

---

# 32. Factory CI — Keep Original Plan

The original Factory repository still needs CI.

Finish:

- [X] YAML validation.
- [X] JSON schema validation.
- [X] Skill validation.
- [X] required-file checks.
- [X] synchronization tests.
- [X] installation into fixture project.
- [X] upgrade fixture tests.
- [X] drift detection tests.
- [X] project-override preservation tests.

Keep fixtures:

```text
tests/fixtures/
├── godot-project/
├── dotnet-project/
└── generic-project/
```

---

# 33. Factory Release Process — Keep Original Plan

Continue using semantic versions.

## Patch

- prompt updates;
- fixes;
- non-breaking validation changes.

## Minor

- workflow;
- skill;
- optional feature;
- integration.

## Major

- lifecycle change;
- required schema change;
- breaking workflow behavior.

Finish:

- [X] automated release validation;
- [X] fixture upgrade tests;
- [X] release notes;
- [X] rollback validation.

---

# 34. Revised Configuration Repository

Expand the existing Factory repo rather than creating another configuration repository.

```text
cezar-factory/
│
├── skills/
├── workflows/
├── automations/
├── policies/
├── schemas/
│
├── integrations/
│   ├── openhands/
│   ├── hindsight/
│   ├── litellm/
│   ├── vllm/
│   ├── langfuse/
│   └── monitoring/
│
├── routing/
│   └── default.yaml
│
├── templates/
├── scripts/
├── tests/
└── docs/
```

- [X] Configure Factory control-plane containers for the Bazzite server.
- [X] Configure native vLLM deployment for the Mac mini only; keep control-plane containers on Bazzite.
- [X] Keep deployment templates versioned.
- [X] Add self-validating deployment scripts and CI/static coverage for deployment contracts.
- [X] Keep credentials outside Git.
- [X] Deploy HashiCorp Vault with persistent integrated storage on Bazzite;
  bootstrap and secret migration remain operator-controlled.
- [X] Version integration configuration where practical.

---

# 35. Product Stack

| Responsibility          | Product                |
| ----------------------- | ---------------------- |
| Backlog / work truth    | GitHub                 |
| Factory control plane   | Cezar                  |
| Coding execution        | OpenHands Agent Canvas |
| Premium coding          | Codex CLI              |
| Premium coding/analysis | Claude Code            |
| Local inference         | **vLLM**         |
| Local/API routing       | LiteLLM                |
| Long-term memory        | Hindsight              |
| LLM observability       | Langfuse               |
| Infrastructure metrics  | Prometheus             |
| Dashboards              | Grafana                |
| Secret management       | HashiCorp Vault        |
| Source control          | Git                    |

Optional:

| Need                                | Product     |
| ----------------------------------- | ----------- |
| Local coding agent                  | Aider       |
| Interactive local-model coding      | Continue    |
| Central logs                        | Loki        |
| Large-scale code intelligence later | Sourcegraph |

---

# 36. Things We Explicitly Will Not Build

Unless an existing product proves insufficient:

- [X] No custom model inference server.
- [X] No custom LLM gateway.
- [X] No custom coding-agent runtime.
- [X] No custom Codex wrapper.
- [X] No custom Claude wrapper.
- [X] No custom Git worktree scheduler.
- [X] No custom distributed coding-agent protocol.
- [X] No custom vector memory store.
- [X] No custom memory retrieval engine.
- [X] No custom repository map initially.
- [X] No custom Tree-sitter indexing service initially.
- [X] No custom LLM observability platform.
- [X] No custom infrastructure-monitoring system.
- [X] No custom workflow state database.
- [X] No custom sophisticated agent router initially.

---

# 37. Revised Implementation Sequence

## Phase A — Finish Existing Cezar v0.1

- [X] Finish project override preservation.
- [X] Finish sync dry-run.
- [X] Finish project validation interface.
- [X] Add Factory CI.
- [X] Validate rollback.
- [X] Pilot existing planning/implementation/review loop; deterministic lifecycle evidence is recorded in `docs/pilot-loop-evidence.md`.

### Milestone

Current Factory work is stable and reproducible.

---

## Phase B — OpenHands Integration

- [X] Deploy Agent Canvas.
- [ ] Connect Codex. (Profile persistence and deployment are verified; the
  subscription-backed conversation still fails before the agent can run; see
  `docs/openhands-live-evidence.md`.)
- [ ] Connect Claude Code.
- [X] Test isolated parallel work.
- [X] Test remote Agent Server.
- [X] Connect Cezar → OpenHands.
- [X] Replace direct premium-agent execution with OpenHands. The routing
  policy and checked-in provider adapter now send non-local agents through
  OpenHands; live premium authentication remains a separate open gate.

### Milestone

Cezar controls work while OpenHands executes coding jobs.

---

## Phase C — vLLM

- [X] Deploy native vLLM on the Mac mini; keep the Bazzite control plane containerized.
- [X] Add general model.
- [X] Add coding model.
- [X] Benchmark both.
- [X] Secure service behind trusted network/reverse proxy; live evidence is recorded in `docs/vllm-live-evidence.md`.
- [X] Document model deployment.

### Milestone

Factory has a production-style local inference service.

---

## Phase D — LiteLLM

- [X] Deploy LiteLLM.
- [X] Connect vLLM.
- [X] Create virtual model names.
- [X] Enable health/fallback configuration.
- [X] Add dedicated persistent PostgreSQL backing for LiteLLM.
- [X] Connect Cezar utility workflows.

### Milestone

Local-model clients no longer depend directly on an individual model server.

---

## Phase E — Local Utility Work

Move to vLLM:

- [X] issue classification;
- [X] summaries;
- [X] acceptance-criteria extraction;
- [X] log compression;
- [X] result normalization;
- [X] Hindsight reflection candidates.

### Milestone

Premium agents mostly perform actual reasoning/coding.

---

## Phase F — Hindsight

- [X] Deploy Hindsight.
- [X] Add project banks.
- [X] Add Factory bank.
- [X] Connect MCP.
- [X] Add pre-plan recall.
- [X] Add investigation recall.
- [X] Add post-task retain/reflection.

### Milestone

Previous Factory/project discoveries are reused automatically.

---

## Phase G — Observability

- [X] Deploy Langfuse.
- [X] Instrument LiteLLM.
- [X] Add OpenTelemetry where useful.
- [X] Deploy Prometheus.
- [X] Deploy Grafana.
- [ ] Add GPU exporters (evaluated; waiting for a compatible AMD 680M telemetry stack; see `docs/gpu-exporter-evaluation.md`).
- [X] Add Podman/container monitoring.

### Milestone

We know where compute, time, and tokens are being spent.

---

## Phase H — Routing Optimization

Only after enough history exists:

- [X] Compare local-model success against subscription agents. (Mac mini
  `openai/qwen3.5-9b` direct and checked-in-adapter/worktree smoke tests pass;
  the adapter now records duration and coarse token usage; subscription side
  still fails before tool execution. The comparison result is recorded in
  `docs/openhands-live-evidence.md`.)
- [X] Identify task classes suitable for local inference.
- [X] Adjust deterministic routing policy.
- [X] Evaluate Aider for local implementation; defer adoption because OpenHands already provides the bounded local execution boundary.
- [X] Evaluate Continue only where useful; defer it because the current workflow is headless and has no editor-context requirement.
- [X] Consider more sophisticated routing only if justified; defer it until subscription-agent comparison data exists.

---

## Phase I — Multi-GPU / Multi-Node vLLM Learning

When hardware permits:

- [ ] Test multi-GPU tensor parallelism.
- [ ] Test multiple independent replicas.
- [ ] Compare throughput approaches.
- [ ] Deploy Ray.
- [ ] Test multi-node vLLM.
- [ ] Test node failure/recovery.
- [X] Capture deployment notes.
- [X] Capture monitoring lessons.
- [X] Capture model-loading/storage lessons.

### Milestone

The home Factory doubles as practical distributed-inference training.

---

# 38. Revised Near-Term Priority

The next work should therefore be:

```text
1. Finish the few remaining Cezar v0.1 tasks
               ↓
2. Prove OpenHands + Codex + Claude
               ↓
3. Integrate OpenHands into Cezar
               ↓
4. Deploy vLLM
               ↓
5. Move cheap tasks to local models
               ↓
6. Add Hindsight
               ↓
7. Add Langfuse + Grafana
               ↓
8. Measure
               ↓
9. Optimize routing
```

Do **not** spend significant effort on Aider, Continue, custom context compilation, advanced routing, or distributed inference until the core pipeline is operational.

---

# 39. Updated Success Criteria

The Factory is ready for broader rollout when:

- [ ] An issue can progress from `factory:needs-plan` to reviewed PR without manual orchestration.
- [X] Cezar remains the authoritative lifecycle controller.
- [ ] OpenHands reliably executes Codex/Claude coding work.
- [ ] Premium agents use existing subscriptions.
- [X] vLLM reliably handles local inference.
- [X] Bounded utility tasks run locally.
- [X] Tests return compact structured information.
- [X] Hindsight recalls useful prior project knowledge.
- [X] Factory/project upgrades remain versioned and reproducible.
- [X] Agent execution is isolated.
- [X] Failed work stops after configured limits.
- [X] Human intervention produces actionable context.
- [ ] Local and premium workload usage is observable. (Local adapter results
  now include duration, model, and coarse token usage; premium accounting is
  pending successful subscription transport.)
- [X] No major subsystem duplicates functionality already supplied by an integrated product.

---

# 40. Final Architecture Principle

The Factory should not become another giant orchestration framework.

Its own code should primarily answer:

```text
What work needs doing?
When should it run?
Which policy applies?
Which existing tool should perform it?
Did it succeed?
What should we remember?
```

Everything else should be delegated to products that already solve the problem well.

---

# 41. External completion gates

The remaining unchecked items are intentionally gated on external state, not
missing local implementation:

- Premium execution: create an authenticated ACP profile for Codex and Claude
  in OpenHands, then rerun the bounded issue, concurrent-worktree, and PR
  lifecycle checks.
- GitHub lifecycle: Bazzite Cezar CLI auth is configured and read-only verified
  (`docs/github-bazzite-live-evidence.md`); a real issue/PR lifecycle still needs
  a bounded end-to-end run. The workstation credential remains a separate path.
- Distributed inference: add a second GPU or node before attempting tensor
  parallelism, independent replicas, Ray, or failure-recovery experiments.
- Native client comparisons: revisit native Claude/other-client exploration
  only after credentials and a supported local-provider path are available.

Until those gates change, the authoritative local evidence and deployment
checks are complete and the corresponding checklist items remain open rather
than being marked complete by inference.
