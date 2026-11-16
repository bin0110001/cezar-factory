"""Release-pipeline configuration contract (#589).

Pure, stdlib-only library (no CLI: Factory scripts run from workflow steps). It validates a versioned,
project-scoped release pipeline, resolves inherited defaults plus per-project overrides, hashes the effective
configuration so a candidate can be bound to it, and refuses weakening of approval/security policy by an agent.

Nothing here names a branch or a schedule: both are data. The legacy two-branch behaviour is the default.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from typing import Any

SCHEMA_VERSION = "release-pipeline/v1"
MODES = ("two-branch", "three-branch")
STAGE_KINDS = ("integration", "regression", "stable")
FREQUENCIES = ("daily", "weekly")
STABLE_KINDS = ("auto", "approval")
REVIEW_KINDS = ("self-review", "approval")
EMERGENCY = ("forward-port", "cherry-pick", "none")
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

# Fields only an operator may weaken; an agent-authored change that lowers any of them is refused.
SECURITY_PATHS = (
    "promotion.stable", "promotion.review", "promotion.soakMinutes",
    "admission.maxActiveCandidates", "tests.required",
)


class ConfigError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def default_spec() -> dict[str, Any]:
    """Existing two-stage behaviour: integrate on dev, promote to stable behind human approval."""
    return {
        "mode": "two-branch",
        "stages": [
            {"id": "dev", "branch": "dev", "kind": "integration"},
            {"id": "stable", "branch": "stable", "kind": "stable"},
        ],
        "triggers": {"manual": True, "afterChanges": {"enabled": False}},
        "admission": {"maxActiveCandidates": 1},
        "tests": {"suites": [], "required": []},
        "candidateLifetimeHours": 72,
        "repair": {"maxAttempts": 3, "backoffMinutes": 30},
        "promotion": {"review": "approval", "stable": "approval", "soakMinutes": 0},
        "artifactRetentionDays": 30,
        "notifications": {"channels": []},
        "emergencyFix": {"strategy": "forward-port"},
    }


PRESETS: dict[str, dict[str, Any]] = {
    # Hour and day are intentionally absent: the project supplies them (nothing is assumed).
    "weekly-calendar": {
        "mode": "three-branch",
        "stages": [
            {"id": "dev", "branch": "dev", "kind": "integration"},
            {"id": "regression", "branch": "regression", "kind": "regression"},
            {"id": "stable", "branch": "stable", "kind": "stable"},
        ],
        "triggers": {"manual": True, "schedule": {"frequency": "weekly", "timezone": "America/Detroit"}},
    },
    "daily-calendar": {
        "mode": "three-branch",
        "stages": [
            {"id": "dev", "branch": "dev", "kind": "integration"},
            {"id": "regression", "branch": "regression", "kind": "regression"},
            {"id": "stable", "branch": "stable", "kind": "stable"},
        ],
        "triggers": {"manual": True, "schedule": {"frequency": "daily", "timezone": "America/Detroit"}},
    },
}


def merge(base: Any, over: Any) -> Any:
    """Deep merge; dicts merge, everything else (including lists and stage graphs) is replaced whole."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = copy.deepcopy(base)
        for key, value in over.items():
            out[key] = merge(out[key], value) if key in out else copy.deepcopy(value)
        return out
    return copy.deepcopy(over)


_SHAPE: dict[str, Any] = {
    "mode": str, "stages": list, "triggers": {"manual": bool, "schedule": {"frequency": str, "dayOfWeek": str, "hour": int, "minute": int, "timezone": str},
                                              "afterChanges": {"enabled": bool, "minCommits": int, "minFiles": int, "paths": list, "minElapsedHours": int, "maxDelayHours": int,
                                                             "cooldownMinutes": int, "quietHours": {"start": int, "end": int, "timezone": str}, "combinator": str},
                                              "missedRun": str, "missedGraceMinutes": int, "priority": list},
    "admission": {"maxActiveCandidates": int}, "tests": {"suites": list, "required": list},
    "candidateLifetimeHours": int, "repair": {"maxAttempts": int, "backoffMinutes": int},
    "promotion": {"review": str, "stable": str, "soakMinutes": int}, "artifactRetentionDays": int,
    "notifications": {"channels": list}, "emergencyFix": {"strategy": str},
}


