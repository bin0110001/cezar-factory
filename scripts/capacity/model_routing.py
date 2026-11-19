"""Capability-tier model routing (issue #92).

Stdlib only, pure and deterministic. A task names a capability *tier* (or pins an exact
model/account). Tier membership is explicit user config: models are never assumed equivalent.
Eligibility consumes subscription profiles (#89) through plain dicts, so capacity, concurrency
and allowed models are read, never redefined. See docs/model-routing.md.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

try:
    import subscription_profiles as sp
except ImportError:  # load by path so the module works from any entry point
    import importlib.util
    import sys
    from pathlib import Path
    _spec = importlib.util.spec_from_file_location("subscription_profiles", Path(__file__).with_name("subscription_profiles.py"))
    sp = importlib.util.module_from_spec(_spec)
    sys.modules["subscription_profiles"] = sp
    _spec.loader.exec_module(sp)

SCHEMA_VERSION = 1
FALLBACKS = ("allow", "none")
LOCALITIES = ("local", "remote")
# Profile states that can never take work; unknown/stale are allowed but rank behind healthy accounts.
BLOCKING_STATES = ("exhausted", "disabled")
STATE_RANK = {"available": 0, "constrained": 1, "unknown": 2, "stale": 2}
CAPACITY_REASONS = ("capacity-exhausted", "concurrency-limit", "account-disabled", "fallback-disabled")

ROUTED, DEFERRED, FAILED = "routed", "deferred", "failed"


class RoutingConfigError(ValueError):
    pass


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def load_config(path) -> dict:
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    errors = validate_config(cfg)
    if errors:
        raise RoutingConfigError("; ".join(errors))
    return cfg


def _model_meets(model: dict, req: dict) -> list:
    """Reasons a model's declared features fail a tier requirement (empty = meets it)."""
    f = model.get("features", {})
    out = []
    if req.get("tools") and not f.get("tools"):
        out.append("missing-feature:tools")
    if req.get("multimodal") and not f.get("multimodal"):
        out.append("missing-feature:multimodal")
    if _is_num(req.get("minContextTokens")) and f.get("contextTokens", 0) < req["minContextTokens"]:
        out.append("context-too-small")
    if _is_num(req.get("minCoding")) and f.get("coding", 0) < req["minCoding"]:
        out.append("coding-below-minimum")
    if _is_num(req.get("minReasoning")) and f.get("reasoning", 0) < req["minReasoning"]:
        out.append("reasoning-below-minimum")
    if req.get("locality") and f.get("locality") != req["locality"]:
        out.append("locality-mismatch")
    return out


def validate_config(cfg: dict, profiles: Optional[list] = None) -> list:
    """Return a list of clear error strings (empty = valid). Tiers are optional (additive config)."""
    errors = []
    if not isinstance(cfg, dict):
        return ["config must be an object"]
    if cfg.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION}")
    models = cfg.get("models", {})
    tiers = cfg.get("tiers", {})
    if not isinstance(models, dict) or not isinstance(tiers, dict):
        return errors + ["models and tiers must be objects"]
    for alias, m in models.items():
        if not isinstance(m, dict) or not m.get("provider") or not m.get("modelId"):
            errors.append(f"model '{alias}': provider and modelId are required")
            continue
        f = m.get("features", {})
        if not isinstance(f, dict):
            errors.append(f"model '{alias}': features must be an object")
            continue
        if f.get("locality") is not None and f["locality"] not in LOCALITIES:
            errors.append(f"model '{alias}': locality must be one of {list(LOCALITIES)}")
        for key in ("contextTokens", "coding", "reasoning", "quality"):
            if key in f and (not _is_num(f[key]) or f[key] < 0):
                errors.append(f"model '{alias}': {key} must be a non-negative number")
    known_accounts = {p["id"] for p in profiles} if profiles is not None else None
    for name, t in tiers.items():
        if not isinstance(t, dict):
            errors.append(f"tier '{name}': must be an object")
            continue
        cands = t.get("candidates")
        if not isinstance(cands, list) or not cands:
            errors.append(f"tier '{name}': candidates must be a non-empty list")
            cands = []
        for alias in cands:
            if alias not in models:
                errors.append(f"tier '{name}': candidate '{alias}' is not a defined model")
        allow, deny = t.get("providerAllow", []), t.get("providerDeny", [])
        if not isinstance(allow, list) or not isinstance(deny, list):
            errors.append(f"tier '{name}': providerAllow/providerDeny must be lists")
            allow, deny = [], []
        if set(allow) & set(deny):
            errors.append(f"tier '{name}': provider(s) {sorted(set(allow) & set(deny))} are both allowed and denied")
        if t.get("fallback", "allow") not in FALLBACKS:
            errors.append(f"tier '{name}': fallback must be one of {list(FALLBACKS)}")
        affinity = t.get("accountAffinity", [])
        if not isinstance(affinity, list):
            errors.append(f"tier '{name}': accountAffinity must be a list")
        elif known_accounts is not None:
            for acct in affinity:
                if acct not in known_accounts:
                    errors.append(f"tier '{name}': accountAffinity '{acct}' is not a known subscription profile")
        min_q = t.get("minQuality")
        if min_q is not None and not _is_num(min_q):
            errors.append(f"tier '{name}': minQuality must be a number")
            continue
        usable = [a for a in cands if a in models and isinstance(models[a], dict)
                  and (not allow or models[a].get("provider") in allow)
                  and models[a].get("provider") not in deny
                  and not _model_meets(models[a], t.get("require", {}))
                  and (min_q is None or models[a].get("features", {}).get("quality", 0) >= min_q)]
        if cands and all(a in models for a in cands) and not usable:
            errors.append(f"tier '{name}': unsatisfiable, no candidate meets its requirements, provider policy and minQuality")
    return errors


