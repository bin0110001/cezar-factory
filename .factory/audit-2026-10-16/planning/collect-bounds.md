<!-- factory-plan-2026-10-16:collect-bounds -->

Parent: #22; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Make failure collection read-only with enforceable read/output budgets and explicit registered identity.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/audit-factory-failures.ps1; workflows/failure-audit.yaml; schemas/ (failure-audit input/receipt); tests/mock-cezar.ps1; tests/run-tests.ps1.

## Design decisions

1. Resolve projectId/apiUrl from workflow environment or explicit registered inputs; do not lowercase a folder name as project identity.
2. Select at most 20 recent local run IDs in a default 24-hour window. Bound candidate metadata scanning too: if the declared discovery budget is exhausted, report limited coverage instead of claiming complete recency.
3. Use bounded stream reads/tails, e.g. 64 KiB per handoff/event source, <=200 event lines, <=8 failure summaries and <=12,000 evidence characters; redact tokens before serialization. Make caps explicit testable constants/options with enforced ceilings.
4. Do not GET bulk /runs: the bundled server.ts endpoint returns the entire list with no pagination. API enrichment may GET only a selected known run ID with response size/time limits; missing bounded evidence yields limited status.
5. Separate collection from issue publishing and restart flags. Preserve restart compatibility behind a separate workflow command/explicit recovery step, disabled when bounded evidence is incomplete.

## suggestedWorkBreakdown

1. Extract deterministic evidence normalization and a versioned artifact schema with project identity, window, run/step/command fields, fingerprints, budgets and limitations.
2. Implement bounded local selection/read paths and optional per-ID API enrichment.
3. Keep collection side-effect free; wire existing behavior through explicit downstream command ownership without broad run queries.
4. Add fixtures for huge single-line events, oversized handoffs, partial API response, missing directory, wrong project and budget exhaustion.

## acceptanceCriteria

- [ ] Oversized or adversarial inputs never exceed declared read/output caps and report truncation/coverage limitations.
- [ ] Collector writes only its local artifact; no gh mutations, restarts or bulk /runs requests occur.
- [ ] Known selected run/step/command evidence survives redaction, and unavailable evidence is explicitly marked.
- [ ] Missing registered identity fails safely without guessing another project.

## Validation

Bounded-stream fake sources record bytes/requests; check 20/24h/8/12k limits, secrets and giant lines; full Factory suite on Windows/Linux.

## nonGoals

No Cezar API pagination changes, project discovery, issue publication or automatic restart redesign.

## risks

risk:medium: Result/schema/workflow compatibility can affect every configured project; preserve legacy-readable data, add negative regression cases, avoid real external writes in tests, and independently review the change.

## dependencies

None; independently implementable.

Required by: #31

## requiredProjectSkills

`factory-implement`, `factory-review`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. No additional human plan approval is required at this risk level; independent review is still required.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: ready. Planning is complete. Lifecycle: factory:human-review as a planning-only scheduling handoff; no further planning or extra medium-risk plan approval is required. Setting factory:ready would dispatch implementation, which is outside this planning-only handoff.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.



