"""Deterministic disposition rules and stage minimum gates (#665, child of #661).

Maps normalized verification outcomes to CONTINUE, RECORD, RETRY or BLOCK per stage instead of treating a nonzero
exit as failure. Library only: no finding database, no approval authority. "Accepted" debt comes from the existing
baseline/waiver data the caller passes in (outcome["accepted"]); this module never grants or edits it.

Safe defaults: unrecognized input BLOCKs, missing coverage is "unknown" (never a pass), and a scanner/runner outage
retries within the stage bound and then escalates (BLOCK with escalate=true).
"""

from __future__ import annotations

import fnmatch
import json
from typing import Any

DISPOSITIONS = ("CONTINUE", "RECORD", "RETRY", "BLOCK")
STATUSES = ("pass", "fail", "unknown", "outage")
SEVERITIES = ("info", "low", "medium", "high", "critical")
STAGES = ("pr-dev", "candidate", "stable")
_RANK = {d: i for i, d in enumerate(DISPOSITIONS)}
_SEV = {s: i for i, s in enumerate(SEVERITIES)}


class PolicyError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def validate_policy(policy: dict) -> list[str]:
    """Validate the stage minimum gates and protected paths of policies/verification.json."""
    errs: list[str] = []
    gates = policy.get("stageGates")
    if not isinstance(gates, dict) or not gates:
        return ["stageGates: must be a non-empty object"]
    for stage, g in gates.items():
        w = f"stageGates.{stage}"
        if stage not in STAGES:
            errs.append(f"{w}: unknown stage")
        if not isinstance(g, dict):
            errs.append(f"{w}: must be an object")
            continue
        for k in g:
            if k not in ("requiredChecks", "blockAtOrAbove", "maxOutageRetries"):
                errs.append(f"{w}.{k}: unknown key")
        rc = g.get("requiredChecks")
        if not isinstance(rc, list) or not all(isinstance(c, str) and c for c in rc):
            errs.append(f"{w}.requiredChecks: must be a list of check ids")
        if g.get("blockAtOrAbove") not in SEVERITIES:
            errs.append(f"{w}.blockAtOrAbove: must be one of {list(SEVERITIES)}")
        r = g.get("maxOutageRetries")
        if not isinstance(r, int) or isinstance(r, bool) or not 0 <= r <= 5:
            errs.append(f"{w}.maxOutageRetries: must be an integer 0..5")
    pp = policy.get("protectedPaths")
    if not isinstance(pp, list) or not pp or not all(isinstance(p, str) and p for p in pp):
        errs.append("protectedPaths: must be a non-empty list of globs")
    return errs


def load_policy(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        policy = json.load(fh)
    errs = validate_policy(policy)
    if errs:
        raise PolicyError(errs)
    return policy


def _decide(policy: dict, stage: str, o: dict) -> tuple[str, str, bool]:
    gate = policy["stageGates"][stage]
    status = o.get("status")
    sev = o.get("severity", "medium")
    if status not in STATUSES or sev not in _SEV:
        return "BLOCK", "unrecognized-outcome", False
    required = o.get("check") in gate["requiredChecks"]
    if status == "pass":
        return "CONTINUE", "passed", False
    if status == "outage":
        if int(o.get("attempt", 0)) < gate["maxOutageRetries"]:
            return "RETRY", "outage-retry", False
        return "BLOCK", "outage-retries-exhausted", True
    if status == "unknown":
        return ("BLOCK", "required-coverage-missing", False) if required else ("RECORD", "coverage-unknown", False)
    # status == "fail"
    if o.get("acceptanceImpacted"):
        return "BLOCK", "acceptance-regression", False
    if o.get("regression") and o.get("new", True):
        return "BLOCK", "new-focused-regression", False
    if o.get("accepted") and not o.get("new", False):
        return "CONTINUE", "accepted-existing-debt", False
    if _SEV[sev] >= _SEV[gate["blockAtOrAbove"]]:
        return "BLOCK", "severity-at-or-above-gate", False
    if o.get("new", True):
        return "RECORD", "new-minor-finding", False
    return "RECORD", "existing-unaccepted-minor", False


def evaluate(policy: dict, stage: str, outcomes: list[dict]) -> dict:
    """Return per-outcome dispositions and the stage verdict (worst disposition wins)."""
    errs = validate_policy(policy)
    if errs:
        raise PolicyError(errs)
    if stage not in policy["stageGates"]:
        raise PolicyError([f"stage {stage!r} has no minimum gate"])
    rows = []
    for o in outcomes:
        d, reason, escalate = _decide(policy, stage, o if isinstance(o, dict) else {})
        rows.append({"check": (o or {}).get("check") if isinstance(o, dict) else None, "disposition": d, "reason": reason, "escalate": escalate})
    seen = {r["check"] for r in rows}
    for c in policy["stageGates"][stage]["requiredChecks"]:
        if c not in seen:
            rows.append({"check": c, "disposition": "BLOCK", "reason": "required-check-absent", "escalate": False})
    verdict = max((r["disposition"] for r in rows), key=_RANK.__getitem__, default="CONTINUE")
    unknown = any(r["reason"] in ("coverage-unknown", "required-coverage-missing", "required-check-absent") for r in rows)
    status = "blocked" if verdict == "BLOCK" else "retry" if verdict == "RETRY" else "unknown" if unknown else "pass"
    return {"stage": stage, "disposition": verdict, "status": status, "escalate": any(r["escalate"] for r in rows), "outcomes": rows}


def agent_summary(result: dict) -> str:
    """Concise agent-facing text: verdict line plus only the non-CONTINUE items."""
    lines = [f"{result['stage']}: {result['disposition']} ({result['status']}){' ESCALATE' if result['escalate'] else ''}"]
    lines += [f"- {r['check']}: {r['disposition']} {r['reason']}" for r in result["outcomes"] if r["disposition"] != "CONTINUE"]
    return "\n".join(lines)


def ui_payload(result: dict) -> dict:
    """Plain-data block for the existing Operations/Verification query data (no new store)."""
    counts = {d: 0 for d in DISPOSITIONS}
    for r in result["outcomes"]:
        counts[r["disposition"]] += 1
    return {"stage": result["stage"], "disposition": result["disposition"], "status": result["status"], "escalate": result["escalate"], "counts": counts, "outcomes": result["outcomes"]}


def _norm(p: str) -> str:
    return p.replace("\\", "/").lstrip("./") if p.startswith("./") else p.replace("\\", "/")


def protected_path_violations(policy: dict, changed_paths: list[str]) -> list[str]:
    """Paths an implementation branch may not edit (policy, baseline, waiver files)."""
    globs = policy.get("protectedPaths") or []
    out = []
    for p in changed_paths:
        n = _norm(p)
        if ".." in n.split("/") or any(fnmatch.fnmatchcase(n, g) for g in globs):
            out.append(n)
    return sorted(set(out))


def reject_implementation_change(policy: dict, changed_paths: list[str]) -> None:
    bad = protected_path_violations(policy, changed_paths)
    if bad:
        raise PolicyError([f"implementation change edits protected path: {p}" for p in bad])
