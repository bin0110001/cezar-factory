"""Dual-mode release triggers and admission (#591).

Pure functions over an explicit clock: calendar schedules (IANA timezone, DST-safe) and dev-change rules operate
together without redundant runs, and every decision carries its reasons. Nothing here starts work. A decision to
`request` is handed to the candidate store (#590), which folds it into the single pending request when a candidate is
already active, so concurrent sources can never produce a second candidate.

The inputs are the effective `triggers` section of the release pipeline configuration (#589).
"""

from __future__ import annotations

import fnmatch
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
UTC = timezone.utc


@dataclass
class Decision:
    action: str  # request | skip | defer
    trigger: str | None = None
    reasons: list[str] = field(default_factory=list)
    occurrence: float | None = None  # epoch seconds of the schedule tick this decision consumes
    retry_at: float | None = None
    idempotency_key: str | None = None


# ---- calendar schedules --------------------------------------------------------------------------------------------
def _local_to_utc(naive: datetime, tz: ZoneInfo) -> datetime:
    """Resolve a wall-clock time. A time skipped by a DST jump moves forward; an ambiguous time takes its first pass."""
    return naive.replace(tzinfo=tz, fold=0).astimezone(UTC)


def occurrences(schedule: dict[str, Any], start: datetime, end: datetime) -> list[datetime]:
    """Schedule ticks (UTC) in (start, end]. Daily fires every local day; weekly only on `dayOfWeek`."""
    tz = ZoneInfo(schedule["timezone"])
    hour, minute = schedule["hour"], schedule.get("minute", 0)
    weekly = schedule["frequency"] == "weekly"
    want = DAYS.index(str(schedule.get("dayOfWeek", "")).lower()) if weekly else None
    day = (start.astimezone(tz) - timedelta(days=2)).date()
    last = (end.astimezone(tz) + timedelta(days=2)).date()
    out: list[datetime] = []
    while day <= last:
        if want is None or day.weekday() == want:
            at = _local_to_utc(datetime(day.year, day.month, day.day, hour, minute), tz)
            if start < at <= end:
                out.append(at)
        day += timedelta(days=1)
    return sorted(out)


def schedule_decision(schedule: dict[str, Any], *, last_fired: float | None, now: datetime, missed: str = "coalesce",
                      grace_minutes: int = 60, first_seen: float | None = None) -> Decision:
    """Due when a tick has passed since the last one consumed. Several missed ticks coalesce into one request.

    `missed='skip'` only honours a tick still inside the grace window; older ticks are consumed without running."""
    floor = last_fired if last_fired is not None else (first_seen if first_seen is not None else now.timestamp() - 8 * 86400)
    ticks = occurrences(schedule, datetime.fromtimestamp(floor, UTC), now)
    if not ticks:
        return Decision("skip", "schedule", ["no schedule tick since the last one"])
    latest = ticks[-1]
    reasons = [f"{len(ticks)} tick(s) since last; latest {latest.isoformat()}"]
    if len(ticks) > 1:
        reasons.append("missed ticks coalesced into one request")
    if missed == "skip" and now - latest > timedelta(minutes=grace_minutes):
        return Decision("skip", "schedule", reasons + [f"tick older than the {grace_minutes} min grace window; skipped"], occurrence=latest.timestamp())
    return Decision("request", "schedule", reasons, occurrence=latest.timestamp())


# ---- dev-change rules ----------------------------------------------------------------------------------------------
@dataclass
class DevState:
    dev_sha: str
    last_accepted_sha: str | None  # dev SHA of the last candidate that was admitted
    commits_since: int
    changed_paths: list[str]
    last_candidate_at: float | None  # epoch of the last candidate or stable promotion
    oldest_unpromoted_at: float | None  # epoch of the oldest merged change not yet in a candidate
    risk_flag: bool = False


def _in_quiet(quiet: dict[str, Any] | None, now: datetime, default_tz: str) -> bool:
    if not quiet:
        return False
    local = now.astimezone(ZoneInfo(quiet.get("timezone", default_tz))).hour
    start, end = quiet["start"], quiet["end"]
    return start <= local < end if start < end else (local >= start or local < end)


