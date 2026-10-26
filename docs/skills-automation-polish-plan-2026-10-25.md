Factory skills and automation polish — deterministic-first workplan
Status: In progress — implementation is partial; see evidence log (§11) and open acceptance criteria below
Audit date: 2026-10-25
Scope: Factory skills, workflows and automation definitions; Cezar workflow/runtime contracts; configured project verification; operational UI and telemetry.
Change policy: This plan is not permission to deploy, change schedules, remove safeguards, or bypass review. Implement through reviewed changes and existing approval/release gates.
1. Objective and definition of done
Increase useful accepted work per unit of cost while reducing agent calls that can be replaced by reliable deterministic operations. Improve workflow recovery, error diagnosis and project-specific verification without building a second scheduler, rules engine, or orchestration platform.

This initiative is complete when:
- [ ] Every agent invocation in the audited skills/workflows is classified as necessary reasoning, conditional reasoning, or replaceable deterministic work, with rationale and owner.
- [ ] Routine maintenance, validation, state transitions, scheduling/recovery and side-effect application use deterministic Cezar/Factory mechanisms where feasible.
- [ ] LLMs produce bounded, validated proposals; deterministic consumers own consequential API changes.
- [ ] Cezar distinguishes no-work, skipped, blocked, task failure, infrastructure failure, timeout and cancellation outcomes.
- [ ] Test commands are explicit by project; missing tests or tooling are never reported as passing.
- [ ] Agent selection honors capability, budget and subscription availability; lack of capacity does not masquerade as a coding failure.
- [ ] Replay tests and a measured pilot demonstrate no regression in accepted work or safety safeguards.
- [ ] Existing protections are retired only after equivalent replacement behavior is verified.
Progress rules
Check boxes only after acceptance criteria are demonstrated. For each completed task record issue/PR, commit, fixture or run ID, observed result, and date in the evidence log (§11). Record partial work as a dated blocker, not a checked box. Tasks below have stable IDs suitable for GitHub issue decomposition.
2. Existing audit evidence and limits
The original read-only audit covered 17 skills, 10 workflows, automation definitions, Cezar engine source and recent run metadata from three configured projects. These are audit findings, not freshly verified facts.
Latest 20 runs/project	Done	Failed	Running or queued	Sample creation window (UTC)
Blackjack/Godot	11	8	1	Oct 25, 04:00–14:00
Factory	13	6	1	Oct 25, 00:00–14:00
TableFlux animation pipeline	17	2	1	Oct 24, 19:00–Oct 25, 14:00


Across these 60 sampled records, 16 runs failed: 8 Codex 30-minute timeouts, 2 targeted-test failures, 6 other command failures. A done status does not prove an accepted issue/PR outcome. Samples cover different windows and are maintenance-heavy, so do not treat their aggregate failure rate as a controlled reliability baseline. The runs endpoint returned arrays although limit=20 did not bound responses; the auditor locally selected the latest 20. No raw baseline export was retained. Refresh and save bounded evidence before comparing outcomes.
Finding	Initial evidence	Target disposition
Watchdog response mismatch	watchdog-automations.ps1 reads .runs; live endpoint returned an array	Fix parsing with fixtures; reject malformed responses
Watchdog selection too broad	Age/status selection without reliable ownership or progress	Positive ownership, lease/heartbeat/deadline evidence
Independent housekeeping coupled to agent classification	workflows/maintenance.yaml serial dependency	Decouple independent paths
Overlapping recovery	Hourly maintenance plus separate stale-work refresh	Establish one authoritative owner, preserve existing schedules until migrated
Conflicting side effects	Plan skill and workflow both post; backlog skill changes labels	Agent proposes; one validated consumer acts
Test execution heuristics	test-full.ps1 / test-changed.ps1 discover and execute tests heuristically	Explicit project validation contracts
Prose substitutes for runtime guarantees	Repeated resolved-issue guidance; synthesized missing-result handoff	Engine preconditions, typed outputs and failure policy
Documentation drift	OpenHands/human-merge references alongside Cezar/current policies	Reconcile to observed supported behavior


Unknown root causes: Current timeout data does not establish whether providers, model choice, prompts, tool loops, context pressure or legitimate execution caused stalls. Diagnose from bounded traces rather than inferring causality.
3. Design principles and ownership
1. Deterministic first, LLM by exception. Check existing state, dependencies, coverage and capacity before agent invocation. Use rules for objective conditions, LLMs for ambiguous classification, planning, diagnosis and implementation.
2. Cezar owns execution: scheduler/leases, steps, budgets, cancellation, artifact lifecycle, retry policy, run receipts, conditional execution and UI observability. Extend its existing durable receipts, deduplication, revision checks and onFail.retryOn; do not introduce a parallel scheduler or claim system.
3. Factory owns domain policy: risk/approval rules, allowed labels/transitions, project verification configuration, task-specific skill instructions and review gates.
4. Agents propose, consumers apply. Agents may author changes in an isolated workspace, but API side effects such as labels, comments, issue transitions, PR creation/merge and releases require explicit workflow-owned validation and authorization. Review and approval gates remain independent.
5. Structured machine contracts: a typed outcome, reason code, artifacts and evidence for each step. No reliance on free-text handoffs where the platform can enforce a schema.
6. Bounded, inspectable execution: work is time/cost limited; original errors remain visible when cleanup also fails. Every agent receives a compact evidence package and can request more evidence through bounded mechanisms.
7. Local compute and economical execution: validation, orchestration, builds and routine checks run on user-controlled infrastructure, not compute-intensive GitHub Actions. GitHub remains suitable for repository records/PR and status integration.
8. Compatibility before removal: feature flag or stage migrations, replay existing edge cases, and retain rollback paths.
Execution path
Trigger → deterministic preflight → (no-work / skip / block / script / agent) → schema & policy validation → revision check → idempotent effect application → verification → durable receipt/report

Preflight: Verify ownership, issue/PR revisions, prior successful receipts, prerequisites, project config, runner health, capability and remaining budget. Agent dispatch occurs only if deterministic checks cannot decide or the task actually requires reasoning.

Outcome taxonomy (proposed, confirm against current Cezar enums):
Outcome	Meaning	Retry policy
SUCCESS	Contract met and required effects verified	Never retry completed effect
NO_WORK	No eligible work exists or already resolved	Normal terminal outcome
SKIPPED	Branch not applicable	Normal non-error outcome
BLOCKED	Waiting on permission, dependency, provider/subscription capacity	Defer/reschedule only under explicit policy
RETRYABLE_FAILURE	Transient infrastructure or known reparable failure	Bounded retry matching typed reason
PERMANENT_FAILURE	Invalid config, policy violation, unrecoverable command error	Stop/escalate
CANCELLED	User/policy cancellation with recorded reason	No implicit restart


