"""Deterministic adaptive progress evaluator (#739, epic #736).

Pure library: no clock, IO or randomness, and no LLM judgement. Given an ordered history of immutable
observations (oldest first, the last one is the round being judged) it classifies the round and returns
reason codes and evidence references. See docs/progress-evaluator.md for the input contract and precedence.

Observation shape (adapt #738 diagnostics into it):
  {"id": str, "verified": bool,
   "coverage": {"expected": [checkId...], "executed": [checkId...]},
   "artifact": {"hash": str},
   "findings": [{"fingerprint": str, "severity": str, "criterionId": str, "checkId": str}]}

Severity order and the trusted-baseline vocabulary follow quality_findings.py / verification_progression.py:
accepted (known) findings are supplied by the caller from the trusted baseline policy; the evaluator keeps them
visible but never decides acceptance itself.
"""

from __future__ import annotations

from typing import Any, Iterable

SEVERITY_WEIGHT = {"info": 1, "low": 2, "medium": 4, "high": 8, "critical": 16}
CLASSIFICATIONS = (
    "resolved", "net_progress", "mixed_progress", "partial_progress",
    "stagnation", "regression", "oscillation", "inconclusive",
)
# Precedence, highest first (documented in docs/progress-evaluator.md).
PRECEDENCE = ("inconclusive", "regression", "oscillation", "resolved", "net_progress", "mixed_progress", "partial_progress", "stagnation")


def _weight(severity: str) -> int:
    return SEVERITY_WEIGHT.get(str(severity).lower(), SEVERITY_WEIGHT["critical"])  # unknown severity is worst-case


