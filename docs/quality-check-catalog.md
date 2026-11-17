# Quality check catalog (epic #663)

One catalog of the check families in epic #663: owner issue, provider, category, stage applicability and implementation status, verified
against the code by `tests/test_quality_check_catalog.py` (every delivered row names code that exists; status is not taken from checkbox
state). Open owners are linked, not recreated. Stage applicability follows `policies/quality-gates.json` (`docs/quality-gates.md`).

Common path prefix: `cezar/packages/cezar/src/server/verification/checks/` is written `checks/`; `scripts/release/` is written as is.

| Family | Check | Category | Stages | Owner | Provider | Status | Code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Native TypeScript, Python and .NET lint, format and type checks | lint | pr-dev, candidate | #646 | native-lint | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/native-lint-adapter.ts` |
| 1 | Godot/GDScript parse and warnings | lint | pr-dev, candidate | #648 | godot-check | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/godot-check-adapter.ts` |
| 1 | Reusable versioned Godot provider (manifest, capability matching, environment hash) | lint | pr-dev, candidate | #662 | godot-check | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/godot-provider.ts` |
| 1 | Capability detection and NOT_APPLICABLE | — | all | #645 | capabilities | delivered | `cezar/packages/cezar/src/server/verification/checks/capabilities.ts` |
| 2 | Dependency CVE, secret, image and config scanning (default) | sca | candidate, stable, periodic | #606 (of #599) | trivy | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/trivy-adapter.ts` |
| 2 | Alternative dependency scanner (provider swap proof) | sca | candidate, stable, periodic | #607 | osv-scanner | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/osv-adapter.ts` |
| 2 | Pinned SAST | sast | pr-dev, candidate, periodic | #647 | semgrep | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/semgrep-adapter.ts` |
| 2 | SBOM schema and license policy | license | periodic, manual | #652 | license-policy | delivered | `cezar/packages/cezar/src/server/verification/checks/license-policy.ts` |
| 2 | Container base-image and Terraform rules | iac | pr-dev, candidate | #653 | infra-policy | delivered | `cezar/packages/cezar/src/server/verification/checks/infra-policy.ts` |
| 2 | Periodic advisory refresh and freshness | sca | periodic | #614 | scanner-status | delivered | `scripts/release/scanner_status.py` |
| 2 | OpenSSF Scorecard (report-only) | custom | periodic | #654 | scorecard | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/scorecard-adapter.ts` |
| 2 | Scanner trust policy and isolation | — | all | #604 | scanner-trust | delivered | `cezar/packages/cezar/src/server/verification/scanner-trust-policy.ts` |
| 3 | Architecture boundaries, cycles, API compatibility, planned scope | custom | pr-dev, candidate | #670 | architecture | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/architecture-adapter.ts` |
| 4 | Test deletion, skip and weakening, impacted suites, flaky quarantine | test | pr-dev, candidate, stable | #671 | test-effectiveness | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/test-effectiveness-adapter.ts` |
| 5 | Complexity | complexity | pr-dev, candidate | #649 | quality-metrics | delivered | `cezar/packages/cezar/src/server/verification/checks/quality-metrics.ts` |
| 5 | Duplication | complexity | pr-dev, candidate | #649 | quality-metrics | delivered | `cezar/packages/cezar/src/server/verification/checks/quality-metrics.ts` |
| 5 | Dead code | complexity | pr-dev, candidate | #649 | quality-metrics | delivered | `cezar/packages/cezar/src/server/verification/checks/quality-metrics.ts` |
| 5 | Warnings and coverage change | complexity | pr-dev, candidate | #649 | quality-metrics | delivered | `cezar/packages/cezar/src/server/verification/checks/quality-metrics.ts` |
| 6 | Documentation references and decision drift | custom | pr-dev | #672 | doc-drift | delivered | `cezar/packages/cezar/src/server/verification/checks/providers/doc-drift-adapter.ts` |
| 7 | Risk-triggered optional AI audit | ai-audit | manual, periodic | #602 | ai-audit | delivered | `scripts/release/ai_audit_policy.py` |

## Foundation and supporting work (not check families)

| Area | Owner | Status | Code |
| --- | --- | --- | --- |
| Check-provider contract, normalized findings, runner and gates | #598 (#616-#619) | delivered | `cezar/packages/cezar/src/server/verification/checks/check-provider.ts` |
| Quality gate policy and stage wiring | #600 (#611-#615) | delivered | `policies/quality-gates.json` |
| Findings in the ledger, dispositions, rules, follow-ups | #661 (#664-#666) | delivered | `cezar/packages/cezar/src/verification/disposition.ts` |
| Severity separation, baselines, suppressions | #650, #651 | delivered | `cezar/packages/cezar/src/server/verification/checks/finding-policy.ts` |
| Historical risk intelligence | #660 | delivered | `cezar/packages/cezar/src/verification/risk-intelligence.ts` |
| End-to-end demonstration and acceptance | #669, #673 | delivered | `docs/quality-acceptance.md` |
| Quality and security dashboard, triage and pilots | #603 | open | — |

## Overlap rules

- Each maintainability category (complexity, duplication, dead code, warnings, coverage) has one provider, `quality-metrics`; adding a second
  analyzer for a category is a catalog change, not a default.
- `duplicateGateViolations` (`docs/quality-acceptance.md`) rejects two mandatory gates for one category and trigger unless a category is
  allowed explicitly.
- Dependency scanning has a default provider (`trivy`) and a documented alternative (`osv-scanner`) selected by configuration; both are never
  mandatory together.

Open owner as of this catalog: #603 (dashboard and pilots). #644 (pilot adoption) and #588 (release epic)
are release-engine work tracked there, not check families.