Keep work verdict (tests fail due to patch) separate from execution outcome (test tool unavailable), and preserve fine-grained reason codes (e.g. provider_quota, tool_missing, schema_invalid, test_regression, lease_expired). Prefer explicit status mapping/versioning rather than rewriting historical records silently.
4. Agent-replacement inventory (deliver first)
[INV-01] Inventory every skill/workflow agent invocation — Owner: Factory. Dependency: none.
- [x] Enumerate 17 skills, 10 workflows and relevant automation definitions (refreshed against current source).
- [x] For each invocation record trigger, input, tool/model, output, side effects, configured frequency, average tokens/duration (when available), and task decision being made; missing live measurements are identified explicitly.
- [x] Assign disposition: deterministic, rules-then-agent, agent-essential, or investigate.
- [x] Identify overlapping configured triggers, workflow retry calls, and repeated prose guarantees; record potential savings as hypotheses, not measured results.
- [x] Produce a prioritized replacement matrix and proposed migration owner per invocation.
Acceptance: Every invocation has evidence-backed disposition; ambiguous cases are identified for review rather than aggressively replaced.
Activity	Preferred owner	Agent policy
Stale detection, lease validation and cancellation	Cezar	No LLM
Already-resolved and duplicate work checks	Cezar/Factory state query	No LLM
Housekeeping, stale refresh and routine summaries	Explicit scripts/reconciliation	No LLM
Artifact validation and conditional branches	Cezar schema/conditions	No LLM
Known failure/exit code classification and retry gating	Cezar policy	No LLM
Test selection and pass/fail interpretation	Project config and harness	No LLM
Applying labels, comments or workflow transitions	Factory deterministic consumer	No LLM
High-confidence objective backlog rules	Factory rules	No LLM
Ambiguous backlog classification	Bounded agent proposal	Conditional
Novel incident diagnosis	Bounded agent with logs/evidence	Conditional
Architecture, implementation, substantive review	Appropriate coding/review agent	Yes


[INV-02] Introduce rule-first escalation for backlog classification — Owner: Factory. Depends: INV-01, side-effect contract in FND-03.
- [ ] Specify small, high-precision rules using issue state, labels, linked PRs, dependency state, revision and known outcomes.
- [ ] Treat ambiguous cases as needs-agent-classification, not forced deterministic guesses.
- [ ] Have agent return typed label/decision proposal and rationale; do not apply labels in the skill.
- [ ] Record rule hit rate, escalations, false positives and manual overrides.
Acceptance: Replay fixtures show objective cases bypass the LLM; stale revisions and disallowed labels cannot be applied; subjective cases remain reviewable. Do not build a bespoke general-purpose rules engine.
5. Workstream A — Immediate Factory stabilization (Phase 1)
Tasks can start without Cezar schema changes unless noted.

[STB-01] Fix watchdog API response and protective filters — Owner: Factory.
- [ ] Parse the live top-level array and explicitly supported compatibility envelopes; reject malformed/unknown response shapes with a logged failure.
- [ ] Identify Factory-owned runs positively (not merely by age/status).
- [ ] Cross-check lease/heartbeat, runner state, progress and deadline; do not equate long elapsed runtime with a stall.
- [ ] Log decision, run ID, evidence, operator and cancellation reason; make repeated cancellation safe.
- [ ] Add fixtures for malformed input, unrelated work, stalled work and legitimate long-running work.
Acceptance: Only positively owned, demonstrably eligible runs can be cancelled; parsing failures never silently pass.

[STB-02] Diagnose representative timeouts and targeted-test failures — Owner: Factory, project maintainers.
- [ ] Collect bounded run evidence for representative 30-minute Codex timeouts and two sampled targeted-test failures.
- [ ] Categorize observed failure as provider stall, tool loop, context pressure, long legitimate work, task/test failure, harness issue, environment issue or unknown.
- [ ] Capture failed command, duration, last progress marker, provider response details (where available) and sanitized logs.
- [ ] Feed findings into timeout budgets, retry taxonomy and project verification; do not label inferred causes as observed.
Acceptance: Written diagnoses distinguish observed signals from hypotheses; unresolved cases remain explicitly unknown.

[STB-03] Split unrelated maintenance from agent decisions — Owner: Factory.
- [ ] Remove serial dependence of repository housekeeping and stale refresh on backlog classification.
- [ ] Declare dependencies explicitly; run independent tasks on separate failure budgets and receipts.
- [ ] Determine the single authoritative stale-refresh owner while leaving schedules unchanged until intentional cutover.
- [ ] Demonstrate repeated/overlapping triggers do not duplicate effects.
Acceptance: Agent classification failure cannot suppress independent maintenance; owner and deduplication are documented.

[STB-04] Remove conflicting instructions and reconcile docs — Owner: Factory. Depends for side effects: FND-03.
- [ ] Planner returns a plan artifact; only a designated workflow step posts it.
- [ ] Backlog audit proposes lifecycle changes; approved consumer applies them after state/revision checks.
- [ ] Reconcile catalog, shared-factory.md, release workflow, skill operations, active runner profiles and merge/review policies.
- [ ] Preserve independent reviewer and high-risk approval gates; avoid premature deletion of fallback safeguards.
Acceptance: Exactly one owner for each effect; docs reflect supported current architecture and do not contradict active policies.
6. Workstream B — Cezar execution contracts (Phase 2)
Gate: Review current Cezar step syntax and compatibility expectations before changing workflow schema. Introduce versioned contracts and migration fixtures.

[FND-01] Typed inputs, outputs and outcomes — Owner: Cezar.
- [ ] Support declared input/output schemas (reuse a standard validator instead of creating a schema language).
- [ ] Validate required inputs before dispatch and outputs before downstream consumers run.
- [ ] Add proposed typed outcomes and stable reason codes, mapping legacy statuses without breaking current consumers.
- [ ] Provide explicit NO_WORK, SKIPPED, and BLOCKED semantics with UI explanations.
- [ ] Reject malformed/missing output as an explicit contract failure, not a fabricated success.
Acceptance: Fixtures cover schema-valid, missing, malformed, no-work, blocked and backward-compatible cases; downstream steps never consume invalid required outputs.

[FND-02] Attempt-scoped artifact provenance and atomic publication — Owner: Cezar. Depends: FND-01.
- [ ] Identify artifacts by run/step/attempt; store source version or content hash when relevant.
- [ ] Publish outputs only when validated and committed; prevent partial/stale artifact consumption.
- [ ] Ensure retry consumers only use their intended attempt or an explicitly pinned prior artifact.
- [ ] Retain evidence needed for restart recovery and audit with bounded retention policies.
Acceptance: Replay of retries, crashes and concurrent runs never selects stale/foreign artifacts.

[FND-03] Idempotent deterministic side-effect consumer — Owner: Cezar primitives + Factory policy. Depends: FND-01, FND-02.
- [ ] Standardize proposed action shape: target, expected revision, allowlisted operation, normalized arguments, rationale and operation key.
- [ ] Re-check authorization, current state, policy and expected revision at commit time.
- [ ] Use stable idempotency keys and durable receipts for comments, labels, PR creation and other external effects.
- [ ] Reconcile ambiguous remote outcomes after a crash (query remote state before retry); avoid claiming impossible universal exactly-once semantics.
- [ ] Keep merges, release promotion and high-risk changes behind existing approval/review gates.
Acceptance: Simulated timeout/restart/retry and concurrent revision changes do not produce duplicated or unauthorized effects; ambiguous outcomes are surfaced for reconciliation.

[FND-04] Conditions, finalizers and restart reconciliation — Owner: Cezar. Depends: FND-01/02.
- [ ] Add or extend conditional steps to skip unnecessary agents based on typed preflight outputs.
- [ ] Run cleanup/finalizers after success, failure and cancellation under a bounded independent budget.
- [ ] Persist cleanup status and reconcile unfinished finalizers on restart.
- [ ] Preserve original failure in the record if cleanup also fails.
Acceptance: Replay scenarios cover resolved issue, empty candidate set, cancellation, failing cleanup and restart without accidental agent invocation or hidden failures.

