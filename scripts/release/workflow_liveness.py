"""Deterministic workflow liveness, cycle and progress classifier (#766, parent #761).

Pure library: no clock (the caller supplies ``now``), IO, randomness or model call. It reads a versioned
transition-history document (schemas/workflow-liveness.schema.json), delegates finding progress to
progress_evaluator.evaluate (no second fingerprint store) and returns stable reason codes, a graph witness and a
deterministic next action. A model may *propose* an action; ``authorize_action`` only accepts one the policy allows.
See docs/workflow-liveness.md.
"""

from __future__ import annotations

import re
from typing import Any

from scripts.release import progress_evaluator

SCHEMA_VERSION = 1
STATUSES = ("progress", "waiting", "stalled", "unknown", "ok")
WAIT_KINDS = ("human", "time", "external")
ACTIONS = ("none", "resume_reconcile", "infra_backoff", "same_session_repair", "investigate", "escalate", "human_action")
# Stall class -> (reason code, deterministic next action).
REMEDIATION = {
    "unchanged_findings": ("LIVENESS_UNCHANGED_FINDINGS", "escalate"),
    "oscillation": ("LIVENESS_OSCILLATION", "escalate"),
    "repeated_edge": ("LIVENESS_REPEATED_EDGE", "investigate"),
    "dead_end": ("LIVENESS_DEAD_END", "investigate"),
    "wait_for_cycle": ("LIVENESS_WAIT_FOR_CYCLE", "investigate"),
    "unsatisfiable_join": ("LIVENESS_UNSATISFIABLE_JOIN", "investigate"),
    "missing_external_event": ("LIVENESS_MISSING_EXTERNAL_EVENT", "resume_reconcile"),
    "overdue_human_wait": ("LIVENESS_HUMAN_WAIT_OVERDUE", "human_action"),
    "lost_lease": ("LIVENESS_LOST_LEASE", "resume_reconcile"),
    "capacity_starvation": ("LIVENESS_CAPACITY_STARVATION", "infra_backoff"),
    "missing_admission": ("LIVENESS_MISSING_ADMISSION", "resume_reconcile"),
    "budget_exhausted": ("LIVENESS_BUDGET_EXHAUSTED", "escalate"),
    "regression": ("LIVENESS_REGRESSION", "same_session_repair"),
}
_SECRET = re.compile(r"(?i)(gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,}|"
                     r"(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+)")
DEFAULT_POLICY = {"maxRepeatedEdge": 3, "maxUnchangedRounds": 3, "maxRounds": 10, "maxElapsedSeconds": 86400,
                  "maxResource": 0, "starvationSeconds": 900, "admissionGraceSeconds": 300}