def _unknown(spec: Any, shape: Any, path: str, errors: list[str]) -> None:
    if not isinstance(spec, dict) or not isinstance(shape, dict):
        return
    for key, value in spec.items():
        if key.startswith("x-"):  # deliberate extension namespace, preserved but never interpreted
            continue
        here = f"{path}.{key}" if path else key
        if key not in shape:
            errors.append(f"{here}: unknown field (extensions must start with 'x-')")
            continue
        expected = shape[key]
        if isinstance(expected, dict):
            if not isinstance(value, dict):
                errors.append(f"{here}: must be an object")
            else:
                _unknown(value, expected, here, errors)
        elif expected is int:
            if isinstance(value, bool) or not isinstance(value, int):
                errors.append(f"{here}: must be an integer")
        elif not isinstance(value, expected):
            errors.append(f"{here}: must be {expected.__name__}")


def _timezone_ok(name: str) -> bool:
    try:
        import zoneinfo
        known = zoneinfo.available_timezones()
        if known:
            return name in known
    except Exception:  # noqa: BLE001 - tz database unavailable: fall back to shape
        pass
    return bool(re.fullmatch(r"[A-Za-z_]+(?:/[A-Za-z0-9_+-]+){1,2}|UTC", name))


def validate_spec(spec: dict[str, Any], where: str = "spec") -> list[str]:
    """Validate a fully resolved spec. Returns every error with its path."""
    errors: list[str] = []
    _unknown(spec, _SHAPE, where, errors)
    if errors:
        return errors
    g = lambda *p: _dig(spec, p)  # noqa: E731
    mode = g("mode")
    if mode not in MODES:
        errors.append(f"{where}.mode: must be one of {list(MODES)}")
    stages = g("stages") or []
    ids, branches = set(), set()
    for i, st in enumerate(stages):
        if not isinstance(st, dict) or not {"id", "branch", "kind"} <= set(st):
            errors.append(f"{where}.stages[{i}]: needs id, branch and kind")
            continue
        if st["kind"] not in STAGE_KINDS:
            errors.append(f"{where}.stages[{i}].kind: must be one of {list(STAGE_KINDS)}")
        if not re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", str(st["branch"])) or ".." in str(st["branch"]) or str(st["branch"]).startswith(("/", "-")):
            errors.append(f"{where}.stages[{i}].branch: not a safe branch name")
        if st["id"] in ids:
            errors.append(f"{where}.stages[{i}].id: duplicate stage id {st['id']}")
        if st["branch"] in branches:
            errors.append(f"{where}.stages[{i}].branch: branch/ref collision on {st['branch']}")
        ids.add(st["id"])
        branches.add(st["branch"])
    kinds = [s.get("kind") for s in stages if isinstance(s, dict)]
    want = {"two-branch": ["integration", "stable"], "three-branch": ["integration", "regression", "stable"]}.get(mode)
    if want is not None and kinds != want:
        errors.append(f"{where}.stages: {mode} requires kinds {want}, got {kinds}")

    sched = g("triggers", "schedule")
    if sched is not None:
        if sched.get("frequency") not in FREQUENCIES:
            errors.append(f"{where}.triggers.schedule.frequency: must be one of {list(FREQUENCIES)}")
        for field in ("hour", "timezone"):
            if field not in sched:
                errors.append(f"{where}.triggers.schedule.{field}: required (not assumed by a preset)")
        if "hour" in sched and not (isinstance(sched["hour"], int) and 0 <= sched["hour"] <= 23):
            errors.append(f"{where}.triggers.schedule.hour: must be 0-23")
        if "minute" in sched and not (isinstance(sched["minute"], int) and 0 <= sched["minute"] <= 59):
            errors.append(f"{where}.triggers.schedule.minute: must be 0-59")
        if "timezone" in sched and not _timezone_ok(str(sched["timezone"])):
            errors.append(f"{where}.triggers.schedule.timezone: unknown timezone {sched['timezone']!r}")
        if sched.get("frequency") == "weekly" and str(sched.get("dayOfWeek", "")).lower() not in DAYS:
            errors.append(f"{where}.triggers.schedule.dayOfWeek: required for weekly, one of {list(DAYS)}")
        if sched.get("frequency") == "daily" and "dayOfWeek" in sched:
            errors.append(f"{where}.triggers.schedule.dayOfWeek: contradicts a daily frequency")
    ac = g("triggers", "afterChanges") or {}
    if ac.get("enabled") and not (ac.get("minCommits") or ac.get("minFiles")):
        errors.append(f"{where}.triggers.afterChanges: enabled needs minCommits or minFiles")
    if g("triggers", "missedRun") not in (None, "skip", "coalesce"):
        errors.append(f"{where}.triggers.missedRun: must be 'skip' or 'coalesce'")
    if ac.get("combinator") not in (None, "any", "all"):
        errors.append(f"{where}.triggers.afterChanges.combinator: must be 'any' or 'all'")
    if ac.get("paths") is not None and not all(isinstance(x, str) and x for x in ac["paths"]):
        errors.append(f"{where}.triggers.afterChanges.paths: must be a list of non-empty globs")
    q = ac.get("quietHours")
    if q is not None:
        if not all(isinstance(q.get(k), int) and 0 <= q[k] <= 23 for k in ("start", "end")):
            errors.append(f"{where}.triggers.afterChanges.quietHours: start and end must be hours 0-23")
        if "timezone" in q and not _timezone_ok(str(q["timezone"])):
            errors.append(f"{where}.triggers.afterChanges.quietHours.timezone: unknown timezone {q['timezone']!r}")
    prio = g("triggers", "priority")
    if prio is not None and (set(prio) - {"schedule", "change", "manual"} or len(set(prio)) != len(prio)):
        errors.append(f"{where}.triggers.priority: must be unique values from schedule, change, manual")
    if mode == "three-branch" and sched is None and not g("triggers", "manual") and not ac.get("enabled"):
        errors.append(f"{where}.triggers: a three-branch pipeline needs at least one trigger")

    if g("admission", "maxActiveCandidates") != 1:
        errors.append(f"{where}.admission.maxActiveCandidates: must be 1 (one active candidate per project)")
    suites, required = g("tests", "suites") or [], g("tests", "required") or []
    for field, items in (("suites", suites), ("required", required)):
        if not all(isinstance(x, str) and x for x in items):
            errors.append(f"{where}.tests.{field}: must be a list of non-empty strings")
    missing = [r for r in required if r not in suites]
    if missing:
        errors.append(f"{where}.tests.required: suites not declared in tests.suites: {missing}")
    if mode == "three-branch" and not required:
        errors.append(f"{where}.tests.required: a regression stage needs at least one required suite")

    review, stable = g("promotion", "review"), g("promotion", "stable")
    if review not in REVIEW_KINDS:
        errors.append(f"{where}.promotion.review: must be one of {list(REVIEW_KINDS)}")
    if stable not in STABLE_KINDS:
        errors.append(f"{where}.promotion.stable: must be one of {list(STABLE_KINDS)}")
    if stable == "auto" and not required:
        errors.append(f"{where}.promotion: stable 'auto' with no required suite is unsafe auto-promotion")
    for path, lo, hi in (("candidateLifetimeHours", 1, 24 * 30), ("artifactRetentionDays", 1, 3650), ("repair.maxAttempts", 0, 20), ("repair.backoffMinutes", 0, 1440), ("promotion.soakMinutes", 0, 10080)):
        v = _dig(spec, tuple(path.split(".")))
        if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
            errors.append(f"{where}.{path}: must be an integer {lo}-{hi}")
    if g("emergencyFix", "strategy") not in EMERGENCY:
        errors.append(f"{where}.emergencyFix.strategy: must be one of {list(EMERGENCY)}")
    if not all(isinstance(c, str) and c for c in (g("notifications", "channels") or [])):
        errors.append(f"{where}.notifications.channels: must be a list of non-empty strings")
    return errors


