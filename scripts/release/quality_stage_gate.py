"""Wire quality gates into the PR/dev, candidate and stable stages (#615).

Library only. Combines the policy (#611), per-check outcomes (#613) and finding evaluation (#612) into one stage decision
with a redacted, receipt-shaped result. It does not edit `config/promotion-policy.json` or the promoter; the adopting stage
calls `evaluate_stage` and records the receipt it returns.
"""

from __future__ import annotations

import re
from typing import Any

from scripts.release import quality_findings as qf
from scripts.release import quality_gate_policy as qg
from scripts.release import scanner_status as ss

_TOKENS = [re.compile(p) for p in (r"gh[pousr]_[A-Za-z0-9]{20,}", r"github_pat_[A-Za-z0-9_]{20,}", r"sk-[A-Za-z0-9_-]{20,}", r"AKIA[0-9A-Z]{16}", r"xox[baprs]-[0-9A-Za-z-]{10,}", r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}")]
REDACTED = "[REDACTED]"


def redact(value: Any, extra: tuple[str, ...] = ()) -> Any:
    """Redact token shapes and any extra known secret values in every string of a nested structure (#579 behaviour)."""
    if isinstance(value, str):
        for s in extra:
            if s:
                value = value.replace(s, REDACTED)
        for rx in _TOKENS:
            value = rx.sub(REDACTED, value)
        return value
    if isinstance(value, list):
        return [redact(v, extra) for v in value]
    if isinstance(value, dict):
        return {k: redact(v, extra) for k, v in value.items()}
    return value


def evaluate_stage(*, doc: dict[str, Any], project: str, repo_type: str | None, stage: str, changed_paths: list[str], checks: dict[str, dict[str, Any]],
                   findings: list[dict[str, Any]], baseline: list[dict[str, Any]], suppressions: list[dict[str, Any]], now: float,
                   book: ss.ScanBook | None = None, secrets: tuple[str, ...] = (), existing_issue_keys: set[str] | None = None) -> dict[str, Any]:
    """Decide one stage. `checks[category]` is {status: pass|fail|warn|unknown|error} or {scan: {...classify_scan inputs}}.

    Required checks that are missing count as `unknown`, so an absent scan never passes a required security check."""
    eff = qg.effective(doc, project=project, repo_type=repo_type)
    matrix = qg.escalated_stage_matrix(eff, stage, changed_paths)
    blockers: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    for cat, spec in sorted(matrix.items()):
        raw = checks.get(cat)
        if raw is None:
            status, how = "unknown", "no result for a configured check"
        elif "scan" in raw:
            state = ss.classify_scan(**raw["scan"])
            status = {"clean": "pass", "findings": "fail", "stale": "unknown", "unknown": "unknown", "outage": "error"}[state]
            how = f"scan state {state}"
        else:
            status, how = raw["status"], "reported status"
        if qg.is_blocking(eff, cat, stage, status) or (spec.get("reason") and status in ("fail", "unknown", "error")):
            blockers.append({"category": cat, "status": status, "level": spec["level"], "onUnavailable": spec["onUnavailable"], "why": how})
        elif spec["level"] != "required" and status not in ("pass",):
            advisories.append({"category": cat, "status": status, "why": how})
    fe = qf.evaluate_findings(findings, policy=eff, stage=stage, project=project, baseline=baseline, suppressions=suppressions, now=now)
    blocking_findings = [v for v in fe["verdicts"] if v["blocking"]]
    # findings gate only where a security/supply-chain check is enforced for this stage
    enforced = any(c in qg.SECURITY and s["level"] == "required" for c, s in matrix.items())
    finding_block = bool(blocking_findings) and enforced
    issues = qf.plan_issues(blocking_findings, existing_keys=existing_issue_keys or set(), project=project) if finding_block and stage in qg.PROMOTION_STAGES else []
    receipt = {"schemaVersion": "quality-gate-receipt/v1", "project": project, "stage": stage, "evaluatedAt": now, "allowed": not blockers and not finding_block,
               "blockers": blockers, "advisories": advisories, "findings": {"blocked": finding_block, "counts": fe["counts"], "verdicts": fe["verdicts"]},
               "issues": issues}
    return redact(receipt, secrets)