[FND-05] Adopt contracts in Factory workflows — Owner: Factory. Depends: FND-01–04.
- [ ] Migrate planner, implementation, backlog audit and maintenance workflows incrementally.
- [ ] Replace missing-result repair scripts and repeated already-resolved agent prose only after equivalent platform semantics pass replay tests.
- [ ] Retain compatibility path and documented rollback for each converted workflow.
Acceptance: Existing success/error/recovery behavior is preserved or deliberately improved with measured evidence; superseded scripts have verified replacement coverage.
7. Workstream C — Budgets, failure policy and capability routing (Phase 3)
[RUN-01] Deadlines and one shared attempt budget — Owner: Cezar.
- [ ] Configure bounded step deadlines, overall run budget and retry/repair consumption limits.
- [ ] Distinguish deadline, idle/no-progress and user cancellation signals.
- [ ] Make budget enforcement durable through worker restart and nested retries.
Acceptance: Independent retry loops cannot exceed the aggregate budget; legitimate longer-running tasks are not terminated by a simplistic age heuristic.

[RUN-02] Failure taxonomy and onFail.retryOn adoption — Owner: Cezar + Factory. Depends: FND-01 and STB-02.
- [ ] Standardize error categories: work-verdict/test regression, configuration, missing command, authentication, provider unavailable/quota, transient transport, timeout, cancellation, malformed result.
- [ ] Use normalized exit/reason codes to drive existing onFail.retryOn, not natural-language speculation.
- [ ] Only re-invoke a coding agent for known agent-repairable work failures; escalate or defer infrastructure failures.
- [ ] Test bounded retry, stop and recovery receipts.
Acceptance: Provider quota and unavailable tools never trigger code-repair loops; every retry has a recorded reason and counted budget.

[RUN-03] Capability-aware model and subscription capacity routing — Owner: Cezar. Depends: RUN-01/02; coordinate with existing model-family work.
- [ ] Define requested capability tier and eligible model/runner families (including available local workers), not fixed model names in every workflow.
- [ ] Track subscription-specific windows (for example, five-hour and weekly), reset estimates, observed utilization and confidence/source of limit values.
- [ ] Where the subscription/provider exposes no reliable remaining quota, represent it as unknown; never manufacture precise balances.
- [ ] Preflight suitable capacity before dispatch; rank eligible options by ability, headroom, cost and policy, with configurable fallbacks.
- [ ] On unavailable capacity, return BLOCKED/deferred outcome without counting it as a patch failure; avoid tight polling or infinite retries.
- [ ] Record selected model, reason, fallback choice and capacity snapshot in run diagnostics.
Acceptance: Simulations demonstrate budget-window blocking, local-model substitution for suitable tasks, required-capability enforcement and graceful unknown-quota behavior. Reuse existing model-family work rather than implementing a competing router.

[RUN-04] Consolidate timeout/cancellation recovery in Cezar — Owner: Cezar then Factory. Depends: RUN-01/02, FND-03/04.
- [ ] Make terminal transitions and recovery receipts durable/idempotent.
- [ ] Compare Cezar behavior with external watchdog over timeout, cancellation, restart, stuck-run and long-running cases.
- [ ] Disable/retire redundant external watchdog actions only after parity and rollback are demonstrated.
Acceptance: No duplicate effects or lost terminal reasons across restart and repeated recovery attempts.
8. Workstream D — Explicit, baseline-aware project verification (Phase 4)
Can begin alongside stabilization; no need to wait for all Cezar contract changes.

[VER-01] Declarative project test entry points — Owner: Factory configuration + project maintainers.
- [ ] Configure actual supported commands for quick, targeted and full verification per project.
- [ ] Include command, working directory, prerequisites, timeout, evidence location and applicability rules.
- [ ] Delegate toolchain detail to project scripts (e.g., Godot parser/GdUnit/startup/E2E, Node tooling, Factory tests).
- [ ] Replace generic discovered-file direct execution as default; avoid guessing missing commands.
Acceptance: Configured projects execute their own toolchain consistently; missing commands/dependencies produce unavailable, not pass.

Illustrative contract (not finalized schema):
verification:
  quick:
    command: ./scripts/verify-quick.ps1
    timeoutSeconds: 120
  targeted:
    command: ./scripts/verify-changed.ps1
    timeoutSeconds: 600
  full:
    command: ./scripts/verify-full.ps1
    timeoutSeconds: 1800
[VER-02] Structured verdicts, focused selection and regression baselines — Owner: Factory/project harness + Cezar presentation. Depends: VER-01.
- [ ] Return pass, fail, skipped, unavailable, no-matching-tests with execution evidence and distinct machine-readable reasons.
- [ ] Map changed files to relevant tests using explicit project-owned rules; run focused tests during iteration and required broader gates before merge.
- [ ] Normalize diagnostic identity; compare results against a pinned baseline to separate existing defects from new defects.
- [ ] Track baseline provenance/expiry and prevent agents from silently expanding the accepted baseline.
- [ ] Define merge/review gate policy for pre-existing failures; never hide new regressions.
Acceptance: Fixtures cover known-old failure, new regression, removed failure, missing tools, zero matching tests, task failure and infrastructure failure; gates follow actual outcomes.

[VER-03] Cross-project fixture coverage — Owner: Factory. Depends: VER-01/02.
- [ ] Replay representative Node, Godot and Factory validation paths, including GDScript parse errors and GdUnit outcomes.
- [ ] Preserve bounded command output, timings and failing diagnostics for subsequent repair agents.
- [ ] Confirm no project verification uses compute-heavy GitHub Actions as an execution dependency.
Acceptance: Relevant project types have repeatable local fixtures and evidence-linked outcomes.
9. Workstream E — Skill simplification and operator visibility (Phase 5)
[OPS-01] Compact skill contracts and bounded agent context — Owner: Factory. Depends: inventory and replacement enforcement.
- [ ] Standardize each skill around purpose, prerequisites, bounded inputs, required judgment, output schema, escalation and forbidden side effects.
- [ ] Move execution guarantees to Cezar/Factory scripts, retaining useful domain reasoning.
- [ ] Prepare agent evidence bundles with task summary, changed files, pertinent errors, previous attempt context and explicit budget.
- [ ] Provide bounded on-demand evidence expansion; remove repeated full logs, redundant prompt boilerplate and conflicting fallbacks.
- [ ] Measure token use and outcomes before/after; don't strip useful architectural/project context solely for token savings.
Acceptance: Skills are shorter and internally consistent; replayed work remains correct and produces valid contracts.

[OPS-02] Effective configuration and failure observability UI — Owner: Cezar. Depends: FND/RUN schema as needed.
- [ ] Show resolved workflow/skill path, version/content hash and project overrides.
- [ ] Show effective runner/model/capability, capacity status, step/run deadlines, retries and terminal reason.
- [ ] Expose structured step results, artifact provenance, finalizer status, chosen recovery path and side-effect receipts.
- [ ] Distinguish NO_WORK, SKIPPED, BLOCKED and failures in task list/details; allow useful filtering and sorting by last execution and other columns.
- [ ] Align with existing Cezar UI work; do not duplicate model-family and quota dashboard implementation.
Acceptance: Operators can diagnose routine failure and provenance without reading raw logs; UI matches engine state and avoids false precision about quotas.

