"""Scanner status model, backoff and independent periodic freshness (#613, #614).

Library only. A scan outcome is one of `clean`, `findings`, `unknown`, `outage`, `stale`: an outage or an unusable scan is
never reported as clean, and a scan older than its max age is `stale`, distinct from both. Policy then maps a state to
pass, warn or block (mandatory checks fail closed at promotion). Periodic jobs only update quality evidence; they never start
a candidate, take ownership of one, or change a candidate SHA.
"""

from __future__ import annotations

from typing import Any

STATES = ("clean", "findings", "unknown", "outage", "stale")
CADENCE_HOURS = {"daily": 24, "weekly": 24 * 7, "monthly": 24 * 30}


def classify_scan(*, executed: bool, feed_available: bool, parsed: bool = True, finding_count: int = 0, completed_at: float | None,
                  max_age_hours: float | None, now: float) -> str:
    """Never `clean` unless the scan ran, had its feed, produced a usable result and is within its max age."""
    if not executed or not feed_available:
        return "outage"
    if not parsed or completed_at is None:
        return "unknown"
    if max_age_hours is not None and now - completed_at > max_age_hours * 3600:
        return "stale"
    return "findings" if finding_count > 0 else "clean"


def outcome(state: str, *, fail_mode: str, level: str) -> str:
    """Map a state to `pass`, `warn` or `block` under the check's level and fail mode."""
    if state not in STATES:
        raise ValueError(f"unknown scan state {state!r}")
    if level in ("off",):
        return "pass"
    if state == "clean":
        return "pass"
    if level != "required":
        return "warn"
    if state == "findings":
        return "block"
    # unknown / outage / stale: the fail mode decides, and promotion defaults to closed
    return "block" if fail_mode == "fail-closed" else "warn"


def backoff_delay(failures: int, *, base: float = 300.0, cap: float = 6 * 3600.0, factor: float = 2.0) -> float:
    """Bounded exponential backoff for an unavailable feed: base, base*factor, ... never above `cap`."""
    if failures <= 0:
        return 0.0
    return min(cap, base * (factor ** (failures - 1)))


class ScanBook:
    """Per (project, check) record: last scan time, state, advisory DB snapshot, consecutive outage count and next retry."""

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        self.data: dict[str, dict[str, Any]] = data or {}

    @staticmethod
    def key(project: str, check: str) -> str:
        return f"{project}/{check}"

    def get(self, project: str, check: str) -> dict[str, Any] | None:
        return self.data.get(self.key(project, check))

    def record(self, project: str, check: str, *, state: str, now: float, db_snapshot: str | None, max_age_hours: float | None,
               sha: str | None = None, backoff_base: float = 300.0, backoff_cap: float = 6 * 3600.0) -> dict[str, Any]:
        prev = self.get(project, check) or {}
        failing = state in ("outage", "unknown")
        failures = prev.get("failures", 0) + 1 if failing else 0
        rec = {"state": state, "lastScanAt": now if state in ("clean", "findings") else prev.get("lastScanAt"),
               "lastAttemptAt": now, "dbSnapshot": db_snapshot if state in ("clean", "findings") else prev.get("dbSnapshot"),
               "maxAgeHours": max_age_hours, "failures": failures, "sha": sha,
               "nextRetryAt": now + backoff_delay(failures, base=backoff_base, cap=backoff_cap) if failing else None}
        self.data[self.key(project, check)] = rec
        return rec

    def retry_allowed(self, project: str, check: str, *, now: float) -> bool:
        rec = self.get(project, check)
        return rec is None or rec.get("nextRetryAt") is None or now >= rec["nextRetryAt"]

    def effective_state(self, project: str, check: str, *, now: float) -> str:
        """The stored state, downgraded to `stale` once the last good scan is older than its max age."""
        rec = self.get(project, check)
        if rec is None:
            return "unknown"
        if rec["state"] in ("clean", "findings") and rec["maxAgeHours"] is not None and rec["lastScanAt"] is not None \
                and now - rec["lastScanAt"] > rec["maxAgeHours"] * 3600:
            return "stale"
        return rec["state"]


# ---- periodic jobs -------------------------------------------------------------------------------------------------
def due_periodic(cadence: dict[str, str], book: ScanBook, *, project: str, now: float) -> list[str]:
    """Categories whose cadence has elapsed since the last attempt and whose backoff allows a retry. Incremental by design:
    this lists scans, never the full suite."""
    due = []
    for category, cad in sorted(cadence.items()):
        rec = book.get(project, category)
        last = rec["lastAttemptAt"] if rec else None
        if (last is None or now - last >= CADENCE_HOURS[cad] * 3600) and book.retry_allowed(project, category, now=now):
            due.append(category)
    return due


def evidence_fresh(evidence_snapshot: str | None, current_snapshot: str | None) -> bool:
    """Quality evidence recorded against an older advisory DB snapshot is not fresh, even for an unchanged SHA."""
    return evidence_snapshot is not None and evidence_snapshot == current_snapshot


def apply_periodic_result(*, project: str, category: str, state: str, now: float, book: ScanBook, db_snapshot: str | None, max_age_hours: float | None,
                          blocking_findings: list[str], previously_blocking: list[str], candidate: dict[str, Any] | None,
                          promotable_before: bool) -> dict[str, Any]:
    """Fold a periodic scan into quality evidence only.

    Returns the readiness change and any new blocking findings to raise as issues. The candidate is passed in so the result can
    prove it was not touched: no candidate is created, claimed or modified here."""
    candidate_before = dict(candidate) if candidate else None
    rec = book.record(project, category, state=state, now=now, db_snapshot=db_snapshot, max_age_hours=max_age_hours, sha=candidate["sha"] if candidate else None)
    new_blocking = sorted(set(blocking_findings) - set(previously_blocking))
    promotable_after = promotable_before and state in ("clean", "findings") and not blocking_findings
    if candidate is not None and candidate != candidate_before:  # pragma: no cover - defensive
        raise RuntimeError("a periodic scan must not modify a candidate")
    return {"record": rec, "newBlocking": new_blocking, "promotableBefore": promotable_before, "promotableAfter": promotable_after,
            "readinessFlipped": promotable_before and not promotable_after, "startedCandidate": False, "candidateUntouched": True}