def _profile_index(profiles: list, now: datetime) -> dict:
    return {p["id"]: (p, sp.evaluate_state(p, now)) for p in profiles}


def _account_rejections(profile: dict, state: str, model: dict, active: dict) -> list:
    out = []
    if profile.get("provider") != model.get("provider"):
        out.append("account-provider-mismatch")
    if not sp.allows_model(profile, model["modelId"]):
        out.append("model-not-allowed-on-account")
    if state == "disabled":
        out.append("account-disabled")
    elif state == "exhausted":
        out.append("capacity-exhausted")
    limit = profile.get("maxConcurrency")
    if _is_num(limit) and active.get(profile["id"], 0) >= limit:
        out.append("concurrency-limit")
    return out


def _decision(status, reason, rejections, selected=None, tier=None, pinned=False, fallback=False):
    return {"schemaVersion": SCHEMA_VERSION, "status": status, "tier": tier, "pinned": pinned,
            "selected": selected, "reason": reason, "fallback": fallback, "rejections": rejections}


def _terminal(rejections, tier, pinned):
    """No candidate: deferred when every rejection is capacity-only, otherwise failed."""
    reasons = [r for rej in rejections for r in rej["reasons"]]
    capacity_only = bool(reasons) and all(r in CAPACITY_REASONS for r in reasons)
    status = DEFERRED if capacity_only else FAILED
    word = "capacity unavailable" if capacity_only else "no eligible candidate"
    return _decision(status, f"{word} for {'pinned target' if pinned else 'tier ' + str(tier)}", rejections, tier=tier, pinned=pinned)


def route(task: dict, config: dict, profiles: list, now: Optional[datetime] = None,
          active: Optional[dict] = None) -> dict:
    """Deterministically choose a model/account for one attempt.

    task: {"tier": name} or {"pinned": {"model": alias, "account": profileId?}}.
    active: {profileId: running attempts} used for the concurrency check.
    Returns a decision dict (status routed|deferred|failed) holding the selection, the routing
    reason and every candidate rejection, ready to persist on the attempt. Never mutates input.
    """
    now = now or datetime.now(timezone.utc)
    active = active or {}
    index = _profile_index(profiles, now)
    models = config.get("models", {})
    pin = task.get("pinned")
    if pin:
        alias, account = pin.get("model"), pin.get("account")
        rejections = []
        if alias not in models:
            return _decision(FAILED, f"pinned model '{alias}' is not defined", [{"model": alias, "account": account, "reasons": ["unknown-model"]}], pinned=True)
        accounts = [account] if account else sorted(index)
        for acct in accounts:
            if acct not in index:
                rejections.append({"model": alias, "account": acct, "reasons": ["unknown-account"]})
                continue
            profile, state = index[acct]
            reasons = _account_rejections(profile, state, models[alias], active)
            if reasons:
                rejections.append({"model": alias, "account": acct, "reasons": reasons})
                continue
            sel = {"model": alias, "modelId": models[alias]["modelId"], "provider": models[alias]["provider"], "account": acct}
            return _decision(ROUTED, f"pinned to {alias} on {acct}", rejections, selected=sel, pinned=True)
        return _terminal(rejections, None, True)

    tier_name = task.get("tier")
    tier = config.get("tiers", {}).get(tier_name)
    if tier is None:
        return _decision(FAILED, f"unknown tier '{tier_name}'", [], tier=tier_name)
    require = dict(tier.get("require", {}))
    require.update(task.get("require", {}))
    allow, deny = tier.get("providerAllow", []), tier.get("providerDeny", [])
    affinity = list(task.get("accountAffinity") or tier.get("accountAffinity", []))
    min_q = tier.get("minQuality")
    fallback_ok = tier.get("fallback", "allow") == "allow"
    rejections, eligible = [], []
    for pref, alias in enumerate(tier["candidates"]):
        model = models[alias]
        model_reasons = _model_meets(model, require)
        if allow and model["provider"] not in allow:
            model_reasons.append("provider-not-allowed")
        if model["provider"] in deny:
            model_reasons.append("provider-denied")
        if min_q is not None and model.get("features", {}).get("quality", 0) < min_q:
            model_reasons.append("below-minimum-quality")
        if model_reasons:
            rejections.append({"model": alias, "account": None, "reasons": model_reasons})
            continue
        if pref > 0 and not fallback_ok:
            rejections.append({"model": alias, "account": None, "reasons": ["fallback-disabled"]})
            continue
        for acct in sorted(index):
            profile, state = index[acct]
            reasons = _account_rejections(profile, state, model, active)
            if reasons:
                if "account-provider-mismatch" not in reasons:  # unrelated providers are noise
                    rejections.append({"model": alias, "account": acct, "reasons": reasons})
                continue
            rank = (pref, affinity.index(acct) if acct in affinity else len(affinity), STATE_RANK.get(state, 2), acct)
            eligible.append((rank, alias, acct, state))
    if not eligible:
        return _terminal(rejections, tier_name, False)
    eligible.sort()
    rank, alias, acct, state = eligible[0]
    sel = {"model": alias, "modelId": models[alias]["modelId"], "provider": models[alias]["provider"], "account": acct}
    reason = f"tier {tier_name}: preference #{rank[0] + 1} ({alias}) on {acct} ({state})"
    if acct in affinity:
        reason += ", account affinity"
    return _decision(ROUTED, reason, rejections, selected=sel, tier=tier_name, fallback=rank[0] > 0)