[OPS-03] Outcome, savings and quality metrics — Owner: Cezar telemetry + Factory reporting.
- [ ] Record each planned/actual agent call and reason, calls avoided through preflight/rules, tokens where measurable, run time, retries and human recovery.
- [ ] Track issue → reviewed PR → accepted/merged outcome separately from housekeeping done or NO_WORK.
- [ ] Track pickup latency, failure classification, timeout share, cost per accepted outcome, rule escalation/override and novel-regression escape rate.
- [ ] Use deterministic reporting from structured records; reserve LLM narrative summaries for genuinely explanatory analysis.
Acceptance: Pilot dashboard contrasts comparable work categories and makes reduced token use visible without hiding reduced throughput or quality.
10. Implementation order, dependencies and pilot
Suggested delivery slices
Slice	Work items	Prerequisite / release gate
0 — Preserve baseline	Baseline capture below, INV-01	None; audit only
1 — Immediate reliability	STB-01, STB-02, STB-03; safe portions of STB-04	Independent fixture review
2 — Deterministic classification and contracts	FND-01–04, INV-02, remaining STB-04	Versioned schema and effect-policy review
3 — Factory migration	FND-05	Replay prior success/failure/restart fixtures
4 — Runtime economics	RUN-01–04	Bounded retries; compatibility and quota-unknown tests
5 — Project verification	VER-01–03 (start early in parallel)	Actual project toolchain review; regression gate tests
6 — Skill/UI refinement	OPS-01–03	Enforcement exists before removing old safeguards
7 — Pilot and rollout	Pilot checklist below	Independent review, release gates and rollback


