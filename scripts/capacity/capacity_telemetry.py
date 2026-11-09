"""Provider-neutral capacity telemetry: snapshots, adapters, staleness, reserve, backoff.

Stdlib only. Native telemetry is best-effort and defaults to "unsupported"; unsupported,
manual or observed data is never reported as exact. See docs/capacity-telemetry.md.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

WINDOWS = ("5h", "weekly")
SOURCES = ("native", "manual", "observed", "unsupported")
CONFIDENCES = ("exact", "estimated", "unknown")
FRESHNESS = ("fresh", "stale", "expired", "unknown")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _number(value) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value >= 0 else None


@dataclass
class CapacitySnapshot:
    provider: str
    window: str
    source: str = "unsupported"
    confidence: str = "unknown"
    timestamp: Optional[datetime] = None
    remaining: Optional[float] = None  # raw units, preserved as reported
    limit: Optional[float] = None
    unit: Optional[str] = None
    reset_at: Optional[datetime] = None
    ttl_seconds: int = 900
    error: Optional[str] = None
    retry_after_seconds: Optional[float] = None

    def freshness(self, now: Optional[datetime] = None) -> str:
        now = now or utcnow()
        if self.timestamp is None:
            return "unknown"
        if self.reset_at is not None and now >= self.reset_at:
            return "expired"
        if now - self.timestamp > timedelta(seconds=self.ttl_seconds):
            return "stale"
        return "fresh"

    def is_authoritative(self, now: Optional[datetime] = None) -> bool:
        return self.freshness(now) == "fresh" and self.confidence != "unknown" and self.error is None

    def percent_remaining(self) -> Optional[float]:
        """Percentage only when a meaningful (positive) limit is known."""
        if self.remaining is None or not self.limit or self.limit <= 0:
            return None
        return max(0.0, min(100.0, self.remaining / self.limit * 100.0))

    def effective_remaining(self, reserve: float = 0.0, now: Optional[datetime] = None) -> Optional[float]:
        """Remaining raw units minus the safety reserve; None unless authoritative."""
        if self.remaining is None or not self.is_authoritative(now):
            return None
        return max(0.0, self.remaining - max(0.0, reserve))

    def to_dict(self, reserve: float = 0.0, now: Optional[datetime] = None) -> dict:
        now = now or utcnow()
        return {
            "provider": self.provider,
            "window": self.window,
            "source": self.source,
            "confidence": self.confidence,
            "timestamp": _iso(self.timestamp),
            "freshness": self.freshness(now),
            "remaining": self.remaining,
            "limit": self.limit,
            "unit": self.unit,
            "percentRemaining": self.percent_remaining(),
            "reserve": reserve,
            "effectiveRemaining": self.effective_remaining(reserve, now),
            "resetAt": _iso(self.reset_at),
            "ttlSeconds": self.ttl_seconds,
            "retryAfterSeconds": self.retry_after_seconds,
            "error": self.error,
        }


def unknown_snapshot(provider: str, window: str, error: Optional[str] = None, source: str = "unsupported") -> CapacitySnapshot:
    return CapacitySnapshot(provider=provider, window=window, source=source, confidence="unknown", error=error)


class CapacityAdapter:
    """Adapter interface: snapshot(window) -> CapacitySnapshot; must never raise."""

    provider = "unknown"

    def snapshot(self, window: str, now: Optional[datetime] = None) -> CapacitySnapshot:
        raise NotImplementedError


class UnsupportedNativeAdapter(CapacityAdapter):
    """Best-effort native adapter for providers (Codex/Claude CLI) with no supported usage API."""

    def __init__(self, provider: str):
        self.provider = provider

    def snapshot(self, window, now=None):
        return unknown_snapshot(self.provider, window, error="native telemetry unsupported")


class ManualOverrideAdapter(CapacityAdapter):
    """Reads operator-supplied quota entries; manual data is never 'exact'."""

    def __init__(self, provider: str, config: object, default_ttl: int = 6 * 3600):
        self.provider = provider
        self.default_ttl = default_ttl
        self.entries = {}
        self.error = None
        entries = config.get("windows") if isinstance(config, dict) else None
        if not isinstance(entries, dict):
            self.error = "manual override config malformed or missing 'windows'"
            return
        self.entries = {k: v for k, v in entries.items() if k in WINDOWS}

    def snapshot(self, window, now=None):
        if self.error:
            return unknown_snapshot(self.provider, window, self.error, "manual")
        entry = self.entries.get(window)
        if not isinstance(entry, dict):
            return unknown_snapshot(self.provider, window, f"no manual entry for window {window}", "manual")
        remaining, limit = _number(entry.get("remaining")), _number(entry.get("limit"))
        stamp = parse_time(entry.get("updatedAt"))
        if remaining is None or stamp is None:
            return unknown_snapshot(self.provider, window, "manual entry malformed (remaining/updatedAt)", "manual")
        ttl = entry.get("ttlSeconds")
        return CapacitySnapshot(
            provider=self.provider, window=window, source="manual", confidence="estimated",
            timestamp=stamp, remaining=remaining, limit=limit, unit=entry.get("unit"),
            reset_at=parse_time(entry.get("resetAt")),
            ttl_seconds=ttl if isinstance(ttl, int) and ttl > 0 else self.default_ttl,
        )


class ObservedCooldownTracker(CapacityAdapter):
    """Records observed rate-limit errors; a cooldown means remaining is 0 until it ends."""

    def __init__(self, provider: str, base_backoff: float = 30.0, max_backoff: float = 3600.0):
        self.provider = provider
        self.base_backoff, self.max_backoff = base_backoff, max_backoff
        self.failures = 0
        self.cooldowns = {}  # window -> (observed_at, until)

    def backoff_seconds(self, retry_after: Optional[float] = None) -> float:
        computed = min(self.max_backoff, self.base_backoff * (2 ** self.failures))
        ra = _number(retry_after)
        return min(self.max_backoff, max(computed, ra)) if ra is not None else computed

    def record_rate_limit(self, window, retry_after=None, now=None) -> float:
        now = now or utcnow()
        delay = self.backoff_seconds(retry_after)
        self.failures += 1
        self.cooldowns[window] = (now, now + timedelta(seconds=delay))
        return delay

    def record_success(self):
        self.failures = 0

    def snapshot(self, window, now=None):
        now = now or utcnow()
        seen = self.cooldowns.get(window)
        if not seen:
            return unknown_snapshot(self.provider, window, "no rate-limit observed", "observed")
        observed, until = seen
        return CapacitySnapshot(
            provider=self.provider, window=window, source="observed", confidence="estimated",
            timestamp=observed, remaining=0.0, unit="cooldown", reset_at=until,
            ttl_seconds=max(1, int((until - observed).total_seconds())),
            error="rate limited", retry_after_seconds=max(0.0, (until - now).total_seconds()),
        )


def resolve_snapshot(adapters, window, now=None) -> CapacitySnapshot:
    """Most conservative view: an active observed cooldown wins; else manual, else native/unsupported."""
    now = now or utcnow()
    best = None
    for adapter in adapters:
        try:
            snap = adapter.snapshot(window, now)
        except Exception as exc:  # adapters must not break consumers
            snap = unknown_snapshot(getattr(adapter, "provider", "unknown"), window, f"adapter error: {exc}")
        if snap.source == "observed" and snap.freshness(now) == "fresh":
            return snap
        if best is None or (snap.timestamp and snap.freshness(now) == "fresh" and best.freshness(now) != "fresh"):
            best = snap
    return best or unknown_snapshot("unknown", window, "no adapters configured")


def load_json(path) -> object:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None
