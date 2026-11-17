# Quality check catalog (#668, epic #663)

Single catalog of the check families in epic #663. It adds no finding store, runner, policy engine, scheduler or
release service: findings stay in the #47/#52/#54 ledger, providers follow `docs/check-provider-contract.md`
(#616-#619) and stage policy is `policies/quality-gates.json` (`docs/quality-gates.md`, #611-#615). Local workers
only; outputs are redacted; no GitHub Actions.

Status was checked on 2026-11-17 against code and issue state (`gh issue view`), not checkbox state. Categories are
the `CHECK_CATEGORIES` in `cezar/packages/cezar/src/server/verification/checks/check-provider.ts`. Statuses:
**implemented** (code on `dev`, pointer given), **open** (owner issue open, nothing implemented), **unverified**.

## Families

| # | Family / check | Owner issue | Provider | Category | Stages (policy default) | Status | Evidence |
|---|---|---|---|---|---|---|---|
| 1a | Format | #646 | native per language (C#, TS, Python) | `format` | pr-dev required | open (matrix row exists, no adapter) | #646 open; `policies/quality-gates.json` |
| 1b | Lint | #646 | native per language | `lint` | pr-dev, candidate required | open | #646 open |
| 1c | Type check | #646 | native per language | `type` | pr-dev, candidate required | open | #646 open |
| 1d | Godot/GDScript parse and warnings | #648 (packaging #662) | Godot headless adapter | `lint`/`custom` | per project override | open; a Godot verification adapter exists separately | #648, #662 open; `docs/godot-verification-adapter.md` |
| 2a | SCA/CVE | #599 | Trivy (swap: OSV-Scanner) | `sca` | pr-dev advisory; candidate, stable required fail-closed; periodic daily | implemented | `providers/trivy-adapter.ts`, `providers/osv-adapter.ts`, `providers/provider-swap.test.ts`, `docs/check-provider-comparison.md` |
| 2b | Secrets | #599 | Trivy | `secrets` | pr-dev, candidate, stable required fail-closed | implemented | `providers/trivy-adapter.ts` |
| 2c | SAST | #647 | pinned Semgrep | `sast` | advisory | open | #647 open |
| 2d | SBOM and license | #652 | Trivy license scan today; policy and SBOM schema pending | `license`, `sbom` | license periodic/manual advisory; sbom stable advisory | open (Trivy license parsing exists, no policy/SBOM artifact) | #652 open |
| 2e | IaC and container | #653 | Trivy config/image | `iac`, `container` | candidate, periodic advisory | open | #653 open |
| 2f | Periodic advisory refresh | #614 | scanner status/cadence library | n/a (schedule) | periodic | implemented | `scripts/release/scanner_status.py`, `docs/quality-gate-pipeline.md` |
| 2g | OpenSSF Scorecard (report-only) | #654 | Scorecard | `custom` | periodic, report-only | open | #654 open |
| 3 | Architecture boundaries, API compatibility, change scope | #192/#195/#196/#200 (reused, not recreated) | impact manifest and overlap engine | `custom` | none in matrix yet | partly implemented: #195, #196, #200 closed; #192 epic open; boundary/cycle and API compatibility checks unverified | `docs/impact-manifest.md`, `docs/impact-collection.md` |
| 4 | Test effectiveness (test/assertion weakening, impacted coverage, flaky quarantine) | #47/#53/#54 ledger; dispositions #661 | existing verification ledger | `test` | pr-dev, candidate, stable required | partly implemented: #661 closed, `test` gate exists; weakening and changed-line coverage checks unverified | `docs/verification-ledger-semantics.md`, `docs/acceptance-ledger.md` |
| 5 | Maintainability: complexity, dead code, warnings, duplication | #649 | one provider per category, see below | `complexity` | none in matrix yet | open | #649 open |
| 6 | Documentation validation and decision drift | #174 (#178, #179 closed) | existing docs automation | `custom` | none in matrix yet | partly implemented: #178, #179 closed; #174 epic open | `docs/docs-refresh.md` |
| 7 | Risk-triggered AI audit | #602 | opt-in AI audit policy | `ai-audit` | manual optional, advisory | implemented | `scripts/release/ai_audit_policy.py`, `docs/ai-audit.md` |

### Family 5: one provider per maintainability category

The provider is chosen by #649; until it lands no provider is assigned. The rule is one row per category.

| Category | Owner | Provider | Status |
|---|---|---|---|
| Complexity | #649 | unassigned (to be chosen in #649) | open |
| Dead code | #649 | unassigned | open |
| Duplication | #649 | unassigned | open |
| Warnings | #649 (language warnings also via #646/#648) | native compiler or linter output | open |
| Coverage change | #649 | unassigned | open |

## Foundation and gating, all implemented

| Item | Issue | Evidence |
|---|---|---|
| Provider contract, categories, status model | #598, #616 | `checks/check-provider.ts`, `docs/check-provider-contract.md` |
| Normalized findings and fingerprints | #617 | `checks/normalized-findings.ts` |
| Check runner, provenance pinning, cache invalidation | #618 | `checks/check-runner.ts` |
| Gate integration and independent schedule | #619 | `checks/check-gates.ts` |
| Trivy adapter and alternative provider proof | #599 | see row 2a |
| Policy matrix | #611 | `policies/quality-gates.json`, `scripts/release/quality_gate_policy.py` |
| Gate evaluation, baselines, suppressions | #612 | `scripts/release/quality_findings.py` |
| Scanner status | #613 | `scripts/release/scanner_status.py` |
| Periodic scans and freshness | #614 | `docs/quality-gate-pipeline.md` |
| Stage wiring and gate receipt | #615 | `scripts/release/quality_stage_gate.py` (library; the promoter does not call it yet) |
| AI audit controls | #602 | `scripts/release/ai_audit_policy.py` |
| Verification dispositions | #661 | closed |

## Open owners (linked, not recreated)

#646, #647, #648, #649, #650 (severity, stable IDs, baseline/trend, new-findings gate), #651 (reviewed suppressions),
#652, #653, #654, #660 (historical risk, consumed by the existing AI classifier), #662, #603 (quality dashboard, UI
owner with #57), #192, #174.

## Overlaps and ownership rules

- No two analyzers own the same rule category by default. A category has exactly one provider per project; a second
  provider for it needs explicit configuration and must not create a second mandatory gate for the same rule.
- `sca`: Trivy is the default; OSV-Scanner is a swap-compatible alternative, not a parallel scanner.
- `license`/`sbom`: Trivy license findings and #652 overlap; #652 owns policy, so Trivy's license output is not a
  separate gate.
- `iac`/`container`: #653 owns the policy; #599 Trivy config scanning is the engine, and #647 Semgrep must not enable
  IaC rule packs by default.
- `lint`/warnings: #646 and #648 own language warnings; #649 must not re-run compilers or linters for warnings.
- Findings, baselines and suppressions: #650/#651 extend the #612 evaluator; they add no second store.
- Release gating belongs to #588/#593/#615; this catalog does not define a release service.

Unverified entries are marked above; reconcile them when their owner issue closes.