Baseline and evaluation
- [x] [PIL-01] Export a bounded, timestamped baseline of runs and artifacts (metadata plus sanitized diagnostic evidence). Record query parameters, sample windows, source version, project mix and missing data.
- [x] [PIL-02] Pre-register comparison sample size, selection rules, work mix and acceptance targets. Do not compare non-equivalent maintenance-heavy and implementation-heavy periods as if they were randomized.
- [ ] [PIL-03] Track proposed initial targets to validate, not promised gains: ≥50% reduction in classified avoidable LLM calls, zero observed duplicate side effects in replay/pilot, <5% unclassified failures, ≥25% reduction in measured cost per accepted outcome without lower useful acceptance or bypassed review. Adjust targets explicitly if baseline evidence makes them unrealistic.
- [ ] [PIL-04] Replay success, no-work, malformed output, stale artifacts/revisions, ambiguous remote effect result, subscription capacity exhaustion, infra failure, work failure, legitimate long execution, timeout, cancellation, cleanup error and restart.
- [x] [PIL-05] Choose one explicitly configured pilot project with representative workflow mix; record why, as well as required high-risk approvals.
- [ ] [PIL-06] Measure accepted outcomes, LLM invocations avoided, token consumption, cost, latency, manual intervention, unknowns and adverse effects; compare with baseline and record confounders.
- [ ] [PIL-07] Obtain independent review; address blocking findings and preserve current merge/risk gates.
- [ ] [PIL-08] Commit and push changes through reviewed PRs targeting dev; request auto-merge only after required gates.
- [ ] [PIL-09] For Factory changes, run factory-release / factory-finish-release, promote only the tested merged commit, and verify configured-target synchronization plus Bazzite/runtime parity.
- [ ] [PIL-10] Document rollback (configuration, schema migration, schedules, old safeguards); expand only to explicitly configured targets, verifying each one.
- [ ] [PIL-11] Retire superseded recovery scripts/prose only after demonstrated parity; archive evidence and update this workplan with remaining limitations.
Pilot selection (PIL-05): Select `blackjackandhookersgadot` from the host-local configured registry. It is the only target with an explicit `projectType: godot`, so it can exercise the Godot verification path alongside shared issue workflows. Its baseline sample has 20 runs and 16 enabled automation definitions; the sample is maintenance-heavy and contains only one targeted-test failure, so it does not meet the 20 eligible issue-outcome comparison requirement. Treat this selection as preparation only: verify the project's actual test command and Cezar revision before any pilot run. Required high-risk gates are human plan approval and independent review before auto-merge; side-effect replay must pass before enabling affected automations. No schedule or target configuration is changed by this selection.
Stop/rollback triggers
Pause expansion and revert the affected slice if tests/receipts reveal unauthorized or duplicate external effects, regression gates are bypassed, accepted work falls materially without explanation, jobs indefinitely cycle on provider limits, a new failure mode loses provenance, or a release cannot be traced to a tested commit. Record precise trigger, affected version and restoration result.
11. Decision and evidence log
Date	Item	Decision / observed result	Evidence (issue, PR, fixture, run, commit)	Next action
2026-10-25	Initial audit	Reliability and ownership before prompt tuning; initial read-only audit only	Original audit summary	Refresh baseline
2026-10-25	Platform boundary	Extend existing Cezar leases, receipts, deduplication, revision checks and onFail.retryOn	Original source inspection summary	Review current supported contracts
2026-10-25	Design proposal	Deterministic preflight, agent proposals, verified effects and capability-aware routing	This workplan; not yet implemented	Review and decompose into issues
2026-10-25	INV-01 complete (source inventory)	Current source inventory covers all 17 skills, 10 workflows, 14 automations, all workflow agent calls, source-configured profiles/triggers, side-effect owners, dispositions, and a prioritized replacement matrix. Live enablement, actual run frequency, token/duration aggregates, and accepted outcomes are unavailable from source and remain baseline work under PIL-01.	`docs/agent-invocation-inventory.md`; `scripts/audit-factory-failures.ps1` call-graph inspection	Capture bounded per-project run evidence under PIL-01 before measuring savings or rollout
2026-10-25	STB-04 partial	Removed planner skill instructions that assigned issue posting and lifecycle routing to the agent; `factory-plan` workflow owns validation, posting, sub-issue creation, and state routing. Backlog audit effect ownership and documentation reconciliation remain open.	`skills/factory-plan/SKILL.md`; `workflows/plan.yaml` source inspection	Add and review a validated deterministic backlog-audit effect consumer before removing agent side effects
2026-10-25	FND-01 partial	Added an optional discriminated run outcome with stable reason codes, conservative legacy mapping, terminal defaults, and clearing on resume. The API contract and persisted RunRecord share the same schema value; the task header explains outcome kind/reason. This still lacks workflow input/output schemas and NO_WORK/SKIPPED execution semantics. Runtime emits BLOCKED for unanswered human input, TIMEOUT for idle closure, and typed task/infrastructure failures only where `onFail.retryOn` supplies the distinction; other failures remain unclassified.	cezar/packages/contract/src/runs.ts; cezar/packages/cezar/src/runs/store.ts and store.test.ts; cezar/packages/web/src/lib/attention.ts and attention.test.ts; `npm exec vitest run src/server/contract-parity.runs.test.ts src/runs/store.test.ts` passed (145 tests); check-failure outcome fixtures passed (3 tests); web targeted tests passed (158 tests); Cezar and web typechecks passed	Add step output contracts and workflow execution semantics for no-work, skip, block, and failure categories with replay fixtures
2026-10-25	FND-01 partial	Added optional JSON Schema input/output declarations to mirrored workflow contracts. Each step now validates `{task, outputs}` before dispatch; valid check JSON output is contract-validated before success, malformed output fails explicitly, and later checks/agents receive only successful prior outputs. Input/output values are persisted with attempt identity and SHA-256 integrity metadata; downstream consumption rejects corrupted current-attempt artifacts. Stored structured values pass through the existing secret scrubber. NO_WORK/SKIPPED execution semantics and full replay fixtures remain outstanding. The package typecheck's contract-inlining postbuild remains sandbox-blocked (esbuild cannot read the checkout parent), while direct server/contract TypeScript checks succeed.	cezar/packages/contract/src/workflows.ts; cezar/packages/cezar/src/workflows/types.ts, run.ts, json-contract.test.ts, runs/store.ts and store.test.ts; `npx tsc --noEmit -p packages/cezar/tsconfig.json`; four targeted Vitest files passed (150 tests)	Add explicit NO_WORK/SKIPPED execution semantics, UI explanations and end-to-end replay fixtures
2026-10-25	FND-01 partial	Added typed check-output controls: `no_work` settles with a no-work outcome and skips remaining steps; `skip_step` records its reason and proceeds; `blocked` terminates with a typed blocked reason. The step rail exposes persisted skip reasons. Pure contract and UI fixtures pass. Runtime replay fixtures are present but skipped in this sandbox because Windows process restrictions deny spawning the engine's `bash` check runner; run them on a supported Cezar host before claiming execution replay coverage. Other FND-01 gaps remain around agent-produced outputs, reason-specific failure taxonomy and legacy/restart replay.	cezar/packages/contract/src/runs.ts; cezar/packages/cezar/src/workflows/types.ts, run.ts, json-contract.test.ts, workflow-control.test.ts; cezar/packages/cezar/src/runs/store.ts; cezar/packages/web/src/routes/task-thread/step-rail.tsx and step-rail.test.tsx; direct Cezar/contract TypeScript checks and targeted Vitest (34 passed, 3 execution tests skipped)	Run execution replay fixtures on Linux/Bazzite; add failure and legacy migration cases, then continue FND-02 to FND-05
2026-10-25	FND-01 partial	Contract mismatch and malformed/missing output now produce a distinct `contract_failure` outcome with stable input/output reason codes instead of a generic task failure. Added typed contract-failure wording in the attention explanation, plus helper fixtures distinguishing invalid schema from invalid values. Cezar, contract and web typechecks pass; contract parity and UI tests pass. End-to-end control replay remains skipped by the local Windows bash process restriction.	cezar/packages/contract/src/runs.ts; cezar/packages/cezar/src/workflows/types.ts and run.ts; cezar/packages/web/src/lib/attention.ts and attention.test.ts; targeted Cezar/contract/web Vitest and `tsc --noEmit`	Complete FND-01 replay and backward-compatibility matrix, including restart and legacy rows
2026-10-25	RUN-02 partial	Added optional exit-code-to-category mappings on check steps for work verdict, test regression, configuration, missing command, authentication, provider unavailable/quota, transient transport, timeout, cancellation, malformed result and unknown. With taxonomy configured, only mapped work-verdict/test-regression codes and explicitly retryable exit codes may loop to an agent; other mapped causes stop with typed task, infrastructure, timeout or cancellation outcomes. Omitted taxonomy retains existing numeric retry behavior. Pure policy tests and mirrored contract checks pass; end-to-end retries remain unverified in this sandbox's denied-bash environment. Existing Factory workflows have not yet adopted the mapping.	cezar/packages/contract/src/workflows.ts and runs.ts; cezar/packages/cezar/src/workflows/types.ts and check-failure-outcome.test.ts; `npx tsc --noEmit` and targeted Vitest passed	Add retry/restart execution fixtures on Linux; adopt failure maps in configured verification workflows after STB-02 evidence
2026-10-25	FND-03 partial / STB-04 partial	Backlog-label collection is read-only. A pre-agent deterministic consumer validates source snapshots, ensures the taxonomy, applies static classifications and reserves the at-most-three ambiguous candidates; the agent receives only their bodies and writes a candidate-only proposal. The post-agent consumer requires same-batch preparation receipts, validates the complete proposal before writes, rechecks all candidate states, applies and verifies allowlisted labels, and persists a receipt report after each verified issue. Preparation retries recognize applied labels/comments without duplicating the reservation marker; final retries recognize applied labels. Other external effects, hard crash recovery between remote effects and receipt writes, and overlapping-run concurrency guarantees remain open.	scripts/audit-backlog-labels.ps1; scripts/apply-backlog-label-audit.ps1; workflows/maintenance.yaml; skills/factory-backlog-label-audit/SKILL.md; `pwsh -NoProfile -File tests/run-tests.ps1` passed (including collector/prepare/apply retry fixtures)	Add crash-injection and overlapping-run fixtures; extend the same authorization/revision/idempotency pattern to remaining Factory effects
2026-10-25	STB-01 partial	Watchdog now accepts the live array and explicit compatibility envelopes, logs decisions, positively filters Factory issue workflows, rechecks before cancellation, and requires expired lease/runner/heartbeat/progress/deadline evidence. Fixtures cover malformed input, unrelated work, a stalled run, and a long-running active run. The current Cezar run record does not expose the required liveness fields, so live cancellation parity is not demonstrated.	`tests/fixtures/watchdog-runs*.json`; `scripts/watchdog-automations.ps1`; full `tests/run-tests.ps1` passed; local Cezar `runs/store.ts` schema inspection	Add a versioned Cezar liveness contract and replay against actual runtime records before treating watchdog cancellation as operational
2026-10-25	STB-02 partial	Bounded latest-20-per-project export and read-only detail/history inspection covered all 13 failed terminal runs. Eight persisted errors report codex app-server timed out after 30m and was killed; each lasted about 1800 seconds, and event history showed activity within roughly 0.3–7.5 minutes before termination. These signals do not establish provider stall, tool loop, context pressure, or legitimate long work; classify cause as unknown. Five other failures show command/environment or harness evidence: targeted tests reported a missing .ai/factory/factory.config.yaml; two reservation recovery checks lacked valid API/project inputs; failure-audit rejected an invalid API URL; TableFlux startup could not locate a required script. Runtime revision and host checkout parity remain unverified because SSH key/config access was denied in this environment.	Sanitized export under .factory/skills-polish-baseline-2026-10-25/final/; bounded read-only run detail/history queries; 2026-10-25	Inspect the explicitly configured Bazzite checkout through an authorized SSH session; sample two targeted-test failures per plan and align retry taxonomy only after runtime/source parity is established
2026-10-25	PIL-01 complete	Captured 20 latest run records per explicitly configured project and 20 recent GitHub Actions runs at a timestamped snapshot. The report records query, source commit/version, project windows and mix, status/step failures, token/duration coverage, cost coverage, and unavailable outcomes; diagnostic details are limited to sanitized step signatures.	`docs/skills-automation-baseline-2026-10-25.md`; local bounded export under `.factory/skills-polish-baseline-2026-10-25/final/`; refreshed `scripts/collect-environment-state.ps1`	Collect bounded diagnostic traces for STB-02; verify Cezar runtime revision before pilot comparison
2026-10-25	PIL-02 complete	Pre-registered latest-20-per-target selection, terminal versus in-progress reporting, workflow/work-type stratification, matched category comparison, and minimum 20 eligible terminal issue outcomes per baseline and pilot window. The baseline is maintenance-heavy and does not itself establish accepted-outcome coverage.	`docs/skills-automation-baseline-2026-10-25.md`, Comparison protocol proposal	Instrument accepted PR outcomes and cost coverage before evaluating PIL-03 thresholds


2026-10-25	INV-02 partial / STB-04 partial	Backlog collector classifies only explicit legacy state markers and unambiguous legacy type labels before escalating ambiguous issues. It now records stable rule IDs and bounded counts for eligible issues, rule hits, ambiguity, and selected escalations. Updated the skill to reflect current collector/preparation ownership and removed contradictory script instructions. False-positive and manual-override rates still require outcome feedback; linked PR/dependency/revision rules remain unimplemented.	scripts/audit-backlog-labels.ps1; skills/factory-backlog-label-audit/SKILL.md; tests/run-tests.ps1 fixture assertions	Add feedback-based override accounting and revision/linked-work evidence before expanding deterministic rules

