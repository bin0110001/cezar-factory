"""Subscription profiles and independent capacity windows (issue #89).

Stdlib only. A profile is one subscription account of a provider: its own adapters,
allowed models, concurrency and rolling/fixed windows. Secrets never live here, only an
opaque ``credentialRef`` into the existing credential store. API billing usage is a
separate type and is never counted as subscription usage. No scheduling or routing
decisions are made here. See docs/subscription-profiles.md.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

SCHEMA_VERSION = 2
STATES = ("unknown", "available", "constrained", "exhausted", "stale", "disabled")
WINDOW_KINDS = ("rolling", "fixed")
CONFIDENCES = ("exact", "estimated", "unknown")
SOURCES = ("native", "manual", "observed", "unsupported")
# Observation clocks may disagree by up to this much without flipping state.
CLOCK_DRIFT_TOLERANCE_SECONDS = 120
DEFAULT_STALENESS_SECONDS = 900
CONSTRAINED_FRACTION = 0.2  # remaining/limit at or below this is "constrained"

# Allow-lists: the only fields that ever leave this module in a payload or log.
PROFILE_PUBLIC_FIELDS = ("id", "provider", "accountLabel", "adapters", "enabled", "maxConcurrency", "allowedModelIds")
WINDOW_PUBLIC_FIELDS = ("name", "kind", "durationSeconds", "resetAt", "unit", "limit", "remaining",
                        "confidence", "source", "observedAt", "stalenessSeconds")
SECRET_KEY_HINTS = ("secret", "token", "password", "apikey", "api_key", "authorization", "cookie")


class ProfileError(ValueError):
    pass


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


def _num(value) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return float(value)


# ---- migration -------------------------------------------------------------------------

def _migrate_1_to_2(store: dict) -> dict:
    """v1 used top-level 'accounts' with 'models'/'concurrency' and single 'fiveHour'/'weekly' blocks."""
    profiles = []
    for acct in store.get("accounts", []):
        windows = []
        for key, name, seconds, kind in (("fiveHour", "5h", 5 * 3600, "rolling"), ("weekly", "weekly", 7 * 86400, "fixed")):
            w = acct.get(key)
            if isinstance(w, dict):
                windows.append({"name": name, "kind": kind, "durationSeconds": seconds, "resetAt": w.get("resetAt"),
                                "unit": w.get("unit"), "limit": w.get("limit"), "remaining": w.get("remaining"),
                                "confidence": w.get("confidence", "unknown"), "source": w.get("source", "manual"),
                                "observedAt": w.get("observedAt"), "stalenessSeconds": DEFAULT_STALENESS_SECONDS})
        profiles.append({"id": acct.get("id"), "provider": acct.get("provider"), "accountLabel": acct.get("label", ""),
                         "adapters": acct.get("adapters", []), "enabled": acct.get("enabled", True),
                         "maxConcurrency": acct.get("concurrency", 1), "allowedModelIds": acct.get("models", []),
                         "credentialRef": acct.get("credentialRef"), "windows": windows})
    return {"schemaVersion": 2, "profiles": profiles}


MIGRATIONS = {1: _migrate_1_to_2}


def migrate(store: dict) -> dict:
    """Forward-migrate to SCHEMA_VERSION; reject missing, non-integer or newer versions."""
    if not isinstance(store, dict):
        raise ProfileError("store must be an object")
    version = store.get("schemaVersion")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ProfileError("schemaVersion must be a positive integer")
    if version > SCHEMA_VERSION:
        raise ProfileError(f"unknown newer schemaVersion {version}; this reader supports up to {SCHEMA_VERSION}")
    store = copy.deepcopy(store)
    while store["schemaVersion"] < SCHEMA_VERSION:
        store = MIGRATIONS[store["schemaVersion"]](store)
    return store


# ---- validation ------------------------------------------------------------------------

def validate_profile(p: dict) -> list:
    errors = []
    if not isinstance(p, dict):
        return ["profile must be an object"]
    pid = p.get("id")
    for f in ("id", "provider", "accountLabel"):
        if not isinstance(p.get(f), str) or not p.get(f):
            errors.append(f"{pid}: {f} must be a non-empty string")
    if not isinstance(p.get("enabled"), bool):
        errors.append(f"{pid}: enabled must be boolean")
    mc = p.get("maxConcurrency")
    if isinstance(mc, bool) or not isinstance(mc, int) or mc < 1:
        errors.append(f"{pid}: maxConcurrency must be an integer >= 1")
    for f in ("adapters", "allowedModelIds"):
        v = p.get(f)
        if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
            errors.append(f"{pid}: {f} must be a list of strings")
    ref = p.get("credentialRef")
    if not isinstance(ref, str) or not ref:
        errors.append(f"{pid}: credentialRef must be an opaque reference string")
    for key in p:
        if any(h in key.lower() for h in SECRET_KEY_HINTS) and key != "credentialRef":
            errors.append(f"{pid}: field {key} looks like a secret; store a credentialRef instead")
    windows = p.get("windows")
    if not isinstance(windows, list):
        errors.append(f"{pid}: windows must be a list")
        windows = []
    names = set()
    for w in windows:
        name = w.get("name") if isinstance(w, dict) else None
        if not isinstance(w, dict) or not isinstance(name, str) or not name:
            errors.append(f"{pid}: window needs a name")
            continue
        if name in names:
            errors.append(f"{pid}: duplicate window {name}")
        names.add(name)
        if w.get("kind") not in WINDOW_KINDS:
            errors.append(f"{pid}/{name}: kind must be one of {WINDOW_KINDS}")
        if _num(w.get("durationSeconds")) in (None, 0.0):
            errors.append(f"{pid}/{name}: durationSeconds must be a positive number")
        if w.get("confidence") not in CONFIDENCES:
            errors.append(f"{pid}/{name}: confidence must be one of {CONFIDENCES}")
        if w.get("source") not in SOURCES:
            errors.append(f"{pid}/{name}: source must be one of {SOURCES}")
        for f in ("limit", "remaining"):
            if w.get(f) is not None and _num(w.get(f)) is None:
                errors.append(f"{pid}/{name}: {f} must be a non-negative number or null")
        for f in ("resetAt", "observedAt"):
            if w.get(f) is not None and parse_time(w.get(f)) is None:
                errors.append(f"{pid}/{name}: {f} must be an ISO-8601 time or null")
    return errors


def load_store(store: dict) -> dict:
    """Migrate then validate; raises ProfileError listing every problem."""
    store = migrate(store)
    profiles = store.get("profiles")
    if not isinstance(profiles, list):
        raise ProfileError("profiles must be a list")
    errors, ids = [], set()
    for p in profiles:
        errors += validate_profile(p)
        pid = p.get("id") if isinstance(p, dict) else None
        if pid in ids:
            errors.append(f"duplicate profile id {pid}")
        ids.add(pid)
    if errors:
        raise ProfileError("; ".join(errors))
    return store


def load_file(path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return load_store(json.load(fh))


# ---- evaluation ------------------------------------------------------------------------

_SEVERITY = {"available": 0, "constrained": 1, "stale": 2, "unknown": 2, "exhausted": 3}


def _effective_remaining(w: dict, now: datetime):
    """Return (remaining, reset_applied). A window past resetAt (beyond drift) counts as reset."""
    reset = parse_time(w.get("resetAt"))
    limit = _num(w.get("limit"))
    tol = timedelta(seconds=CLOCK_DRIFT_TOLERANCE_SECONDS)
    if reset is not None and now >= reset + tol and limit is not None:
        return limit, True
    return _num(w.get("remaining")), False


def evaluate_window(w: dict, now: datetime) -> str:
    """One of available, constrained, exhausted, stale, unknown for a single window."""
    remaining, reset_applied = _effective_remaining(w, now)
    if not reset_applied:
        observed = parse_time(w.get("observedAt"))
        if observed is None or remaining is None:
            return "unknown"
        bound = _num(w.get("stalenessSeconds")) or DEFAULT_STALENESS_SECONDS
        age = (now - observed).total_seconds()
        if age > bound + CLOCK_DRIFT_TOLERANCE_SECONDS:
            return "stale"
    if remaining is None:
        return "unknown"
    if remaining <= 0:
        return "exhausted"
    limit = _num(w.get("limit"))
    if limit and remaining / limit <= CONSTRAINED_FRACTION:
        return "constrained"
    return "available"


def evaluate_state(profile: dict, now: Optional[datetime] = None,
                   clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> str:
    """Exactly one of STATES. Pure: depends only on the profile and the supplied time.

    Disabled wins; otherwise the most constrained window decides. Windows are independent,
    but a profile with no windows is unknown. API billing is not read here.
    """
    now = now or clock()
    if not profile.get("enabled", False):
        return "disabled"
    windows = profile.get("windows") or []
    if not windows:
        return "unknown"
    states = [evaluate_window(w, now) for w in windows]
    return max(states, key=lambda s: _SEVERITY[s])


def evaluate_store(store: dict, now: Optional[datetime] = None) -> dict:
    """Evaluate each profile independently; keys are profile ids."""
    now = now or datetime.now(timezone.utc)
    return {p["id"]: evaluate_state(p, now) for p in store["profiles"]}


def allows_model(profile: dict, model_id: str) -> bool:
    return model_id in profile.get("allowedModelIds", [])


# ---- API billing (separate type) -------------------------------------------------------

class ApiBillingUsage:
    """Pay-per-token API spend. Deliberately not a window and never added to subscription usage."""

    def __init__(self, provider: str, amount: float, currency: str = "USD", period: Optional[str] = None):
        self.provider, self.amount, self.currency, self.period = provider, float(amount), currency, period

    def to_dict(self) -> dict:
        return {"type": "apiBilling", "provider": self.provider, "amount": self.amount,
                "currency": self.currency, "period": self.period}


# ---- redacting serializers -------------------------------------------------------------

def serialize_window(w: dict) -> dict:
    return {k: w.get(k) for k in WINDOW_PUBLIC_FIELDS}


def serialize_profile(profile: dict, now: Optional[datetime] = None) -> dict:
    """Allow-list serializer for API payloads and logs; credentialRef and unknown keys are dropped."""
    out = {k: copy.deepcopy(profile.get(k)) for k in PROFILE_PUBLIC_FIELDS}
    out["windows"] = [serialize_window(w) for w in profile.get("windows", [])]
    out["state"] = evaluate_state(profile, now)
    return out
