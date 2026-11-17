# Severity separation, baselines, suppressions and metrics (#649, #650, #651)

TypeScript modules in `cezar/packages/cezar/src/server/verification/checks/`, on top of the normalized findings
(`docs/check-provider-contract.md`). They are the TypeScript counterpart of the Python quality-gate libraries
(`docs/quality-gate-pipeline.md`); both follow the policy in `docs/quality-gates.md`.

## Security versus quality debt (`normalized-findings.ts`, `finding-policy.ts`, #650)

Every normalized finding now has a `class`: `security` (sast, sca, secrets, iac, container, license, sbom) or `quality-debt`
(format, lint, type, complexity, custom, and so on). The class comes from the category, never from the severity a tool
reports, so a lint tool calling something `critical` does not make it a security finding.

`diffAgainstBaseline` splits findings into new, existing and fixed by the provider-independent fingerprint; a baseline entry
older than `baselineMaxAgeDays` stops protecting its finding. `baselineFrom` builds acknowledged-debt entries and is meant for a
reviewed action, never an automatic one. `trend` returns per-snapshot counts by class and severity plus what each snapshot
introduced and resolved. `evaluateFindingGate` blocks a **new** security finding at or above `blockSecurityAt` (default `high`);
existing debt stays visible (`visibleDebt`) and never blocks; new quality debt blocks only if `blockQualityDebtAt` is set.

## Reviewed suppressions and path exclusions (#651)

`suppressionSchema` and `pathExclusionSchema` describe a suppression (by fingerprint, rule id and/or path glob; a blanket one is
rejected) or a path exclusion, each with a reason, reviewer, reviewer kind and a required expiry. `reviewProblems` names why one
does not count: `unreviewed`, `agent-reviewed` (only a human or operator review counts) or `expired`. In the gate an unreviewed
or agent-reviewed entry is ignored, an expired one blocks again, and every ignored entry is explained in the verdict reasons.

## Maintainability metrics (`quality-metrics.ts`, #649)

Parsers turn each ecosystem's tool output into per-SHA samples: complexity per function, duplication percentage, dead-code counts,
warning counts and coverage. `MetricStore` records them immutably (a different value for the same key is refused),
`coverageDelta` compares coverage with a baseline SHA, and `debtSignals` turns threshold breaches into quality-debt signals whose
severity is capped at `medium`, so a metric can never look like a security finding or feed a security gate.

Assumptions: persisting findings through the #52 ledger needs a new kind in the contract enum (a deliberate widening) and is not
done here; baselines and suppressions are caller-supplied data, stored by the adopting workflow; the existing `baseline-promotion`
schema is not changed.