2026-10-25	VER-01 partial	Added explicit quick/targeted/full validation contracts with working directory, prerequisites, timeout, evidence location and applicability. The Factory verification runner executes only the project-declared command; missing commands or prerequisites return `unavailable`, nonapplicable checks return `skipped`, timeout/nonzero return `failed`, and no test discovery remains in the targeted/full wrappers. Fixtures cover declared success, nonzero failure, missing command/prerequisite, diagnostic redaction and timeout. Acceptance remains partial because the explicitly configured remote projects have not yet provided or verified their actual project-specific command contracts.	templates/factory.config.yaml; scripts/factory/run-verification.ps1; scripts/factory/test-changed.ps1; scripts/factory/test-full.ps1; workflows/implement.yaml; workflows/fix-review.yaml; `tests/run-tests.ps1`	Verify actual commands and prerequisites in each configured project checkout; add structured no-matching-tests and baseline verdicts under VER-02
2026-10-25	VER-02 partial	Project verification commands now declare JSON output and return structured `passed`, `failed`, `skipped`, `unavailable`, or `no_matching_tests` verdicts with stable reason codes. The runner rejects malformed output, preserves project evidence/reason/category, and normalizes categories to workflow exit codes; only test-regression/work-verdict code 1 may re-invoke the coding agent. Applicable check schemas consume successful JSON results and `skipped` uses Cezar's typed `skip_step` control. Fixtures cover no matching tests, malformed output, and skipped output. Diagnostic identity normalization, pinned baseline comparison/provenance and multi-project replay remain outstanding.	scripts/factory/run-verification.ps1; workflows/implement.yaml; workflows/fix-review.yaml; `pwsh -NoProfile -File tests/run-tests.ps1` passed; automation catalog valid (10 jobs); Factory workflow YAML parsed with output schemas and retry maps; `git diff --check` clean; Cezar category/control mapping source	Implement diagnostic identity and pinned baseline policy; replay old/new failures across the project-owned Node/Godot/Factory fixtures
2026-10-25	RUN-02 partial / VER-01 partial	Implementation, full-verification and review-fix test steps now declare normalized exit outcomes and retry only exit code 1 (`test_regression`). Missing project commands/prerequisites, invalid configuration, timeout and non-applicable checks do not loop back to a coding agent. The policy is source-configured and fixture-covered, but live workflow execution and project-specific exit semantics remain unverified until runtime parity and actual project commands are established.	workflows/implement.yaml; workflows/fix-review.yaml; scripts/factory/run-verification.ps1; Cezar check failure policy tests	Validate these YAML definitions with the deployed Cezar runtime; adopt the same mapping in other test-bearing workflows after confirming each command's exit semantics

2026-10-25	FND-02 partial	Structured check artifacts now retain run/step identity, attempt number, content digest and producing workflow-step digest. Consumers expose only completed outputs for the current attempt and matching step definition; stale attempts are ignored and current-attempt corruption/source mismatch fails closed with `artifact_integrity_failed`. After output validation, Cezar commits the successful step and output together before advancing. The shared run-index lock serializes current cockpit/headless read-merge-write cycles; stale lock recovery checks the recorded PID and atomically renames abandoned locks. Output retention is bounded by existing limits of 300 active and 500 archived runs and the 20,000-character check output cap. Reopen, redaction, stale-attempt, corruption, source-mismatch and dead-owner lock-recovery fixtures pass. A cross-process stress fixture could not run here because child `node --import tsx` exits at `uv_os_get_passwd ENOMEM`; supported-host crash/restart and concurrent-run replay are still outstanding.	cezar/packages/cezar/src/workflows/structured-artifacts.ts and structured-artifacts.test.ts; runs/store.ts and store.test.ts; workflows/run.ts; contract/src/runs.ts; targeted Cezar Vitest (156 passed) and typecheck; web attention test (55 passed); Factory `tests/run-tests.ps1` passed	Add supported-host restart/crash/concurrency replay and focused cross-process lock tests before claiming FND-02 acceptance

2026-10-25	OPS-02 partial	The expanded workflow step rail now exposes persisted structured check output only when a content digest is present, with attempt number, full content digest and producing-step digest. The JSON body is collapsed by default and bounded to a scrollable panel; legacy output lacking integrity metadata is withheld. The task header now shows cleanup running, complete, or failed, including the cleanup error while preserving the separate run outcome. Effective model/capacity/deadline configuration, recovery-path details, effect receipts and filtering remain open.	cezar/packages/web/src/routes/task-thread/step-rail.tsx and step-rail.test.tsx; run-header.tsx and run-header.test.tsx; focused web Vitest (133 prior checks; finalization UI 3 passed); web `tsc --noEmit` passed	Continue OPS-02 with effective configuration, recovery/effect observability and filtering after corresponding engine contracts land

2026-10-25	FND-04 partial	Workflow steps can now declare `when` as standard JSON Schema over `{ task, outputs }`. Cezar evaluates it after verifying prior artifact integrity and before input validation or dispatch. A value mismatch persists `skipped` with `precondition_not_met`; invalid schemas fail workflow definition validation and map defensively to a typed contract failure if encountered at runtime. A persisted runtime fixture showed run `0e9733e4-f124-4c56-a7d7-3e0bec07da36` completing with the conditional agent step skipped, zero iterations/tokens, and no session id. Finalizers, independent cleanup budgets, durable cleanup receipts and restart reconciliation remain open. The focused test process did not emit its test summary before interruption; broader Cezar tests hit platform-dependent failures, including Windows shell spawn `EFTYPE`.	cezar/packages/cezar/src/workflows/types.ts and json-contract.test.ts; workflows/run.ts and run.test.ts; contract/src/workflows.ts and runs.ts; docs/cezar-integration.md; focused helper Vitest (11 passed, 3 execution tests skipped); `tsc --noEmit -p tsconfig.json` and contract typecheck pass; `tsconfig.test.json` typecheck reports contract-parity errors; persisted run record cited above	Add finalizer persistence/restart semantics and replay resolved issue, empty candidate, cancellation and cleanup-failure cases before FND-04 acceptance

2026-10-25	FND-05 partial	The implementation workflow's resolved-issue preflight now declares an output schema and returns Cezar's typed `no_work` control after the deterministic lifecycle reconciliation and marker write. Cezar can therefore skip the remaining implementation steps for an already-resolved issue. The agent-side marker instruction remains as a fallback for older runtimes; revert this step's `outputSchema` plus the preflight `$cezar` field to roll back the migration. Other planner, backlog and maintenance conversions remain open.	scripts/check-already-resolved.ps1; workflows/implement.yaml; tests/run-tests.ps1 resolved issue fixtures; full Factory `tests/run-tests.ps1` passed	Migrate the next workflow only after runtime replay coverage is available; preserve existing paths until then

