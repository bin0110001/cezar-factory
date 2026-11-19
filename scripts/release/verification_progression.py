"""Verification progression, merge and release policy over a baseline comparison result (#100).

Library only. The same comparison result is judged per stage (iteration <= merge <= release in strictness):
- known debt with zero verified new regressions may continue development (nonblocking), but release can block it;
- a new/worsened/reopened failure in the impacted area stops verified-completion at every stage;
- untested, unknown or infra-failure results are never green;
- coverage below the stage's configured minimum fails that stage.
Dispositions use the vocabulary of policies/verification.json (known, resolved, new, worsened, reopened, untested, unknown, infra-failure).
"""

from __future__ import annotations

from typing import Any

STAGES = ("iteration", "merge", "release")
OK_DECISION = {"iteration": "continue", "merge": "merge-ok", "release": "release-ok"}
REGRESSIONS = ("new", "worsened", "reopened")
NEVER_GREEN = ("untested", "unknown", "infra-failure")
DISPOSITIONS = ("known", "resolved") + REGRESSIONS + NEVER_GREEN


def validate(doc: dict[str, Any]) -> list[str]:
    """Return policy errors: bounds, missing stages, and the strictness ordering iteration <= merge <= release."""
    errors: list[str] = []
    stages = doc.get("stages")
    if not isinstance(stages, dict) or set(stages) != set(STAGES):
        return ["stages must define exactly iteration, merge and release"]
    for name in STAGES:
        s = stages[name]
        cov = s.get("minCoverage")
        if isinstance(cov, bool) or not isinstance(cov, (int, float)) or not 0 <= cov <= 100:
            errors.append(f"{name}.minCoverage must be a number in [0, 100]")
        for flag in ("blockKnownDebt", "blockNonImpactedRegressions"):
            if not isinstance(s.get(flag), bool):
                errors.append(f"{name}.{flag} must be a boolean")
    if errors:
        return errors
    for a, b in zip(STAGES, STAGES[1:]):
        if stages[b]["minCoverage"] < stages[a]["minCoverage"]:
            errors.append(f"{b}.minCoverage must be >= {a}.minCoverage")
        for flag in ("blockKnownDebt", "blockNonImpactedRegressions"):
            if stages[a][flag] and not stages[b][flag]:
                errors.append(f"{b}.{flag} must not be looser than {a}.{flag}")
    return errors


def evaluate(doc: dict[str, Any], stage: str, counts: dict[str, int], *, impacted_regressions: int = 0, coverage: float | None = None) -> dict[str, Any]:
    """Decide one stage. `counts` maps disposition -> number; `impacted_regressions` counts new/worsened/reopened in the impacted area.

    Returns {stage, decision, green, reasons}; decision is continue/merge-ok/release-ok or blocked. Invalid policy or unknown input blocks."""
    problems = validate(doc)
    if problems or stage not in STAGES:
        return {"stage": stage, "decision": "blocked", "green": False, "reasons": problems or [f"unknown stage {stage!r}"]}
    rule = doc["stages"][stage]
    blockers: list[str] = []
    notes: list[str] = []
    for key in counts:
        if key not in DISPOSITIONS:
            blockers.append(f"unrecognised disposition {key!r} is never green")
    n = {k: int(counts.get(k, 0)) for k in DISPOSITIONS}
    if impacted_regressions > 0:
        blockers.append(f"{impacted_regressions} new/worsened/reopened failure(s) in the impacted area")
    regressions = sum(n[k] for k in REGRESSIONS)
    if regressions > impacted_regressions and rule["blockNonImpactedRegressions"]:
        blockers.append(f"{regressions - impacted_regressions} new/worsened/reopened failure(s) outside the impacted area")
    for k in NEVER_GREEN:
        if n[k]:
            blockers.append(f"{n[k]} {k} result(s) cannot be reported green")
    if coverage is None:
        blockers.append("coverage is unknown and never green")
    elif coverage < rule["minCoverage"]:
        blockers.append(f"coverage {coverage} is below the {stage} minimum {rule['minCoverage']}")
    if n["known"]:
        if rule["blockKnownDebt"]:
            blockers.append(f"{n['known']} known debt item(s) block {stage}")
        else:
            notes.append(f"{n['known']} known debt item(s) do not block {stage}")
    if blockers:
        return {"stage": stage, "decision": "blocked", "green": False, "reasons": blockers}
    return {"stage": stage, "decision": OK_DECISION[stage], "green": n["known"] == 0 and regressions == 0, "reasons": notes}


def evaluate_all(doc: dict[str, Any], counts: dict[str, int], *, impacted_regressions: int = 0, coverage: float | None = None) -> dict[str, dict[str, Any]]:
    return {s: evaluate(doc, s, counts, impacted_regressions=impacted_regressions, coverage=coverage) for s in STAGES}
