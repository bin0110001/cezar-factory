"""Quality gate policy (#611): which checks gate which stage, how strictly, and what happens when a check cannot run.

Library only. The policy is data (`policies/quality-gates.json`); this module validates it, applies repo-type and project
overrides, and answers per-stage questions. Check categories match the provider contract
(`docs/check-provider-contract.md`). Brands never appear here.

Safety rules the validator enforces: a mandatory (required) security check at a promotion stage must fail closed, and a
waiver can only be granted by a human or operator, never by an agent.
"""

from __future__ import annotations

import copy
import fnmatch
import json
from typing import Any

SCHEMA_VERSION = "quality-gates/v1"
CATEGORIES = ("format", "lint", "type", "test", "sast", "sca", "secrets", "iac", "container", "license", "sbom", "complexity", "custom", "ai-audit")
STAGES = ("pr-dev", "candidate", "stable", "periodic", "manual")
LEVELS = ("required", "optional", "advisory", "off")
FAIL_MODES = ("fail-closed", "fail-open")
CADENCES = ("daily", "weekly", "monthly")
PROMOTION_STAGES = ("candidate", "stable")
SECURITY = ("sast", "sca", "secrets", "iac", "container")
SEVERITIES = ("critical", "high", "medium", "low", "info")
GRANTORS = ("human", "operator")


class PolicyError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _merge(base: Any, over: Any) -> Any:
    if isinstance(base, dict) and isinstance(over, dict):
        out = copy.deepcopy(base)
        for k, v in over.items():
            out[k] = _merge(out[k], v) if k in out else copy.deepcopy(v)
        return out
    return copy.deepcopy(over)


def _check_layer(layer: Any, where: str, errors: list[str], *, partial: bool) -> None:
    if not isinstance(layer, dict):
        errors.append(f"{where}: must be an object")
        return
    allowed = {"checks", "cadence", "riskPatterns", "tolerances", "budgets", "waivers"}
    for k in layer:
        if k not in allowed and not k.startswith("x-"):
            errors.append(f"{where}.{k}: unknown field")
    for cat, stages in (layer.get("checks") or {}).items():
        if cat not in CATEGORIES:
            errors.append(f"{where}.checks.{cat}: unknown category (known: {list(CATEGORIES)})")
            continue
        if not isinstance(stages, dict):
            errors.append(f"{where}.checks.{cat}: must be an object keyed by stage")
            continue
        for stage, spec in stages.items():
            here = f"{where}.checks.{cat}.{stage}"
            if stage not in STAGES:
                errors.append(f"{here}: unknown stage (known: {list(STAGES)})")
                continue
            spec = {"level": spec} if isinstance(spec, str) else spec
            if not isinstance(spec, dict) or spec.get("level") not in LEVELS:
                errors.append(f"{here}.level: must be one of {list(LEVELS)}")
                continue
            if spec.get("onUnavailable") not in (None, *FAIL_MODES):
                errors.append(f"{here}.onUnavailable: must be one of {list(FAIL_MODES)}")
            if cat in SECURITY and stage in PROMOTION_STAGES and spec["level"] == "required" and spec.get("onUnavailable", "fail-closed") != "fail-closed":
                errors.append(f"{here}.onUnavailable: a required security check must fail closed at a promotion stage")
    for cat, cad in (layer.get("cadence") or {}).items():
        if cat not in CATEGORIES:
            errors.append(f"{where}.cadence.{cat}: unknown category")
        elif cad not in CADENCES:
            errors.append(f"{where}.cadence.{cat}: must be one of {list(CADENCES)}")
    for i, rp in enumerate(layer.get("riskPatterns") or []):
        if not isinstance(rp, dict) or not rp.get("id") or not isinstance(rp.get("globs"), list) or not rp["globs"]:
            errors.append(f"{where}.riskPatterns[{i}]: needs an id and a non-empty globs list")
            continue
        for cat, stage in (rp.get("escalate") or {}).items():
            if cat not in CATEGORIES or stage not in STAGES:
                errors.append(f"{where}.riskPatterns[{i}].escalate.{cat}: unknown category or stage {stage!r}")
    tol = layer.get("tolerances") or {}
    for sev, n in tol.get("maxNewFindings", {}).items():
        if sev not in SEVERITIES or isinstance(n, bool) or not isinstance(n, int) or n < 0:
            errors.append(f"{where}.tolerances.maxNewFindings.{sev}: needs a known severity and a non-negative integer")
    if "baselineMaxAgeDays" in tol and (not isinstance(tol["baselineMaxAgeDays"], int) or tol["baselineMaxAgeDays"] < 1):
        errors.append(f"{where}.tolerances.baselineMaxAgeDays: must be a positive integer")
    for stage, b in (layer.get("budgets") or {}).items():
        if stage not in STAGES:
            errors.append(f"{where}.budgets.{stage}: unknown stage")
        elif not isinstance(b, dict) or not all(isinstance(b.get(k), (int, float)) and b[k] > 0 for k in b):
            errors.append(f"{where}.budgets.{stage}: values must be positive numbers (maxMinutes, maxCostUnits)")
    w = layer.get("waivers")
    if w is not None:
        grantors = w.get("grantedBy") if isinstance(w, dict) else None
        if not isinstance(grantors, list) or not grantors or any(g not in GRANTORS for g in grantors):
            errors.append(f"{where}.waivers.grantedBy: must be a non-empty subset of {list(GRANTORS)}; a coding agent can never grant a waiver")
        if isinstance(w, dict) and w.get("maxDays") is not None and (not isinstance(w["maxDays"], int) or not 1 <= w["maxDays"] <= 365):
            errors.append(f"{where}.waivers.maxDays: must be 1-365 (waivers expire)")


