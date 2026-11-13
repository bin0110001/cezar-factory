"""Quota-aware admission, deferral and retry for the scheduler.

Stdlib only. Consumes the capacity snapshots of capacity_telemetry.py through a narrow
"capacity provider" (provider name -> list of CapacityAdapter) and a caller-supplied ordered
candidate list (the candidate/tier resolver of #92 is out of scope). See docs/quota-admission.md.

Guarantees:
- no job is admitted to a candidate with an exhausted window, an active cooldown or a full
  concurrency limit; capacity is reserved atomically (one lock) so concurrent workers never
  over-commit a window or dispatch the same job twice;
- reservations are leases: a crashed or timed-out worker's lease expires and is released;
- exhaustion defers (reason + earliest retry) instead of failing;
- rate-limit errors feed a cooldown with bounded exponential backoff, jitter and a retry-storm guard;
- deferred jobs are re-admitted by priority plus aging so none starves.
"""
from __future__ import annotations

import importlib.util
import random
import sys
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional

try:  # normal import when scripts/capacity is on sys.path
    import capacity_telemetry as ct
except ImportError:  # load by path so the module works from any entry point
    _spec = importlib.util.spec_from_file_location("capacity_telemetry", Path(__file__).with_name("capacity_telemetry.py"))
    ct = importlib.util.module_from_spec(_spec)
    sys.modules["capacity_telemetry"] = ct
    _spec.loader.exec_module(ct)

CONSERVATIVE, OPTIMISTIC = "conservative", "optimistic"
ADMITTED, DEFERRED = "admitted", "deferred"


@dataclass
class Candidate:
    """One eligible provider for a job, in preference order; cost is units per window."""
    provider: str
    cost: Dict[str, float] = field(default_factory=lambda: {w: 1.0 for w in ct.WINDOWS})


@dataclass
class Decision:
    job_id: str
    status: str
    provider: Optional[str] = None
    reason: Optional[str] = None
    retry_at: Optional[datetime] = None
    fallback: bool = False
    duplicate: bool = False


@dataclass
class Lease:
    job_id: str
    provider: str
    cost: Dict[str, float]
    expires_at: datetime


@dataclass
class Deferred:
    job_id: str
    candidates: List[Candidate]
    priority: float
    enqueued_at: datetime
    attempts: int = 0
    not_before: Optional[datetime] = None


