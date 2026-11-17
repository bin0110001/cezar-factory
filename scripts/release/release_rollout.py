"""Per-project rollout flags, rollback to the legacy path, history backfill and release metrics (#643).

Library only. A project runs on the `legacy` promotion path unless its flag says otherwise: `shadow` computes what the new engine
would do without acting, `new` uses it. Rolling back is a flag change plus a check that stable history was not rewritten; it never
touches a successful stable release.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

ENGINES = ("legacy", "shadow", "new")
UTC = timezone.utc


def engine_for(project: str, flags: dict[str, Any] | None) -> str:
    """The engine a project runs. Anything missing or invalid is `legacy`: the flag must be opted into explicitly."""
    value = ((flags or {}).get("projects") or {}).get(project, (flags or {}).get("default", "legacy"))
    return value if value in ENGINES else "legacy"


def set_engine(flags: dict[str, Any] | None, project: str, engine: str, *, actor: str, reason: str, now: float) -> dict[str, Any]:
    """Return updated flags with an audit entry. Moving a project off `legacy` needs a stated reason; rollback to legacy always works."""
    if engine not in ENGINES:
        raise ValueError(f"engine must be one of {list(ENGINES)}")
    if engine != "legacy" and not reason:
        raise ValueError("enabling the new engine needs a reason")
    out = {"default": (flags or {}).get("default", "legacy"), "projects": dict((flags or {}).get("projects") or {}), "audit": list((flags or {}).get("audit") or [])}
    previous = engine_for(project, flags)
    out["projects"][project] = engine
    out["audit"].append({"project": project, "from": previous, "to": engine, "actor": actor, "reason": reason, "at": now})
    return out


def route(project: str, flags: dict[str, Any] | None) -> dict[str, Any]:
    """Which path handles a promotion and whether the new engine may act."""
    engine = engine_for(project, flags)
    return {"engine": engine, "usesLegacyPromoter": engine in ("legacy", "shadow"), "newEngineActs": engine == "new", "newEngineObserves": engine in ("shadow", "new")}


def backfill_history(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Best-effort candidate history from legacy promotion records (`factory-local-promotion-record/v1`).

    Only records with a SHA and a recognizable outcome are converted; others are returned as `skipped` with a reason, never guessed."""
    out: list[dict[str, Any]] = []
    for r in records:
        sha = r.get("sha") or r.get("devSha") or r.get("candidateSha")
        outcome = r.get("outcome") or r.get("result") or r.get("status")
        at = r.get("finishedAt") or r.get("at") or r.get("createdAt")
        if not sha or not outcome:
            out.append({"skipped": True, "reason": "missing sha or outcome", "source": r.get("promotionId")})
            continue
        state = {"promoted": "promoted", "success": "promoted", "stable": "promoted", "failed": "failed", "rolled-back": "failed", "quarantined": "failed", "abandoned": "abandoned"}.get(str(outcome))
        if state is None:
            out.append({"skipped": True, "reason": f"unrecognized outcome {outcome!r}", "source": r.get("promotionId")})
            continue
        out.append({"candidateId": f"legacy-{str(sha)[:12]}", "sha": sha, "state": state, "source": "legacy-backfill", "at": at, "revision": 1})
    return out


def stable_history_intact(git: Any, *, stable_branch: str, before_sha: str) -> dict[str, Any]:
    """Rollback must not rewrite successful stable releases: the stable ref now must descend from (or equal) where it was."""
    now_sha = git.ref_value(f"refs/heads/{stable_branch}")
    if now_sha is None:
        return {"intact": False, "reason": "stable ref is missing"}
    if now_sha == before_sha or git.is_ancestor(before_sha, now_sha):
        return {"intact": True, "reason": "stable only moved forward", "before": before_sha, "after": now_sha}
    return {"intact": False, "reason": "stable no longer descends from its previous value", "before": before_sha, "after": now_sha}


def rollback_drill(flags: dict[str, Any] | None, project: str, git: Any, *, stable_branch: str, actor: str, now: float) -> dict[str, Any]:
    """Roll one project back to the legacy path and prove stable history was not touched. Reads stable, writes only the flag."""
    before = git.ref_value(f"refs/heads/{stable_branch}")
    if before is None:
        raise ValueError("stable ref is missing; refusing to run a rollback drill without a baseline")
    new_flags = set_engine(flags, project, "legacy", actor=actor, reason="rollback", now=now)
    check = stable_history_intact(git, stable_branch=stable_branch, before_sha=before)
    return {"flags": new_flags, "route": route(project, new_flags), "stableCheck": check, "ok": check["intact"] and engine_for(project, new_flags) == "legacy"}


# ---- metrics -------------------------------------------------------------------------------------------------------
def _ts(v: Any) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def release_metrics(records: list[dict[str, Any]], *, since: float, until: float) -> dict[str, Any]:
    """Release frequency, compute hours, merge conflicts and mean repair time over a window.

    Record fields (all optional, missing means not counted, never invented): `promotedAt`, `computeSeconds`, `conflicts`,
    `repairStartedAt` and `repairFinishedAt`."""
    days = max((until - since) / 86400.0, 1e-9)

    def when(r: dict[str, Any]) -> float | None:
        return _ts(r.get("promotedAt") if r.get("promotedAt") is not None else r.get("at"))

    inside = [r for r in records if (t := when(r)) is not None and since <= t < until]
    promoted = [r for r in inside if _ts(r.get("promotedAt")) is not None]
    compute = sum(float(r["computeSeconds"]) for r in inside if isinstance(r.get("computeSeconds"), (int, float)))
    conflicts = sum(int(r["conflicts"]) for r in inside if isinstance(r.get("conflicts"), int))
    repairs = []
    for r in records:
        a, b = _ts(r.get("repairStartedAt")), _ts(r.get("repairFinishedAt"))
        if a is not None and b is not None and b >= a and since <= b < until:
            repairs.append(b - a)
    return {"windowDays": round(days, 3), "releases": len(promoted), "releasesPerWeek": round(len(promoted) / days * 7, 3),
            "computeHours": round(compute / 3600.0, 3), "mergeConflicts": conflicts,
            "repairs": len(repairs), "meanRepairHours": round(sum(repairs) / len(repairs) / 3600.0, 3) if repairs else None}


def compare_periods(records: list[dict[str, Any]], *, cutover: float, before_days: float, after_days: float) -> dict[str, Any]:
    """Before/after figures around the cutover to the new engine."""
    before = release_metrics(records, since=cutover - before_days * 86400, until=cutover)
    after = release_metrics(records, since=cutover, until=cutover + after_days * 86400)
    delta = {k: (round(after[k] - before[k], 3) if isinstance(after[k], (int, float)) and isinstance(before[k], (int, float)) else None)
             for k in ("releasesPerWeek", "computeHours", "mergeConflicts", "meanRepairHours")}
    return {"before": before, "after": after, "delta": delta}
