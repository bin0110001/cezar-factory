"""Finding gate evaluation, baselines and scoped expiring suppressions (#612).

Library only. Findings (normalized, from the #52/#617 pipeline) are evaluated against the quality policy: new versus
baselined known debt, exploitability, fix availability, age, severity, confidence and path criticality. Suppressions are
reviewed, scoped and expiring, and only a human or operator may grant one (`waivers.grantedBy` in the policy); an agent
cannot waive its own findings, and an expired suppression blocks again.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

SEV_ORDER = ("info", "low", "medium", "high", "critical")
DAY = 86400.0


def _sev(s: str) -> int:
    return SEV_ORDER.index(s) if s in SEV_ORDER else 0


def baseline_entry(finding: dict[str, Any], *, added_at: float) -> dict[str, Any]:
    return {"fingerprint": finding["fingerprint"], "severity": finding["severity"], "addedAt": added_at}


def suppression_problems(sup: dict[str, Any], policy_waivers: dict[str, Any], *, now: float) -> list[str]:
    """Why a suppression is not valid. The grantor kind must be allowed by policy; agents never are."""
    out = []
    allowed = policy_waivers.get("grantedBy") or []
    if sup.get("grantedByKind") not in allowed:
        out.append(f"granted by {sup.get('grantedByKind')!r}; only {allowed} may grant a waiver (agents cannot self-waive)")
    if not sup.get("reason"):
        out.append("a suppression needs a reason")
    if not sup.get("receiptId"):
        out.append("a suppression needs an exception receipt id")
    exp = sup.get("expiresAt")
    if exp is None:
        out.append("a suppression must expire")
    else:
        if now >= exp:
            out.append("expired")
        max_days = policy_waivers.get("maxDays")
        if max_days and exp - sup.get("grantedAt", now) > max_days * DAY:
            out.append(f"lifetime exceeds the policy maximum of {max_days} days")
    if not (sup.get("fingerprint") or sup.get("advisoryId")):
        out.append("a suppression must name a fingerprint or advisory id (no blanket waivers)")
    return out


def _matches(sup: dict[str, Any], f: dict[str, Any], *, project: str, stage: str) -> bool:
    if sup.get("fingerprint") and sup["fingerprint"] != f["fingerprint"]:
        return False
    if sup.get("advisoryId") and sup["advisoryId"] != f.get("advisoryId"):
        return False
    scope = sup.get("scope") or {}
    if scope.get("project") and scope["project"] != project:
        return False
    if scope.get("stages") and stage not in scope["stages"]:
        return False
    if scope.get("pathGlob") and f.get("path") is not None:
        import fnmatch
        if not fnmatch.fnmatch(f["path"], scope["pathGlob"]):
            return False
    return True


def exception_receipt(sup: dict[str, Any]) -> dict[str, Any]:
    body = {k: sup.get(k) for k in ("fingerprint", "advisoryId", "scope", "grantedByKind", "grantedBy", "grantedAt", "expiresAt", "reason", "receiptId")}
    return {"schemaVersion": "quality-exception-receipt/v1", **body, "digest": "sha256:" + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()}


def evaluate_findings(findings: list[dict[str, Any]], *, policy: dict[str, Any], stage: str, project: str, baseline: list[dict[str, Any]],
                      suppressions: list[dict[str, Any]], now: float, block_baselined_at_stable: bool = False) -> dict[str, Any]:
    """Per-finding verdicts and an overall block decision for `stage`.

    A finding is `baselined` only while its baseline entry is younger than `baselineMaxAgeDays`. New findings at or above a
    severity whose tolerance is exceeded block. Confirmed-exploitable or high-criticality paths with a fix available tighten
    one severity step. Suppressed findings are skipped only with a valid, in-scope, unexpired suppression."""
    tol = (policy.get("tolerances") or {}).get("maxNewFindings", {})
    max_age = (policy.get("tolerances") or {}).get("baselineMaxAgeDays")
    waivers = policy.get("waivers") or {}
    base = {b["fingerprint"]: b for b in baseline}
    verdicts: list[dict[str, Any]] = []
    for f in findings:
        reasons: list[str] = []
        status = "new"
        b = base.get(f["fingerprint"])
        if b is not None and (max_age is None or now - b["addedAt"] <= max_age * DAY):
            status = "baselined"
        elif b is not None:
            reasons.append("baseline entry expired; treated as new")
        sup_ok = None
        for sup in suppressions:
            if _matches(sup, f, project=project, stage=stage):
                problems = suppression_problems(sup, waivers, now=now)
                if not problems:
                    sup_ok = sup
                    break
                reasons.extend(f"suppression rejected: {p}" for p in problems)
        if sup_ok is not None:
            status = "suppressed"
            reasons.append(f"suppressed until {sup_ok['expiresAt']} (receipt {sup_ok['receiptId']})")
        effective_sev = _sev(f["severity"])
        if f.get("exploitable") == "confirmed" or f.get("pathCriticality") == "high":
            effective_sev = min(len(SEV_ORDER) - 1, effective_sev + (1 if f.get("fixAvailable") else 0))
        verdicts.append({"fingerprint": f["fingerprint"], "status": status, "severity": f["severity"], "effectiveSeverity": SEV_ORDER[effective_sev],
                         "advisoryId": f.get("advisoryId"), "reasons": reasons, "fixAvailable": bool(f.get("fixAvailable"))})
    new = [v for v in verdicts if v["status"] == "new"]
    counts: dict[str, int] = {}
    for v in new:
        counts[v["effectiveSeverity"]] = counts.get(v["effectiveSeverity"], 0) + 1
    blocking: list[str] = []
    for sev, limit in tol.items():
        over = sum(n for s, n in counts.items() if _sev(s) >= _sev(sev))
        if over > limit:
            blocking += [v["fingerprint"] for v in new if _sev(v["effectiveSeverity"]) >= _sev(sev)]
    if block_baselined_at_stable and stage == "stable":
        blocking += [v["fingerprint"] for v in verdicts if v["status"] == "baselined" and _sev(v["effectiveSeverity"]) >= _sev("critical")]
    blocking = sorted(set(blocking))
    for v in verdicts:
        v["blocking"] = v["fingerprint"] in blocking
    return {"blocked": bool(blocking), "blocking": blocking, "verdicts": verdicts, "counts": counts}


def plan_issues(blocking: list[dict[str, Any]], *, existing_keys: set[str], max_new: int = 3, project: str = "") -> list[dict[str, Any]]:
    """Actionable issues for blocking findings, deduplicated against open ones and bounded per run (#105)."""
    out = []
    for v in sorted(blocking, key=lambda x: (-_sev(x["effectiveSeverity"]), x["fingerprint"])):
        key = f"quality:{project}:{v['fingerprint'][:16]}"
        if key in existing_keys:
            continue
        if len(out) >= max_new:
            break
        fix = "upgrade or patch (a fix is available)" if v["fixAvailable"] else "no fix available: mitigate or request a reviewed waiver"
        out.append({"key": key, "title": f"[quality] {v['effectiveSeverity']} {v.get('advisoryId') or v['fingerprint'][:12]} blocks promotion", "body": fix, "severity": v["effectiveSeverity"]})
    return out