def validate(doc: Any) -> list[str]:
    if not isinstance(doc, dict):
        return ["document: must be an object"]
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        return [f"schemaVersion: expected {SCHEMA_VERSION!r}, got {doc.get('schemaVersion')!r}"]
    errors: list[str] = []
    for k in doc:
        if k not in ("schemaVersion", "defaults", "repoTypes", "projects") and not k.startswith("x-"):
            errors.append(f"{k}: unknown top-level field")
    if "defaults" not in doc:
        errors.append("defaults: required")
        return errors
    _check_layer(doc["defaults"], "defaults", errors, partial=False)
    for group in ("repoTypes", "projects"):
        for name, layer in (doc.get(group) or {}).items():
            _check_layer(layer, f"{group}.{name}", errors, partial=True)
    if errors:
        return errors
    for name in [None, *(doc.get("projects") or {})]:
        try:
            eff = effective(doc, project=name, repo_type=None, _validated=True)
        except PolicyError as e:  # pragma: no cover - defensive
            errors.extend(e.errors)
            continue
        label = f"projects.{name}" if name else "defaults"
        for cat in CATEGORIES:
            for stage in PROMOTION_STAGES:
                spec = _spec(eff, cat, stage)
                if cat in SECURITY and spec["level"] == "required" and spec["onUnavailable"] != "fail-closed":
                    errors.append(f"{label}: effective {cat}@{stage} is a required security check that does not fail closed")
    return sorted(set(errors))


def load(doc: Any) -> dict[str, Any]:
    errors = validate(doc)
    if errors:
        raise PolicyError(errors)
    return doc


def effective(doc: dict[str, Any], *, project: str | None, repo_type: str | None, _validated: bool = False) -> dict[str, Any]:
    """defaults, then the repo type, then the project. Later layers override earlier ones key by key."""
    if not _validated:
        load(doc)
    eff = copy.deepcopy(doc["defaults"])
    if repo_type:
        eff = _merge(eff, (doc.get("repoTypes") or {}).get(repo_type, {}))
    if project:
        eff = _merge(eff, (doc.get("projects") or {}).get(project, {}))
    return eff


def _spec(eff: dict[str, Any], category: str, stage: str) -> dict[str, str]:
    raw = ((eff.get("checks") or {}).get(category) or {}).get(stage, "off")
    spec = {"level": raw} if isinstance(raw, str) else dict(raw)
    spec.setdefault("onUnavailable", "fail-closed" if spec["level"] == "required" and category in SECURITY and stage in PROMOTION_STAGES else "fail-open")
    return spec


def stage_matrix(eff: dict[str, Any], stage: str) -> dict[str, dict[str, str]]:
    """Every category's level and unavailable-behaviour at `stage` (categories that are `off` are omitted)."""
    return {c: s for c in CATEGORIES if (s := _spec(eff, c, stage))["level"] != "off"}


def escalated_stage_matrix(eff: dict[str, Any], stage: str, changed_paths: list[str]) -> dict[str, dict[str, str]]:
    """Add the checks a risky change pattern pulls forward into `stage` (e.g. dependency files trigger SCA on PRs)."""
    matrix = stage_matrix(eff, stage)
    for rp in eff.get("riskPatterns") or []:
        if any(fnmatch.fnmatch(p, g) for p in changed_paths for g in rp["globs"]):
            for cat, at in (rp.get("escalate") or {}).items():
                if at == stage and matrix.get(cat, {}).get("level") != "required":
                    matrix[cat] = {"level": "required", "onUnavailable": _spec(eff, cat, stage)["onUnavailable"], "reason": f"risk pattern {rp['id']}"}
    return matrix


def is_blocking(eff: dict[str, Any], category: str, stage: str, status: str) -> bool:
    """Does a check outcome block at this stage? `unknown`/`error` follow the fail mode; `fail` blocks only if required."""
    spec = _spec(eff, category, stage)
    if spec["level"] in ("off", "advisory"):
        return False
    if status in ("pass", "warn", "not-applicable"):  # not-applicable is decided by capability planning and never blocks
        return False
    if status == "fail":
        return spec["level"] == "required"
    return spec["level"] == "required" and spec["onUnavailable"] == "fail-closed"


def cadence_of(eff: dict[str, Any], category: str) -> str | None:
    return (eff.get("cadence") or {}).get(category)


def dumps(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=2, sort_keys=False) + "\n"