def _dig(obj: Any, path: tuple[str, ...]) -> Any:
    for key in path:
        if not isinstance(obj, dict) or key not in obj:
            return None
        obj = obj[key]
    return obj


def _major(version: Any) -> int | None:
    m = re.fullmatch(r"release-pipeline/v(\d+)", str(version))
    return int(m.group(1)) if m else None


def validate_document(doc: Any) -> list[str]:
    """Validate the whole document: version, shape, and every project's effective spec."""
    if not isinstance(doc, dict):
        return ["document: must be an object"]
    major = _major(doc.get("schemaVersion"))
    if major is None:
        return [f"schemaVersion: expected {SCHEMA_VERSION!r}, got {doc.get('schemaVersion')!r}"]
    if major > 1:
        return [f"schemaVersion: {doc['schemaVersion']!r} is newer than this reader supports ({SCHEMA_VERSION}); refusing to guess its fields"]
    errors: list[str] = []
    for key in doc:
        if key not in ("schemaVersion", "defaults", "projects") and not key.startswith("x-"):
            errors.append(f"{key}: unknown top-level field")
    if not isinstance(doc.get("projects", {}), dict):
        errors.append("projects: must be an object keyed by project id")
        return errors
    if errors:
        return errors
    for pid in (doc.get("projects") or {"": {}}):
        try:
            effective = resolve(doc, pid) if pid else resolve(doc, None)
        except ConfigError as e:
            errors.extend(e.errors)
            continue
        errors.extend(validate_spec(effective, f"projects.{pid}" if pid else "defaults"))
    return errors


