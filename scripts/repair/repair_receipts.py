"""Durable adaptive-repair receipts, idempotent recovery and operations read model (issue #743).

Stdlib only. Receipts are appended to the existing run ledger layout (one JSONL file per run
directory); there is no separate incident store. Every write goes through the shared #579
redaction. Attempt reservation is an atomic create-exclusive file, so a crash/restart replay
finds the existing reservation/receipt and never sends a second agent turn or spends budget.
See docs/repair-receipts.md.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Optional

_spec = importlib.util.spec_from_file_location("factory_redaction", Path(__file__).resolve().parents[1] / "security" / "redaction.py")
_redaction = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_redaction)

SCHEMA_VERSION = 1
LEDGER = "repair-receipts.jsonl"
OUTCOMES = ("fixed", "no-progress", "oscillation", "validator-error", "implementation-failed",
            "governance-stop", "stale-timeout", "blocked", "running", "exhausted")
TERMINAL = tuple(o for o in OUTCOMES if o != "running")
REQUIRED = ("sessionRef", "attempt", "inputRevision", "outputRevision", "findings", "strategy", "actor",
            "policy", "evidenceRefs", "outcome", "stopReason")
OPERATOR_ACTIONS = ("recover", "replan")
DEFAULT_RETENTION_DAYS = 90
DEFAULT_LEASE_SECONDS = 900
DEFAULT_MAX_ROUNDS = 5


class RepairError(ValueError):
    pass


def _redact(value):
    if isinstance(value, str):
        return _redaction.redact(value)
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, dict):
        return {k: _redact(v) for k, v in value.items()}
    return value


def opaque_session_ref(session_id: str) -> str:
    """Stable opaque reference; the raw provider session id is never persisted."""
    return "sess_" + hashlib.sha256(str(session_id).encode("utf-8")).hexdigest()[:16]


def _dir(root, run_id) -> Path:
    rid = str(run_id)
    if not rid or any(c in rid for c in "/\\") or rid.startswith("."):
        raise RepairError("invalid run id")
    return Path(root) / rid


def _atomic_create(path: Path, payload: dict) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    return True


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_receipts(root, run_id, include_expired=False, now=None, retention_days=DEFAULT_RETENTION_DAYS):
    path = _dir(root, run_id) / LEDGER
    if not path.exists():
        return []
    now = time.time() if now is None else now
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # tolerate a torn trailing line from a crash
        if not include_expired and now - rec.get("recordedAt", now) > retention_days * 86400:
            continue
        out.append(rec)
    return out


def reserve_attempt(root, run_id, attempt, session_id, actor, now=None, lease_seconds=DEFAULT_LEASE_SECONDS,
                    resume_supported=True):
    """Atomically reserve (run, attempt). Returns a dict with ``status``:

    ``reserved``  caller owns the attempt and may send exactly one agent turn;
    ``replay``    a receipt exists: return it, send nothing, spend nothing;
    ``in-progress`` another live holder owns it (lease unexpired);
    ``blocked``   same-session resume is unsupported; no replacement agent is started.
    """
    now = time.time() if now is None else now
    base = _dir(root, run_id)
    existing = [r for r in read_receipts(root, run_id, include_expired=True) if r.get("attempt") == attempt and r.get("outcome") != "running"]
    if existing:
        return {"status": "replay", "receipt": existing[-1], "sendTurn": False, "spendBudget": False}
    ref = opaque_session_ref(session_id)
    if not resume_supported:
        receipt = append_receipt(root, run_id, _blocked(ref, attempt, actor, "resume-unsupported"), now=now)
        return {"status": "blocked", "reason": "resume-unsupported", "receipt": receipt, "sendTurn": False, "spendBudget": False}
    res = base / "reservations" / f"attempt-{int(attempt)}.json"
    token = hashlib.sha256(f"{ref}:{attempt}:{now}:{os.getpid()}".encode()).hexdigest()[:16]
    claim = {"sessionRef": ref, "attempt": attempt, "actor": actor, "token": token, "reservedAt": now, "expiresAt": now + lease_seconds}
    if _atomic_create(res, claim):
        return {"status": "reserved", "token": token, "sendTurn": True, "spendBudget": True}
    held = _read_json(res) or {}
    if held.get("expiresAt", 0) > now:
        return {"status": "in-progress", "holder": held.get("actor"), "sendTurn": False, "spendBudget": False}
    # Expired lease: the previous holder crashed without a receipt. Mark it stale (never resend silently).
    receipt = append_receipt(root, run_id, _blocked(ref, attempt, actor, "stale-lease-expired", outcome="stale-timeout"), now=now)
    return {"status": "blocked", "reason": "stale-lease-expired", "receipt": receipt, "sendTurn": False, "spendBudget": False}


def _blocked(ref, attempt, actor, reason, outcome="blocked"):
    return {"sessionRef": ref, "attempt": attempt, "inputRevision": "", "outputRevision": "", "findings": {"fixed": [], "new": [], "persistent": []},
            "strategy": "none", "actor": actor, "policy": {}, "evidenceRefs": [], "outcome": outcome, "stopReason": reason}


def append_receipt(root, run_id, receipt: dict, now=None):
    """Append one immutable, redacted receipt. A terminal receipt for an attempt wins; duplicates are ignored."""
    missing = [k for k in REQUIRED if k not in receipt]
    if missing:
        raise RepairError("receipt missing fields: " + ", ".join(missing))
    if receipt["outcome"] not in OUTCOMES:
        raise RepairError("unknown outcome: " + str(receipt["outcome"]))
    f = receipt["findings"]
    if not isinstance(f, dict) or any(k not in f for k in ("fixed", "new", "persistent")):
        raise RepairError("findings needs fixed/new/persistent")
    now = time.time() if now is None else now
    if receipt["outcome"] != "running":
        for r in read_receipts(root, run_id, include_expired=True):
            if r.get("attempt") == receipt["attempt"] and r.get("outcome") != "running":
                return r
    rec = _redact(dict(receipt))
    rec.update({"schemaVersion": SCHEMA_VERSION, "runId": str(run_id), "recordedAt": now})
    path = _dir(root, run_id) / LEDGER
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return rec


def complete_attempt(root, run_id, reservation: dict, receipt: dict, now=None):
    """Write the terminal receipt for a reserved attempt (requires the reservation token)."""
    held = _read_json(_dir(root, run_id) / "reservations" / f"attempt-{int(receipt['attempt'])}.json") or {}
    if held.get("token") != reservation.get("token"):
        raise RepairError("reservation token mismatch")
    return append_receipt(root, run_id, receipt, now=now)


def operator_action(root, run_id, action, operator, authorization, reason, policy_allows=True, now=None):
    """Audited operator recover/replan. Authorization and policy are checked, never bypassed."""
    if action not in OPERATOR_ACTIONS:
        raise RepairError("unknown operator action")
    roles = (authorization or {}).get("roles", [])
    if not (authorization or {}).get("authenticated") or "operator" not in roles:
        return {"status": "denied", "reason": "not-authorized"}
    if not policy_allows:
        return {"status": "denied", "reason": "governance-stop"}
    now = time.time() if now is None else now
    audit = _redact({"schemaVersion": SCHEMA_VERSION, "runId": str(run_id), "action": action, "operator": operator,
                     "reason": reason, "recordedAt": now})
    path = _dir(root, run_id) / "operator-audit.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(audit, sort_keys=True) + "\n")
    return {"status": "accepted", "audit": audit, "startsReplacementAgent": False}


def classify(receipts, now=None, stale_seconds=DEFAULT_LEASE_SECONDS):
    """Distinguish running repair from stale timeout, validator error, unsuccessful implementation and governance stop."""
    now = time.time() if now is None else now
    if not receipts:
        return {"state": "none", "stopReason": None}
    last = receipts[-1]
    out = last["outcome"]
    if out == "running":
        if now - last.get("recordedAt", now) > stale_seconds:
            return {"state": "stale-timeout", "stopReason": "no-heartbeat"}
        return {"state": "running", "stopReason": None}
    mapping = {"validator-error": "validator-error", "implementation-failed": "unsuccessful-implementation",
               "governance-stop": "governance-stop", "stale-timeout": "stale-timeout", "blocked": "blocked",
               "fixed": "fixed", "no-progress": "no-progress", "oscillation": "oscillation", "exhausted": "exhausted"}
    return {"state": mapping[out], "stopReason": last.get("stopReason")}


def read_model(root, run_id, now=None, max_rounds=DEFAULT_MAX_ROUNDS, retention_days=DEFAULT_RETENTION_DAYS):
    """Operations read model: active repair, rounds, findings, strategy, stop reason; history collapsed by default."""
    now = time.time() if now is None else now
    receipts = read_receipts(root, run_id, now=now, retention_days=retention_days)
    cls = classify(receipts, now=now)
    last = receipts[-1] if receipts else None
    attempts = {r["attempt"] for r in receipts}
    history = [{"attempt": r["attempt"], "outcome": r["outcome"], "strategy": r["strategy"], "stopReason": r["stopReason"],
               "sessionRef": r["sessionRef"], "evidenceRefs": r["evidenceRefs"], "findings": r["findings"]}
              for r in receipts[:-1]]
    return {"schemaVersion": SCHEMA_VERSION, "runId": str(run_id), "state": cls["state"], "stopReason": cls["stopReason"],
            "round": len(attempts), "maxRounds": max_rounds, "roundsLabel": f"{len(attempts)}/{max_rounds}",
            "activeRepair": cls["state"] == "running",
            "findings": ({k: len(last["findings"][k]) for k in ("fixed", "new", "persistent")} if last else {"fixed": 0, "new": 0, "persistent": 0}),
            "strategy": last["strategy"] if last else None,
            "latest": last, "history": {"collapsed": True, "count": len(history), "attempts": history}}


def counters(root, run_ids, now=None):
    """Export counters from receipts: success, no-progress/oscillation, per-rule recurrence, duration/token, cache usage."""
    c = {"repairRuns": 0, "repairSuccess": 0, "noProgress": 0, "oscillation": 0, "attempts": 0,
         "perRuleRecurrence": {}, "durationSeconds": 0.0, "tokens": 0, "cacheReadTokens": None}
    for rid in run_ids:
        rs = read_receipts(root, rid, now=now)
        if not rs:
            continue
        c["repairRuns"] += 1
        c["attempts"] += len({r["attempt"] for r in rs})
        c["repairSuccess"] += any(r["outcome"] == "fixed" for r in rs)
        c["noProgress"] += any(r["outcome"] == "no-progress" for r in rs)
        c["oscillation"] += any(r["outcome"] == "oscillation" for r in rs)
        for r in rs:
            for rule in r["findings"].get("persistent", []):
                key = rule.get("rule", str(rule)) if isinstance(rule, dict) else str(rule)
                c["perRuleRecurrence"][key] = c["perRuleRecurrence"].get(key, 0) + 1
            m = r.get("metrics") or {}
            c["durationSeconds"] += float(m.get("durationSeconds", 0))
            c["tokens"] += int(m.get("tokens", 0))
            if "cacheReadTokens" in m:
                c["cacheReadTokens"] = (c["cacheReadTokens"] or 0) + int(m["cacheReadTokens"])
    return c