12. Source pointers from original audit
The paths below are retained as source pointers reported by the original audit, not reverified against current repository content.
- Cezar workflow step schema/retry filtering: ../cezar/packages/cezar/src/workflows/types.ts
- Cezar workflow engine: ../cezar/packages/cezar/src/workflows/run.ts
- Cezar automation store/leases: ../cezar/packages/cezar/src/automations/store.ts
- Watchdog: ../scripts/watchdog-automations.ps1
- Maintenance: ../workflows/maintenance.yaml
- Planner skill: ../skills/factory-plan/SKILL.md
- Backlog label audit skill: ../skills/factory-backlog-label-audit/SKILL.md
- Implementation handoff repair: ../scripts/ensure-implementation-result.ps1
- Targeted verification: ../scripts/factory/test-changed.ps1
- Full verification: ../scripts/factory/test-full.ps1
- Automation catalog: ../routing/automation-catalog.json
- Shared Factory delivery: shared-factory.md
- Cezar skill operations: ../skills/factory-cezar-skill-operations/SKILL.md
Implementation note: The original audit and this revision propose work; neither verifies current live engine functionality or authorizes changes to active automations. Before opening implementation PRs, inspect existing Cezar contracts and reconcile with related model-family, subscription-limit, UI, and delivery issues to avoid duplicate work.

2026-10-25	STB-03 partial / FND-05 partial	Moved stale-work refresh and repository housekeeping ahead of backlog classification so an agent failure does not suppress independent deterministic maintenance. Added structured resolved-preflight output contracts and `when` conditions to planner and investigator follow-up steps; unresolved issues continue normally and resolved issues terminate through Cezar no-work semantics. Full Factory fixture suite and Cezar server, contract-parity, and web TypeScript checks pass. Actual Cezar runtime replay remains subject to the Windows process limitation recorded above.	workflows/maintenance.yaml; workflows/plan.yaml; workflows/investigate.yaml; tests/run-tests.ps1; docs/workflow-map.md; `pwsh -NoProfile -File tests/run-tests.ps1` passed; Cezar `tsc --noEmit` server/test/contract checks passed	Replay planner/investigator no-work behavior against deployed runtime; establish independent workflow receipts or separate failure budgets without changing configured schedules

2026-10-25	FND-04 partial / FND-05 partial	Added workflow conditions and output contracts to the Godot upgrade automation. Stage/apply/baseline tests now require a new stable upgrade; the repair agent and second test run require a failed baseline; publish requires passing baseline or post-fix tests. This removes the unconditional daily agent invocation and avoids asking the agent to self-classify no-op cases. Factory full suite passed; Cezar JSON Schema condition tests passed (6); four changed workflow files parsed with the YAML parser; Cezar server, parity, and contract typechecks passed. Live runtime replay and finalizer/restart coverage remain open.	workflows/godot-upgrade.yaml; docs/agent-invocation-inventory.md; tests/run-tests.ps1; `pwsh -NoProfile -File tests/run-tests.ps1`; `npx vitest run src/workflows/json-contract.test.ts`; YAML parse; Cezar `tsc --noEmit` checks	Add supported-host runtime replay for no-upgrade, passing baseline, failed baseline, fix pass/fail and restart; implement bounded durable finalizers before claiming FND-04

2026-10-25	INV-02 partial / FND-04 partial / FND-05 partial	Backlog-label preparation now emits a compact output contract after deterministic classifications and reservations are applied. With zero ambiguous candidates it returns a validated Cezar no_work control, so the hourly audit agent and proposal consumer are skipped. Added a zero-candidate fixture that confirms static classifications remain applied and the reservation agent is bypassed. Factory full suite passed; JSON Schema/condition integration probe was blocked by Windows Node `uv_os_get_passwd ENOMEM` before test execution.	scripts/apply-backlog-label-audit.ps1; workflows/maintenance.yaml; docs/agent-invocation-inventory.md; tests/run-tests.ps1; `pwsh -NoProfile -File tests/run-tests.ps1` passed	Replay Cezar no-work control on supported runtime and instrument eligible-call/override rates before marking deterministic classification accepted

2026-10-25	FND-05 partial	Added a resolved-preflight output contract to fix-review so the existing typed no_work control is validated and terminates before routing or invoking the repair agent. Planner and investigator follow-up steps have explicit `when` conditions; implementation, plan, investigation, and fix-review now all consume the same deterministic resolved signal. Factory full suite passed after workflow contract and maintenance no-candidate fixture additions; five affected workflow YAML files parse.	workflows/implement.yaml; workflows/plan.yaml; workflows/investigate.yaml; workflows/fix-review.yaml; workflows/maintenance.yaml; workflows/godot-upgrade.yaml; tests/run-tests.ps1; `pwsh -NoProfile -File tests/run-tests.ps1` passed	Run Cezar-supported-host replay for resolved preflight and conditional maintenance/Godot workflows; finish migration of other planner, maintenance, and result-repair paths with restart and legacy coverage

2026-10-25	RUN-02 partial / VER-01 partial	Godot test results now include normalized status/category fields. The project config can declare `godot.testRegressionExitCodes` (default `[1]`); only those failures map to retryable code 1. Missing test commands map to code 4 (`missing_command`), and undeclared nonzero exits map to code 10 (`unknown`), neither of which loops to the repair agent. Blank commands are normalized to missing rather than accidentally executing as a successful whitespace command. Added fixtures for declared regression, unknown failure, missing command, and the template contract. `pwsh -NoProfile -File tests/run-tests.ps1` passes; workflow YAML parses.	scripts/godot-upgrade.ps1; workflows/godot-upgrade.yaml; templates/factory.config.yaml; tests/run-tests.ps1; docs/agent-invocation-inventory.md	Verify the configured Godot command and regression exit codes in each actual Godot target; add bounded timeout and supported-runtime replay

2026-10-25	PIL-05 complete (selection only)	Selected configured `blackjackandhookersgadot` as the Godot pilot candidate because it has explicit project type and exercises both project verification and shared issue workflows. Recorded the baseline sample limitation, required command/runtime validation, high-risk human plan approval and independent review gates, and the no-schedule-change boundary.	`config/factory-projects.json`; `docs/skills-automation-baseline-2026-10-25.md`; Pilot selection section	Verify the target-owned Godot test command and runtime revision before any pilot; meet the matched issue-outcome sample size

2026-10-25	FND-04 partial	Workflow finalizers now form a validated, command-only suffix with a required timeout capped at 300 seconds. Cezar skips them during the ordinary step loop, durably records terminal intent and per-step state before running them, continues through cleanup failures, preserves the original failure, and marks successful workflows failed if cleanup fails. Restart recovery resumes unfinished finalizers without replaying agent steps; a missing isolated worktree fails closed, while explicit in-place runs use the repository root. No-work and cancellation both reach cleanup while retaining their distinct terminal outcomes. Added a distinct cleanup_failed outcome. Focused Cezar orchestration replay: 6 tests passed (success, cleanup failure, no-work, cancellation and restart); server/test/contract type checks pass. Direct node --import tsx --test remains blocked before discovery by Windows uv_os_get_passwd ENOMEM. Process spawning for a real shell finalizer is denied in this environment, so timeout/OS process termination still needs a supported-host replay.	cezar/packages/cezar/src/workflows/run.ts; run.test.ts; types.ts; runs/store.ts; workflow-types.test.ts; contract runs.ts and workflows.ts; focused Vitest (6 passed); all three Cezar/contract type checks; git diff --check	Replay bounded timeout and cancellation during startup on a supported runtime; inspect process-tree termination and run supported-host crash/restart scenario before accepting FND-04