def resolve(doc: dict[str, Any], project: str | None) -> dict[str, Any]:
    """Effective spec: built-in default, then document defaults (and named presets), then the project override."""
    errors: list[str] = []
    spec = default_spec()
    for label, layer in (("defaults", doc.get("defaults") or {}), (f"projects.{project}", (doc.get("projects") or {}).get(project, {}) if project else {})):
        if not isinstance(layer, dict):
            errors.append(f"{label}: must be an object")
            continue
        layer = dict(layer)
        preset = layer.pop("preset", None)
        if preset is not None:
            if preset not in PRESETS:
                errors.append(f"{label}.preset: unknown preset {preset!r}; known: {sorted(PRESETS)}")
            else:
                spec = merge(spec, PRESETS[preset])
        spec = merge(spec, layer)
    if errors:
        raise ConfigError(errors)
    return spec


def effective_config(doc: dict[str, Any], project: str | None) -> dict[str, Any]:
    """Validated effective configuration (the dry run and readback share this)."""
    errors = validate_document(doc)
    if errors:
        raise ConfigError(errors)
    return resolve(doc, project)


def config_hash(spec: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def migrate(doc: Any) -> dict[str, Any]:
    """Upgrade a legacy flat spec (no schemaVersion) to the v1 document; a v1 document round-trips unchanged."""
    if isinstance(doc, dict) and doc.get("schemaVersion") is not None:
        if _major(doc["schemaVersion"]) is None or _major(doc["schemaVersion"]) > 1:
            raise ConfigError([f"schemaVersion: cannot migrate {doc['schemaVersion']!r}"])
        return copy.deepcopy(doc)
    if not isinstance(doc, dict):
        raise ConfigError(["document: must be an object"])
    return {"schemaVersion": SCHEMA_VERSION, "defaults": copy.deepcopy(doc), "projects": {}}


def bind_candidate(candidate: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    """Record the effective configuration on a new candidate. An existing binding is never replaced."""
    if candidate.get("configHash"):
        return candidate
    return {**candidate, "configHash": config_hash(spec), "config": copy.deepcopy(spec)}


def spec_for_candidate(candidate: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """A policy change applies only to future candidate revisions: a bound candidate keeps its own snapshot."""
    return candidate["config"] if candidate.get("configHash") else current


_ORDER = {"promotion.stable": {"approval": 1, "auto": 0}, "promotion.review": {"approval": 1, "self-review": 0}}


def weakened_fields(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """Security-sensitive fields that `new` makes weaker than `old`."""
    out: list[str] = []
    for path, order in _ORDER.items():
        o, n = _dig(old, tuple(path.split("."))), _dig(new, tuple(path.split(".")))
        if order.get(n, -1) < order.get(o, -1):
            out.append(path)
    if (_dig(new, ("promotion", "soakMinutes")) or 0) < (_dig(old, ("promotion", "soakMinutes")) or 0):
        out.append("promotion.soakMinutes")
    if (_dig(new, ("admission", "maxActiveCandidates")) or 0) > (_dig(old, ("admission", "maxActiveCandidates")) or 0):
        out.append("admission.maxActiveCandidates")
    if set(_dig(old, ("tests", "required")) or []) - set(_dig(new, ("tests", "required")) or []):
        out.append("tests.required")
    return out


def authorize_change(old: dict[str, Any], new: dict[str, Any], actor: str) -> list[str]:
    """Return the reasons a change is refused. Only an `operator` may weaken approval/security policy."""
    if actor == "operator":
        return []
    return [f"{p}: an {actor} may not weaken this operator-controlled policy" for p in weakened_fields(old, new)]