def change_decision(rules: dict[str, Any], dev: DevState, *, now: datetime, default_tz: str = "UTC") -> Decision:
    if not rules.get("enabled"):
        return Decision("skip", "change", ["change triggers are not enabled"])
    if dev.last_accepted_sha is not None and dev.dev_sha == dev.last_accepted_sha:
        return Decision("skip", "change", ["dev SHA equals the last accepted candidate"])
    paths = rules.get("paths")
    relevant = [p for p in dev.changed_paths if not paths or any(fnmatch.fnmatch(p, g) for g in paths)]
    if not relevant and not dev.risk_flag:
        return Decision("skip", "change", ["no relevant delta since the last candidate"])
    now_ts = now.timestamp()

    checks: dict[str, bool] = {}
    if rules.get("minCommits"):
        checks["minCommits"] = dev.commits_since >= rules["minCommits"]
    if rules.get("minFiles"):
        checks["minFiles"] = len(relevant) >= rules["minFiles"]
    if rules.get("minElapsedHours") and dev.last_candidate_at is not None:
        checks["minElapsedHours"] = now_ts - dev.last_candidate_at >= rules["minElapsedHours"] * 3600
    if dev.risk_flag:
        checks["risk"] = True
    if not checks:
        checks["anyRelevantChange"] = True
    met = [k for k, v in checks.items() if v]
    ok = (len(met) == len(checks)) if rules.get("combinator", "any") == "all" else bool(met)
    reasons = [f"{k}: {'met' if v else 'not met'}" for k, v in checks.items()]

    forced = bool(rules.get("maxDelayHours") and dev.oldest_unpromoted_at is not None and now_ts - dev.oldest_unpromoted_at >= rules["maxDelayHours"] * 3600)
    if forced:
        reasons.append("maxDelayHours reached; thresholds and quiet hours no longer defer")
    if not ok and not forced:
        return Decision("skip", "change", reasons)
    if not forced:
        if _in_quiet(rules.get("quietHours"), now, default_tz):
            return Decision("defer", "change", reasons + ["inside quiet hours"], retry_at=_quiet_end(rules["quietHours"], now, default_tz))
        cd = rules.get("cooldownMinutes")
        if cd and dev.last_candidate_at is not None and now_ts - dev.last_candidate_at < cd * 60:
            return Decision("defer", "change", reasons + [f"cooldown of {cd} min not elapsed"], retry_at=dev.last_candidate_at + cd * 60)
    return Decision("request", "change", reasons)


def _quiet_end(quiet: dict[str, Any], now: datetime, default_tz: str) -> float:
    tz = ZoneInfo(quiet.get("timezone", default_tz))
    local = now.astimezone(tz)
    end = local.replace(hour=quiet["end"], minute=0, second=0, microsecond=0)
    if end <= local:
        end += timedelta(days=1)
    return end.astimezone(UTC).timestamp()


# ---- combining sources ---------------------------------------------------------------------------------------------
def evaluate(triggers: dict[str, Any], *, project: str, now: datetime, dev: DevState, last_schedule_fired: float | None,
             manual_request: str | None = None, default_tz: str = "UTC") -> list[Decision]:
    """Every source's decision, ordered by the configured priority. Callers submit the `request` ones in order; the
    store admits the first and folds the rest into one pending request, so the order only affects the recorded reasons."""
    decisions: list[Decision] = []
    if manual_request is not None:
        if triggers.get("manual", True):
            decisions.append(Decision("request", "manual", [f"manual request: {manual_request}"]))
        else:
            decisions.append(Decision("skip", "manual", ["manual triggers are disabled for this project"]))
    sched = triggers.get("schedule")
    if sched:
        sd = schedule_decision(sched, last_fired=last_schedule_fired, now=now, missed=triggers.get("missedRun", "coalesce"),
                               grace_minutes=triggers.get("missedGraceMinutes", 60))
        if sd.action == "request" and dev.last_accepted_sha is not None and dev.dev_sha == dev.last_accepted_sha:
            # No-change suppression applies to the calendar too: the tick is consumed (occurrence kept) but nothing is requested.
            sd = Decision("skip", "schedule", sd.reasons + ["dev SHA equals the last accepted candidate; tick consumed without a request"], occurrence=sd.occurrence)
        decisions.append(sd)
    if triggers.get("afterChanges"):
        tz = (sched or {}).get("timezone", default_tz)
        decisions.append(change_decision(triggers["afterChanges"], dev, now=now, default_tz=tz))
    order = list(triggers.get("priority") or ["manual", "schedule", "change"])
    decisions.sort(key=lambda d: order.index(d.trigger) if d.trigger in order else len(order))
    for d in decisions:
        if d.action == "request":
            d.idempotency_key = f"{project}:{d.trigger}:{int(d.occurrence) if d.occurrence else dev.dev_sha}:{dev.dev_sha}"
    return decisions


# ---- admission -----------------------------------------------------------------------------------------------------
def admission(*, fast_checks_passed: bool, capacity_available: bool, ref_reachable: bool, queue_empty: bool = True,
              require_empty_queue: bool = False) -> Decision:
    """Snapshot eligibility with an explanation for every refusal."""
    why = []
    if not fast_checks_passed:
        why.append("required dev fast checks have not passed")
    if not ref_reachable:
        why.append("dev ref is not reachable")
    if not capacity_available:
        why.append("no worker capacity")
    if require_empty_queue and not queue_empty:
        why.append("coding queue is not empty")
    return Decision("defer", None, why) if why else Decision("request", None, ["eligible to snapshot"])


def backoff_seconds(consecutive_failures: int, *, base: float = 60.0, cap: float = 3600.0) -> float:
    """Exponential backoff for infrastructure failures (not for failing tests)."""
    return min(cap, base * (2 ** max(0, consecutive_failures - 1))) if consecutive_failures > 0 else 0.0


def submit(store: Any, project: str, decision: Decision, *, dev: DevState, base_stable_sha: str, config_hash: str, now: float | None = None) -> dict[str, Any]:
    """Hand one `request` decision to the candidate store, keyed so a replayed event cannot create a second candidate."""
    if decision.action != "request":
        raise ValueError("only a request decision can be submitted")
    return store.request(project, trigger=decision.trigger or "unknown", reason="; ".join(decision.reasons), dev_sha=dev.dev_sha,
                         base_stable_sha=base_stable_sha, config_hash=config_hash, now=time.time() if now is None else now,
                         idempotency_key=decision.idempotency_key)