2026-10-25	STB-01 partial	Current source implements top-level array and explicit compatibility-envelope parsing, rejects malformed shapes, positively identifies Factory workflows and issue ownership, and requires stale runner, expired owned lease, stale heartbeat/progress, and expired deadline evidence. It re-reads run state immediately before cancellation and records operator, decision, reason and evidence. Fixtures cover an eligible stalled run, unrelated run, legitimate long-running run, legacy record missing liveness fields and malformed payload. Factory full validation passed. Live Cezar records in the bounded baseline do not expose the required liveness fields, so eligible cancellation and live repeated-cancel behavior cannot be demonstrated; such records are skipped by design.	scripts/watchdog-automations.ps1; tests/fixtures/watchdog-runs*.json; watchdog fixtures in tests/run-tests.ps1; pwsh -NoProfile -File tests/run-tests.ps1 (ALL PASSED); bounded baseline	Instrument the required runtime liveness fields and add a mocked API cancellation/re-read replay before marking STB-01 complete

2026-10-25	FND-04 hardening	Finalizer definitions now enforce a 300-second maximum across the entire cleanup suffix. On POSIX, timeout sends SIGTERM to the detached command process group and SIGKILL after a one-second grace period; Windows terminates the direct shell process with the same bound. Cezar and test type checks plus the focused six-test workflow replay pass. A real process timeout replay remains pending because this environment denies shell process creation.	cezar/packages/cezar/src/workflows/types.ts and run.ts; workflow-types.test.ts; run.test.ts; Cezar/contract typechecks; focused Vitest (6 passed)	Verify process-tree timeout behavior on a supported POSIX host and test Windows direct-child timeout in the installed runtime

2026-10-25	FND-04 restart idempotency	Finalizers must now explicitly declare idempotent: true. Recovery retries a step left running by interruption (the command outcome is ambiguous), resumes later cleanup after completed steps, and does not rerun a failure already durably recorded. Added restart replay proving a persisted cleanup failure is not invoked twice and is surfaced as cleanup_failed without changing the original success intent. Focused workflow replay: 7 passed; server, test and contract type checks pass. Real process timeout remains unverified on this host.	cezar/packages/cezar/src/workflows/types.ts and run.ts; contract/src/workflows.ts; run.test.ts; workflow-types.test.ts; focused Vitest (7 passed); Cezar/contract typechecks	Verify ambiguous-running finalizer replay with an idempotent real command on supported runtime; review schema compatibility and downgrade behavior

2026-10-25	FND-04 receipt security	Finalization receipt error fields pass through the same registered-secret redaction as top-level and step errors before persistence or UI emission. Added a store test proving both the original error and cleanup error are scrubbed in memory and runs.json. Focused store replay: 1 passed; test typecheck passes.	cezar/packages/cezar/src/runs/store.ts and store.test.ts; focused Vitest (1 passed); Cezar test typecheck	Include nested finalization fields in backward-compatibility fixture review

2026-10-25	STB-04 partial	Marked the old marching-orders, status snapshot, and delivery-redesign documents as historical proposals; updated the former's execution owner from OpenHands to Cezar and its pilot/merge wording to current independent-review plus dev auto-merge gates. Preserved the prior live evidence as historical data. Current active OpenHands/human-merge conflicts in these documents are explicitly superseded rather than presented as operating instructions.	 docs/factory-automation-marching-orders.md; docs/factory-automation-status.md; docs/factory-delivery-redesign.md; rg review of current policies and workflow ownership	Complete the remaining active-doc audit against operational runbooks and ensure the selected Cezar runner/profile matches the live host before accepting STB-04

2026-10-25	INV-01/STB-04 documentation correction	Updated stale invocation-inventory statements: implementation resolved preflight and backlog static/no-candidate behavior are now described as implemented, with supported-runtime replay and measurements left open. Updated the replacement matrix to reflect the four resolved-preflight workflows and current maintenance/Godot conditions.	docs/agent-invocation-inventory.md; source comparison against workflows/implement.yaml, plan.yaml, investigate.yaml, fix-review.yaml, maintenance.yaml and godot-upgrade.yaml	Continue a source-to-inventory audit of all 17 skills, 10 workflows and 14 automation definitions; capture missing live facts as unavailable
2026-10-25	FND-03 partial	Plan-result comments now carry an issue-scoped SHA-256 receipt. Before posting, the router re-reads GitHub comments; identical retries reuse the durable comment, while changed content after a prior receipt fails closed for reconciliation. Added fake-GitHub fixtures for crash-after-comment retry and changed-content refusal. Full Factory test suite passed (ALL PASSED).	scripts/route-state.ps1; tests/run-tests.ps1; `pwsh -NoProfile -File tests/run-tests.ps1`	Extend durable receipt/reconciliation semantics to other consequential GitHub effects and add revision checks to the backlog proposal consumer
2026-10-25	STB-04 execution-provider correction	Active Factory execution records and default config now identify Cezar as the agent execution provider; the schema, tests and provider comment align with the current shared-mount architecture. Full Factory suite passed after the correction.	scripts/route-state.ps1; templates/factory.config.yaml; schemas/factory.config.schema.json; tests/run-tests.ps1; `pwsh -NoProfile -File tests/run-tests.ps1`	Finish active documentation/source audit and verify supported runtime parity before rollout
2026-10-25	FND-03 partial / INV-02 rules acceptance	The deterministic backlog consumer now binds proposal application to a verified preparation receipt and current GitHub issue revision (`updatedAt`), in addition to the allowlisted target labels and open state. Candidate collection rechecks that labels and revision stayed consistent while fetching issue content. A reserved issue with revision drift is rejected; an exact desired-label state is accepted as a retry receipt after an ambiguous prior write. Fixture suite includes revision drift with unchanged labels and passed in the full Factory run.	scripts/audit-backlog-labels.ps1; scripts/apply-backlog-label-audit.ps1; tests/fake-gh.ps1; tests/run-tests.ps1; `pwsh -NoProfile -File tests/run-tests.ps1` (ALL PASSED)	Continue measuring deterministic rule precision, manual overrides, and live outcome quality before declaring INV-02 complete
2026-10-25	STB-04 / PIL-09 runtime parity probe	Read-only host inspection found Bazzite `stable` at 5481d4a8302f4c055845ebb734f064fab92e9127 (matching remote `origin/stable`), clean, with version 0.3.53; the running Cezar container sees version 0.3.53 through the bind mount `/projects/cezar-factory`. Existing active watchdog, route-state, and resolved-preflight scripts are present. The new backlog effect consumer and explicit verification runner are absent from the current stable host, as expected before this unreviewed change is merged and promoted. No deployment was run.	`config/server-topology.env`; read-only SSH `bazzite`; remote `git rev-parse HEAD` and `git ls-remote origin refs/heads/stable`; `podman inspect cezar`; Cezar container VERSION and script existence probes	After reviewed merge and tested stable promotion, re-run factory-autodeploy/runtime parity checks; resolve the local branch's stale base before creating the implementation PR
2026-10-25	STB-04 documentation reconciliation	Updated active synchronization and project-integration guides to distinguish shared runtime promotion, configured Cezar automation synchronization, and optional local Factory installation. Marked two OpenHands provider/routing evaluations as historical evidence while retaining their recorded measurements. Full Factory suite passed after the documentation and route-state changes.	docs/synchronization.md; docs/project-integration.md; docs/local-coding-tool-evaluation.md; docs/routing-evaluation.md; docs/agent-invocation-inventory.md; docs/cezar-integration.md; scripts/route-state.ps1; `pwsh -NoProfile -File tests/run-tests.ps1` (ALL PASSED)	Complete review of active operator runbooks and verify live runner profiles before claiming STB-04