def redact(value: Any) -> Any:
    """Recursively replace secret-looking substrings; evidence must never carry credentials."""
    if isinstance(value, str):
        return _SECRET.sub("[REDACTED]", value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {str(k): redact(v) for k, v in value.items()}
    return value


def authorize_action(proposed: str, result: dict[str, Any]) -> str:
    """A model-proposed action is honoured only if it is one the deterministic policy already allows."""
    return proposed if proposed in result.get("allowedActions", []) and proposed in ACTIONS else result["nextAction"]


def _graph_cycle(edges: dict[str, list[str]]) -> list[str]:
    """Return one cycle (node list closing on its first node) in a directed graph, deterministically; [] if acyclic."""
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(n: str) -> list[str]:
        state[n] = 1
        stack.append(n)
        for m in sorted(edges.get(n, [])):
            if state.get(m, 0) == 1:
                return stack[stack.index(m):] + [m]
            if state.get(m, 0) == 0:
                found = visit(m)
                if found:
                    return found
        stack.pop()
        state[n] = 2
        return []

    for n in sorted(edges):
        if state.get(n, 0) == 0:
            found = visit(n)
            if found:
                return found
    return []


def _fingerprint(t: dict[str, Any]) -> str:
    fps = ",".join(sorted(str(f.get("fingerprint")) for f in (t.get("observation") or {}).get("findings") or []))
    return "|".join([str(t.get("to")), str(t.get("input", "")), str((t.get("observation") or {}).get("artifact", {}).get("hash", t.get("artifact", ""))), fps])


def evaluate(doc: dict[str, Any], accepted_fingerprints: tuple[str, ...] = ()) -> dict[str, Any]:
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"unsupported schemaVersion {doc.get('schemaVersion')!r}; expected {SCHEMA_VERSION}")
    policy = {**DEFAULT_POLICY, **(doc.get("policy") or {})}
    now = float(doc.get("now", 0))
    transitions = list(doc.get("transitions") or [])
    stalls: dict[str, dict[str, Any]] = {}
    unknown: list[str] = []
    waits_ok: list[dict[str, Any]] = []
    evidence: dict[str, Any] = {}

    def stall(cls: str, witness: dict[str, Any]) -> None:
        stalls.setdefault(cls, witness)

    # --- UNKNOWN: stale SHA, missing verification, partial review coverage never count as success.
    ex = doc.get("execution") or {}
    if ex.get("sha") and ex.get("verifiedSha") != ex.get("sha"):
        unknown.append("LIVENESS_STALE_SHA")
    if "verification" in doc and not (doc["verification"] or {}).get("present"):
        unknown.append("LIVENESS_MISSING_VERIFICATION")
    rv = doc.get("review")
    if rv and int(rv.get("covered", 0)) < int(rv.get("expected", 0)):
        unknown.append("LIVENESS_PARTIAL_REVIEW_COVERAGE")

    # --- Progress: delegate to the existing evaluator; never duplicate its fingerprint logic.
    observations = [t["observation"] for t in transitions if t.get("observation")]
    progress: dict[str, Any] | None = None
    if observations:
        progress = progress_evaluator.evaluate(observations, accepted_fingerprints)
        evidence["progress"] = {k: progress[k] for k in ("classification", "reasonCodes", "consecutiveNoProgress", "oscillationCycle", "bestObservation")}
        cls = progress["classification"]
        if cls == "oscillation" or (progress["oscillationCycle"] and cls != "resolved"):
            stall("oscillation", {"cycleLength": progress["oscillationCycle"]})
        elif cls == "regression":
            stall("regression", {"reasons": progress["reasonCodes"]})
        elif cls == "stagnation" and progress["consecutiveNoProgress"] >= int(policy["maxUnchangedRounds"]):
            stall("unchanged_findings", {"rounds": progress["consecutiveNoProgress"], "cap": policy["maxUnchangedRounds"]})
        elif cls == "inconclusive" and len(observations) > 1:
            unknown.append("LIVENESS_INCONCLUSIVE_PROGRESS")

    # --- Graph paths: repeated edge cap, A->B->A over states, dead end.
    edge_counts: dict[tuple[str, str], int] = {}
    for t in transitions:
        k = (str(t.get("from")), str(t.get("to")))
        edge_counts[k] = edge_counts.get(k, 0) + 1
    for (a, b), n in sorted(edge_counts.items()):
        if n >= int(policy["maxRepeatedEdge"]) and a != b:
            # A repeat is only a stall when the full state fingerprint repeats too (new findings/artifacts are progress).
            fps = [_fingerprint(t) for t in transitions if (str(t.get("from")), str(t.get("to"))) == (a, b)]
            if len(set(fps)) < len(fps) and (progress is None or progress["classification"] not in ("resolved", "net_progress", "mixed_progress", "partial_progress")):
                stall("repeated_edge", {"edge": [a, b], "count": n, "cap": policy["maxRepeatedEdge"]})
    graph = doc.get("graph") or {}
    current = doc.get("state")
    nodes = graph.get("states") or {}
    if current is not None and nodes:
        node = nodes.get(current, {})
        if not node.get("terminal") and not node.get("outgoing"):
            stall("dead_end", {"state": current, "path": [str(t.get("to")) for t in transitions][-5:]})

    # --- Budgets, with parent budget inheritance: a child reset consumes the parent's rounds.
    rounds = len(transitions)
    child_rounds = sum(int(c.get("rounds", 0)) + int(c.get("resets", 0)) for c in doc.get("children") or [])
    total_rounds = rounds + child_rounds
    started = ex.get("startedAt")
    elapsed = now - float(started) if started is not None else 0.0
    resource = float(ex.get("resourceUsed", 0)) + sum(float(c.get("resourceUsed", 0)) for c in doc.get("children") or [])
    over: dict[str, Any] = {}
    if total_rounds > int(policy["maxRounds"]):
        over["rounds"] = {"used": total_rounds, "cap": policy["maxRounds"], "childRounds": child_rounds}
    if elapsed > float(policy["maxElapsedSeconds"]):
        over["elapsedSeconds"] = {"used": elapsed, "cap": policy["maxElapsedSeconds"]}
    if policy["maxResource"] and resource > float(policy["maxResource"]):
        over["resource"] = {"used": resource, "cap": policy["maxResource"]}
    for c in doc.get("children") or []:
        cap = c.get("budgetRounds")
        if cap is not None and int(c.get("rounds", 0)) + int(c.get("resets", 0)) > int(cap):
            over.setdefault("childBudget", []).append({"child": c.get("id"), "cap": cap})
    if over:
        stall("budget_exhausted", over)

    # --- Waits: legitimate waits within deadline are healthy; wait-for cycles and overdue waits are not.
    wait_edges: dict[str, list[str]] = {}
    for w in doc.get("waits") or []:
        kind, deadline = w.get("kind"), w.get("deadline")
        overdue = deadline is not None and now > float(deadline)
        if kind in WAIT_KINDS:
            if not overdue:
                waits_ok.append({"id": w.get("id"), "kind": kind})
            elif kind == "human":
                stall("overdue_human_wait", {"wait": w.get("id"), "owner": w.get("owner")})
            else:
                stall("missing_external_event", {"wait": w.get("id"), "kind": kind, "waitsFor": w.get("waitsFor")})
        elif w.get("waitsFor"):  # structural wait between executions (parent/child/join)
            wait_edges.setdefault(str(w.get("id")), []).append(str(w["waitsFor"]))
    cyc = _graph_cycle(wait_edges)
    if cyc:
        stall("wait_for_cycle", {"cycle": cyc})
    for j in doc.get("joins") or []:
        pending = [r for r in j.get("requires") or [] if r not in (j.get("satisfied") or [])]
        dead = [r for r in pending if (j.get("producers") or {}).get(r) is False]
        if dead:
            stall("unsatisfiable_join", {"join": j.get("id"), "blockedOn": dead})

    # --- Lease, capacity and admission.
    lease = doc.get("lease")
    if lease and not terminal_state(graph, current) and (not lease.get("held") or (lease.get("expiresAt") is not None and now > float(lease["expiresAt"]))):
        stall("lost_lease", {"lease": lease.get("id"), "expiresAt": lease.get("expiresAt")})
    cap = doc.get("capacity")
    if cap and int(cap.get("queued", 0)) > 0 and float(cap.get("waitingSeconds", 0)) >= float(policy["starvationSeconds"]):
        stall("capacity_starvation", {"queued": cap.get("queued"), "slots": cap.get("slots"), "running": cap.get("running"), "waitingSeconds": cap.get("waitingSeconds")})
    unadmitted = sorted(str(w.get("id")) for w in doc.get("work") or []
                        if w.get("runnable") and not w.get("admitted") and now - float(w.get("since", now)) >= float(policy["admissionGraceSeconds"]))
    if unadmitted and not (cap and int(cap.get("queued", 0)) > 0):
        stall("missing_admission", {"work": unadmitted})

    # --- Compose result.
    classes = sorted(stalls)
    reasons = sorted(REMEDIATION[c][0] for c in classes) + sorted(set(unknown))
    if classes:
        status = "stalled"
        # First (alphabetically stable) severity order: take the most disruptive deterministic action.
        order = {a: i for i, a in enumerate(("escalate", "investigate", "human_action", "same_session_repair", "infra_backoff", "resume_reconcile"))}
        action = min((REMEDIATION[c][1] for c in classes), key=lambda a: order[a])
    elif unknown:
        status, action = "unknown", "resume_reconcile"
    elif waits_ok:
        status, action = "waiting", "none"
        reasons.append("LIVENESS_HEALTHY_WAIT")
    elif progress and progress["classification"] in ("net_progress", "mixed_progress", "partial_progress", "resolved"):
        status, action = ("ok" if progress["classification"] == "resolved" else "progress"), "none"
    else:
        status, action = "ok", "none"
    allowed = sorted({REMEDIATION[c][1] for c in classes} | {action})
    witness = {"state": current, "path": [str(t.get("to")) for t in transitions][-10:], "stalls": {c: stalls[c] for c in classes}}
    if waits_ok:
        evidence["healthyWaits"] = waits_ok
    return redact({
        "schemaVersion": SCHEMA_VERSION, "status": status, "classes": classes,
        "reasonCodes": sorted(set(reasons)), "nextAction": action, "allowedActions": allowed,
        "witness": witness, "unknown": sorted(set(unknown)), "evidence": evidence,
        "budget": {"rounds": total_rounds, "childRounds": child_rounds, "elapsedSeconds": elapsed, "resource": resource},
    })


def terminal_state(graph: dict[str, Any], state: Any) -> bool:
    return bool(((graph or {}).get("states") or {}).get(state, {}).get("terminal"))