class AdmissionController:
    def __init__(
        self,
        adapters: Dict[str, list],
        concurrency: Optional[Dict[str, int]] = None,
        reserve: Optional[Dict[str, float]] = None,
        unknown_mode: str = CONSERVATIVE,
        optimistic_unknown_limit: int = 1,
        lease_seconds: float = 1800.0,
        base_backoff: float = 30.0,
        max_backoff: float = 3600.0,
        jitter: float = 0.2,
        max_attempts: int = 8,
        aging_per_hour: float = 1.0,
        rng: Optional[random.Random] = None,
        clock: Callable[[], datetime] = ct.utcnow,
    ):
        if unknown_mode not in (CONSERVATIVE, OPTIMISTIC):
            raise ValueError(f"unknown_mode must be {CONSERVATIVE} or {OPTIMISTIC}")
        self.adapters = adapters
        self.concurrency = concurrency or {}
        self.reserve = reserve or {}
        self.unknown_mode = unknown_mode
        self.optimistic_unknown_limit = optimistic_unknown_limit
        self.lease_seconds = lease_seconds
        self.base_backoff, self.max_backoff = base_backoff, max_backoff
        self.jitter, self.max_attempts, self.aging_per_hour = jitter, max_attempts, aging_per_hour
        self.rng = rng or random.Random()
        self.clock = clock
        self._lock = threading.RLock()
        self.leases: Dict[str, Lease] = {}
        self.deferred: Dict[str, Deferred] = {}
        self.cooldowns: Dict[tuple, datetime] = {}  # (provider, window) -> until
        self.failures: Dict[str, int] = {}  # provider -> consecutive rate limits
        self.trackers: Dict[str, "ct.ObservedCooldownTracker"] = {}
        self.exhausted_jobs: set = set()  # jobs given up on (retry-storm guard), still not "failed"

    # ---- capacity view -------------------------------------------------
    def _reserved(self, provider: str, window: str) -> float:
        return sum(l.cost.get(window, 0.0) for l in self.leases.values() if l.provider == provider)

    def _active(self, provider: str) -> int:
        return sum(1 for l in self.leases.values() if l.provider == provider)

    def _unknown_active(self, provider: str) -> int:
        return sum(1 for l in self.leases.values() if l.provider == provider and l.cost.get("_unknown"))

    def _check(self, cand: Candidate, now: datetime):
        """Return (ok, reason, earliest_retry, used_unknown) across every window and the concurrency cap."""
        retry: Optional[datetime] = None
        limit = self.concurrency.get(cand.provider)
        if limit is not None and self._active(cand.provider) >= limit:
            soon = min((l.expires_at for l in self.leases.values() if l.provider == cand.provider), default=None)
            return False, f"{cand.provider}: concurrency limit {limit} reached", soon, False
        unknown = False
        for window in ct.WINDOWS:
            until = self.cooldowns.get((cand.provider, window))
            if until and until > now:
                return False, f"{cand.provider}: cooldown in {window} window", until, False
            snap = ct.resolve_snapshot(self.adapters.get(cand.provider, []), window, now)
            if snap.source == "observed" and snap.freshness(now) == "fresh":
                return False, f"{cand.provider}: rate limited in {window} window", snap.reset_at, False
            remaining = snap.effective_remaining(self.reserve.get(window, 0.0), now)
            if remaining is None:
                if snap.freshness(now) == "fresh" and snap.confidence != "unknown" and snap.remaining is not None:
                    remaining = 0.0  # authoritative error snapshot: treat as exhausted
                else:
                    unknown = True
                    continue
            need = cand.cost.get(window, 0.0)
            if need > remaining - self._reserved(cand.provider, window):
                return False, f"{cand.provider}: {window} window exhausted", snap.reset_at, False
        if unknown:
            if self.unknown_mode == CONSERVATIVE:
                return False, f"{cand.provider}: capacity unknown (conservative mode)", now + timedelta(seconds=self.base_backoff), True
            if self._unknown_active(cand.provider) >= self.optimistic_unknown_limit:
                return False, f"{cand.provider}: capacity unknown, optimistic probe limit reached", now + timedelta(seconds=self.base_backoff), True
        return True, None, None, unknown

    # ---- admission -----------------------------------------------------
    def admit(self, job_id: str, candidates: List[Candidate], priority: float = 0.0) -> Decision:
        with self._lock:
            now = self.clock()
            self._expire(now)
            if job_id in self.leases:  # duplicate dispatch guard
                return Decision(job_id, ADMITTED, self.leases[job_id].provider, duplicate=True)
            item = self.deferred.get(job_id) or Deferred(job_id, candidates, priority, now)
            item.candidates, item.priority = candidates, priority
            return self._try(item, now)

    def _try(self, item: Deferred, now: datetime) -> Decision:
        reasons, earliest = [], None
        for index, cand in enumerate(item.candidates):
            ok, reason, retry, unknown = self._check(cand, now)
            if ok:
                cost = dict(cand.cost)
                if unknown:
                    cost["_unknown"] = 1.0
                self.leases[item.job_id] = Lease(item.job_id, cand.provider, cost, now + timedelta(seconds=self.lease_seconds))
                self.deferred.pop(item.job_id, None)
                return Decision(item.job_id, ADMITTED, cand.provider, fallback=index > 0)
            reasons.append(reason)
            if retry and (earliest is None or retry < earliest):
                earliest = retry
        item.attempts += 1
        floor = now + timedelta(seconds=self._backoff(item.attempts))
        retry_at = max(earliest, floor) if earliest else floor  # never earlier than the storm guard allows
        item.not_before = retry_at
        if item.attempts > self.max_attempts:
            self.exhausted_jobs.add(item.job_id)
        self.deferred[item.job_id] = item
        return Decision(item.job_id, DEFERRED, reason="; ".join(r for r in reasons if r) or "no eligible candidate", retry_at=retry_at)

    def _backoff(self, attempts: int) -> float:
        base = min(self.max_backoff, self.base_backoff * (2 ** max(0, attempts - 1)))
        return min(self.max_backoff, base * (1 + self.jitter * self.rng.random()))

    # ---- lifecycle -----------------------------------------------------
    def _expire(self, now: datetime) -> List[str]:
        gone = [j for j, l in self.leases.items() if l.expires_at <= now]
        for job in gone:
            del self.leases[job]
        return gone

    def expire(self) -> List[str]:
        """Release leases of crashed or timed-out workers."""
        with self._lock:
            return self._expire(self.clock())

    def heartbeat(self, job_id: str) -> bool:
        with self._lock:
            lease = self.leases.get(job_id)
            if lease:
                lease.expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            return lease is not None

    def complete(self, job_id: str, actual: Optional[Dict[str, float]] = None) -> bool:
        """Reconcile on completion: release the lease; a success clears the provider's failure streak.
        The reservation is an estimate; real usage is read back from telemetry on its next refresh."""
        with self._lock:
            lease = self.leases.pop(job_id, None)
            if lease:
                self.failures[lease.provider] = 0
                tracker = self.trackers.get(lease.provider)
                if tracker:
                    tracker.record_success()
            return lease is not None

    def release(self, job_id: str) -> bool:
        """Timeout / cancel / crash handler: free the reservation without counting success."""
        with self._lock:
            return self.leases.pop(job_id, None) is not None

    def report_rate_limit(self, job_id: str, provider: str, window: str, retry_after: Optional[float] = None) -> datetime:
        """Consume a rate-limit error: release the lease, set a bounded cooldown with jitter, return its end."""
        with self._lock:
            now = self.clock()
            self.leases.pop(job_id, None)
            streak = self.failures.get(provider, 0)
            self.failures[provider] = streak + 1
            delay = min(self.max_backoff, self.base_backoff * (2 ** streak))
            if isinstance(retry_after, (int, float)) and not isinstance(retry_after, bool) and retry_after >= 0:
                delay = max(delay, retry_after)
            delay = min(self.max_backoff, delay * (1 + self.jitter * self.rng.random()))
            until = now + timedelta(seconds=delay)
            self.cooldowns[(provider, window)] = max(until, self.cooldowns.get((provider, window), until))
            return self.cooldowns[(provider, window)]

    # ---- re-evaluation -------------------------------------------------
    def effective_priority(self, item: Deferred, now: datetime) -> float:
        waited_hours = max(0.0, (now - item.enqueued_at).total_seconds() / 3600.0)
        return item.priority + self.aging_per_hour * waited_hours

    def reevaluate(self, force: bool = False) -> List[Decision]:
        """Call on a timer, at reset, or after a telemetry refresh. Highest priority-plus-aging first;
        a job still inside its backoff window is skipped (retry-storm guard) unless force=True
        (a window reset or telemetry refresh that changed capacity)."""
        with self._lock:
            now = self.clock()
            self._expire(now)
            out = []
            for item in sorted(self.deferred.values(), key=lambda i: (-self.effective_priority(i, now), i.enqueued_at)):
                if not force and item.not_before and item.not_before > now:
                    continue
                decision = self._try(item, now)
                if decision.status == ADMITTED:
                    out.append(decision)
            return out

    def next_retry(self) -> Optional[datetime]:
        with self._lock:
            times = [i.not_before for i in self.deferred.values() if i.not_before]
            return min(times) if times else None