def _norm(obs: dict[str, Any]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for f in obs.get("findings") or []:
        fp = str(f["fingerprint"])
        grouped.setdefault(fp, []).append({
            "fingerprint": fp,
            "severity": str(f.get("severity", "critical")).lower(),
            "criterionId": str(f.get("criterionId", "")),
            "checkId": str(f.get("checkId", "")),
        })
    findings: dict[str, dict[str, Any]] = {}
    for fp, duplicates in grouped.items():
        # A fingerprint is one finding even if several validators report it. Keep its
        # worst severity and every referenced criterion/check so order and duplicates
        # cannot hide a regression or make a missing check look like resolution.
        severity = min(
            {f["severity"] for f in duplicates},
            key=lambda value: (-_weight(value), value not in SEVERITY_WEIGHT, value),
        )
        findings[fp] = {
            "fingerprint": fp,
            "severity": severity,
            "criterionIds": sorted({f["criterionId"] for f in duplicates if f["criterionId"]}),
            "checkIds": sorted({f["checkId"] for f in duplicates if f["checkId"]}),
        }
    cov = obs.get("coverage") or {}
    return {
        "id": str(obs.get("id", "")),
        "verified": bool(obs.get("verified", False)),
        "expected": frozenset(str(c) for c in cov.get("expected") or []),
        "executed": frozenset(str(c) for c in cov.get("executed") or []),
        "hash": str((obs.get("artifact") or {}).get("hash", "")),
        "findings": findings,
    }


def _blocking(o: dict[str, Any], accepted: frozenset[str]) -> dict[str, dict[str, Any]]:
    return {k: v for k, v in o["findings"].items() if k not in accepted}


def _score(findings: dict[str, dict[str, Any]]) -> int:
    return sum(_weight(f["severity"]) for f in findings.values())


def _complete(o: dict[str, Any]) -> bool:
    return o["verified"] and bool(o["expected"]) and o["expected"] <= o["executed"]


def _criteria(findings: dict[str, dict[str, Any]]) -> frozenset[str]:
    return frozenset(c for f in findings.values() for c in f["criterionIds"])


def _criterion_resolved_before(prior: list[dict[str, Any]], c: str, accepted: frozenset[str]) -> bool:
    """True if some earlier complete observation failed criterion c and a later complete one passed it."""
    failed = False
    for o in prior:
        if not _complete(o):
            continue
        has = c in _criteria(_blocking(o, accepted))
        if has:
            failed = True
        elif failed:
            return True
    return False


def _best(history: list[dict[str, Any]], accepted: frozenset[str]) -> dict[str, Any] | None:
    """Best VERIFIED, complete-coverage observation by score; ties go to the earliest."""
    best, best_key = None, None
    for o in history:
        if not _complete(o):
            continue
        b = _blocking(o, accepted)
        key = _score(b)
        if best_key is None or key < best_key:
            best, best_key = o, key
    return best


def _cycle(sets: list[frozenset[str]]) -> int:
    """Length of the repeating cycle ending at the last set (0 if none): it returned to an earlier set after leaving it."""
    cur = sets[-1]
    if not cur:
        return 0
    for j in range(len(sets) - 2, -1, -1):
        if sets[j] == cur and any(s != cur for s in sets[j + 1:]):
            return len(sets) - 1 - j
    return 0


def evaluate(history: Iterable[dict[str, Any]], accepted_fingerprints: Iterable[str] = ()) -> dict[str, Any]:
    """Classify the latest observation against the preceding and best verified ones."""
    obs = [_norm(o) for o in history]
    if not obs:
        raise ValueError("history must contain at least one observation")
    accepted = frozenset(str(a) for a in accepted_fingerprints)
    cur = obs[-1]
    prev = obs[-2] if len(obs) > 1 else None
    prior = obs[:-1]
    cur_b = _blocking(cur, accepted)
    cur_set = frozenset(cur_b)
    reasons: list[str] = []
    refs: list[str] = [f"observation:{cur['id']}"]
    if prev:
        refs.append(f"observation:{prev['id']}")

    # Coverage / verification: expected checks must have run; nothing may be masked.
    missing = sorted(cur["expected"] - cur["executed"])
    dropped = sorted(prev["executed"] - cur["executed"]) if prev else []
    masked = sorted(
        fp for fp, f in (prev["findings"].items() if prev else [])
        if fp not in cur["findings"] and any(check_id not in cur["executed"] for check_id in f["checkIds"])
    )
    inconclusive: list[str] = []
    if not cur["verified"]:
        inconclusive.append("not_verified")
    if not cur["expected"]:
        inconclusive.append("no_expected_checks")
    if missing:
        inconclusive.append("expected_checks_not_executed")
        refs += [f"check:{c}" for c in missing]
    if dropped:
        inconclusive.append("coverage_reduced")
        refs += [f"check:{c}" for c in dropped]
    if masked:
        inconclusive.append("finding_masked")
        refs += [f"finding:{fp}@{prev['id']}" for fp in masked]
    if prev is None:
        inconclusive.append("no_previous_observation")

    best = _best(prior, accepted)
    best_cmp = "none"
    if best is not None and _complete(cur):
        bk, ck = _score(_blocking(best, accepted)), _score(cur_b)
        best_cmp = "better" if ck < bk else "equal" if ck == bk else "worse"
        refs.append(f"best:{best['id']}")

    out: dict[str, Any] = {
        "new": [], "resolved": [], "persistent": [], "reopened": [], "regressed": [],
        "acceptedVisible": sorted(k for k in cur["findings"] if k in accepted),
        "artifactChanged": None, "consecutiveNoProgress": 0,
        "bestComparison": best_cmp, "bestObservation": best["id"] if best else None,
        "oscillationCycle": 0, "persistenceAllowed": False,
    }

    if prev is not None:
        prev_b = _blocking(prev, accepted)
        prev_set = frozenset(prev_b)
        out["new"] = sorted(cur_set - prev_set)
        out["resolved"] = sorted(prev_set - cur_set)
        out["persistent"] = sorted(cur_set & prev_set)
        seen_earlier = set().union(*[o["findings"].keys() for o in prior[:-1]]) if len(prior) > 1 else set()
        out["reopened"] = sorted(fp for fp in out["new"] if fp in seen_earlier)
        worsened = sorted(fp for fp in out["persistent"] if _weight(cur_b[fp]["severity"]) > _weight(prev_b[fp]["severity"]))
        eased = sorted(fp for fp in out["persistent"] if _weight(cur_b[fp]["severity"]) < _weight(prev_b[fp]["severity"]))
        # A criterion that was clean in an earlier verified observation and fails again regressed.
        crit_regressed = sorted(
            c for c in _criteria(cur_b)
            if c not in _criteria(prev_b) and _criterion_resolved_before(prior, c, accepted)
        )
        out["regressed"] = sorted(set(worsened) | set(out["reopened"]))
        out["artifactChanged"] = prev["hash"] != cur["hash"]
        score_prev, score_cur = _score(prev_b), _score(cur_b)
        # consecutive trailing rounds without strict improvement, counting this one.
        run = 0
        for i in range(len(obs) - 1, 0, -1):
            if _score(_blocking(obs[i], accepted)) < _score(_blocking(obs[i - 1], accepted)):
                break
            run += 1
        out["consecutiveNoProgress"] = run
        sets = [frozenset(_blocking(o, accepted)) for o in obs if _complete(o) or o is cur]
        out["oscillationCycle"] = _cycle(sets)

        cls_reasons: list[str] = []
        if inconclusive:
            cls, cls_reasons = "inconclusive", inconclusive
        elif worsened or score_cur > score_prev or (not out["oscillationCycle"] and (out["reopened"] or crit_regressed)):
            cls = "regression"
            if worsened:
                cls_reasons.append("severity_increase")
            if out["reopened"]:
                cls_reasons.append("finding_reopened")
            if crit_regressed:
                cls_reasons.append("acceptance_criterion_regressed")
                refs += [f"criterion:{c}" for c in crit_regressed]
            if score_cur > score_prev and not (worsened or out["reopened"] or crit_regressed):
                cls_reasons.append("severity_weighted_score_increase")
        elif out["oscillationCycle"]:
            cls, cls_reasons = "oscillation", [f"cycle_length_{out['oscillationCycle']}"]
        elif not cur_set:
            cls, cls_reasons = "resolved", ["no_blocking_findings"]
        elif score_cur < score_prev:
            if out["resolved"] and not out["new"]:
                cls, cls_reasons = "net_progress", ["findings_resolved"]
            elif out["resolved"]:
                cls, cls_reasons = "mixed_progress", ["findings_resolved", "new_findings_introduced"]
            else:
                cls, cls_reasons = "partial_progress", ["severity_decreased"] if eased else ["fewer_findings"]
        else:
            cls = "stagnation"
            if out["new"] and out["resolved"]:
                cls_reasons.append("new_fingerprint_not_progress")
            elif prev["hash"] == cur["hash"]:
                cls_reasons.append("artifact_unchanged")
            else:
                cls_reasons.append("no_finding_improvement")
            if best_cmp == "worse":
                cls_reasons.append("worse_than_best_verified")
            if out["artifactChanged"]:
                cls_reasons.append("artifact_changed")
                out["persistenceAllowed"] = True
        if cls in ("mixed_progress", "partial_progress", "net_progress") and best_cmp == "worse":
            cls_reasons.append("worse_than_best_verified")
        refs += [f"finding:{fp}@{cur['id']}" for fp in out["new"] + out["reopened"] + worsened]
        refs += [f"finding:{fp}@{prev['id']}" for fp in out["resolved"]]
        reasons = cls_reasons
    else:
        cls = "resolved" if (not inconclusive[:-1] and not cur_set) else "inconclusive"
        reasons = ["no_blocking_findings"] if cls == "resolved" else inconclusive

    out.update({
        "classification": cls,
        "reasonCodes": sorted(set(reasons)),
        "evidenceRefs": sorted(set(refs)),
        "blockingCount": len(cur_set),
        "score": _score(cur_b),
    })
    return out
