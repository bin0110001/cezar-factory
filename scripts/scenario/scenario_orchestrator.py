"""Generic multi-worker scenario orchestration (#217). Stdlib only.

Framework-independent core: a versioned manifest of named roles, an all-or-none reservation
over a lease store with TTL and fencing, a coordinator state machine
(prepare -> provision -> ready -> execute -> collect -> teardown -> terminal), role barriers that
do not depend on wall clocks, and a deterministic fault policy. Application behaviour (a Godot
server, a browser, a plain TCP echo) lives in an adapter; nothing here knows about any of them.
See docs/scenario-orchestration.md.
"""
from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import dataclass, field
from typing import Callable, Optional

SCHEMA_VERSION = 1
STATES = ("prepare", "provision", "ready", "execute", "collect", "teardown", "terminal")
OUTCOMES = ("passed", "failed", "unschedulable", "cancelled", "incomplete", "infra")
FAULTS = ("worker_lost", "connectivity_lost", "port_conflict", "role_crashed", "partial_start",
          "timeout", "cancelled", "replayed_result", "stale_fence", "provision_failed",
          "display_failed", "gpu_lost", "render_fault", "control_grant_expired")
# Faults that say nothing wrong with the scenario itself: a bounded retry is allowed.
INFRA_FAULTS = {"worker_lost", "connectivity_lost", "port_conflict", "partial_start", "provision_failed",
                "display_failed", "gpu_lost", "control_grant_expired"}


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def scenario_id(manifest: dict) -> str:
    return "scn-" + hashlib.sha256(canonical(manifest).encode()).hexdigest()[:16]


def attempt_id(manifest: dict, attempt: int, request_key: str = "") -> str:
    return f"{scenario_id(manifest)}-a{attempt}-" + hashlib.sha256(f"{request_key}:{attempt}".encode()).hexdigest()[:8]


# ---------------------------------------------------------------- manifest

def validate_manifest(m) -> list:
    """Return a list of error strings; empty means valid."""
    errs = []
    if not isinstance(m, dict):
        return ["manifest must be an object"]
    if m.get("schemaVersion") != SCHEMA_VERSION:
        errs.append(f"schemaVersion must be {SCHEMA_VERSION}")
    if not m.get("name"):
        errs.append("name is required")
    roles = m.get("roles")
    names = []
    if not isinstance(roles, list) or not roles:
        errs.append("roles must be a non-empty list")
        roles = []
    for r in roles:
        n = r.get("name") if isinstance(r, dict) else None
        if not n:
            errs.append("every role needs a name")
            continue
        names.append(n)
        if not isinstance(r.get("count", 1), int) or r.get("count", 1) < 1:
            errs.append(f"role {n}: count must be a positive integer")
        if not isinstance(r.get("capabilities", []), list):
            errs.append(f"role {n}: capabilities must be a list")
    if len(set(names)) != len(names):
        errs.append("role names must be unique")
    topo = m.get("topology", {})
    if topo.get("hostPolicy", "distinct-physical") not in ("distinct-physical", "same-host-allowed"):
        errs.append("topology.hostPolicy must be distinct-physical or same-host-allowed")
    for b in m.get("barriers", []):
        if not b.get("name") or not set(b.get("roles", [])) <= set(names) or not b.get("roles"):
            errs.append(f"barrier {b.get('name')!r} must name existing roles")
    t = m.get("timeouts", {})
    for k in ("provisionSeconds", "readySeconds", "executeSeconds", "leaseTtlSeconds"):
        if k in t and (not isinstance(t[k], (int, float)) or t[k] <= 0):
            errs.append(f"timeouts.{k} must be positive")
    retry = m.get("retry", {})
    if retry.get("maxAttempts", 1) < 1 or retry.get("maxAttempts", 1) > 5:
        errs.append("retry.maxAttempts must be 1..5")
    return errs


# ---------------------------------------------------------------- placement

@dataclass(frozen=True)
class Worker:
    id: str
    host: str                      # physical host identity
    capabilities: frozenset = frozenset()
    zone: str = "default"
    online: bool = True


@dataclass
class RoleInstance:
    role: str
    index: int
    worker: str = ""
    host: str = ""

    @property
    def key(self) -> str:
        return f"{self.role}#{self.index}"


def _instances(m: dict) -> list:
    return [RoleInstance(r["name"], i) for r in m["roles"] for i in range(r.get("count", 1))]


def plan_placement(m: dict, workers: list) -> tuple:
    """Deterministic placement. Returns (assignments, None) or (None, reason).

    Never downgrades: distinct-physical needs a distinct host per instance, and an offline,
    wrong-zone or under-capable worker is not a candidate.
    """
    zone = m.get("network", {}).get("zone")
    same_host_ok = m.get("topology", {}).get("hostPolicy") == "same-host-allowed"
    roles = {r["name"]: r for r in m["roles"]}
    insts = _instances(m)
    pool = sorted((w for w in workers if w.online and (not zone or w.zone == zone)), key=lambda w: w.id)
    cands = []
    for inst in insts:
        r = roles[inst.role]
        need = set(r.get("capabilities", []))
        gs = r.get("graphicalSession") or {}
        if gs.get("required"):      # display/GPU/capture/input are reserved with the worker, never dropped
            need |= set(gs.get("controls", ["display"]))
        c = [w for w in pool if need <= set(w.capabilities)]
        if not c:
            return None, f"no online worker offers {sorted(need)} for role {inst.role}"
        cands.append(c)
    if not same_host_ok:
        hosts = {w.host for c in cands for w in c}
        if len(hosts) < len(insts):
            return None, f"distinct-physical needs {len(insts)} hosts, only {len(hosts)} eligible"

    chosen = []

    def search(i, used_workers, used_hosts):
        if i == len(insts):
            return True
        for w in cands[i]:
            if w.id in used_workers or (not same_host_ok and w.host in used_hosts):
                continue
            chosen.append(w)
            if search(i + 1, used_workers | {w.id}, used_hosts | {w.host}):
                return True
            chosen.pop()
        return False

    if not search(0, frozenset(), frozenset()):
        return None, "no assignment satisfies the role and topology constraints"
    for inst, w in zip(insts, chosen):
        inst.worker, inst.host = w.id, w.host
    return insts, None


# ---------------------------------------------------------------- lease store

class LeaseStore:
    """In-memory all-or-none lease store with TTL and fencing.

    The production store is the #112 workspace lease registry; it implements this same four-method
    contract. This one exists so the core is testable and has no second persistent store.
    """

    def __init__(self):
        self._leases = {}          # resource -> {owner, token, expires}
        self._fence = 0

    def _live(self, resource, now):
        l = self._leases.get(resource)
        return l if l and l["expires"] > now else None

    def acquire_all(self, owner: str, resources: list, now: float, ttl: float) -> Optional[dict]:
        """All resources or none. Returns {resource: fencing_token} or None (nothing held)."""
        for r in resources:
            held = self._live(r, now)
            if held and held["owner"] != owner:
                return None
        self._fence += 1
        for r in resources:
            self._leases[r] = {"owner": owner, "token": self._fence, "expires": now + ttl}
        return {r: self._fence for r in resources}

    def valid(self, owner: str, resource: str, token: int, now: float) -> bool:
        l = self._live(resource, now)
        return bool(l and l["owner"] == owner and l["token"] == token)

    def release_all(self, owner: str) -> int:
        mine = [r for r, l in self._leases.items() if l["owner"] == owner]
        for r in mine:
            del self._leases[r]
        return len(mine)

    def held(self, now: float) -> dict:
        return {r: l["owner"] for r, l in self._leases.items() if l["expires"] > now}


# ---------------------------------------------------------------- coordinator

@dataclass
class Fault:
    kind: str
    role: str = ""
    detail: str = ""


class Adapter:
    """Project-owned behaviour. Defaults are no-ops so a fixture overrides only what it needs.

    execute() returns {"checkpoints": [...], "assertions": [{"name","ok","detail"}], "artifacts": [...]}
    or raises/returns {"fault": kind}.
    """

    def provision(self, inst: RoleInstance, topology: dict) -> Optional[Fault]: return None
    def ready(self, inst: RoleInstance) -> bool: return True
    def execute(self, inst: RoleInstance, ctx: dict) -> dict: return {"checkpoints": [], "assertions": [], "artifacts": []}
    def collect(self, inst: RoleInstance) -> dict: return {"logs": []}
    def teardown(self, inst: RoleInstance) -> None: return None


@dataclass
class ScenarioResult:
    scenario_id: str
    attempt_id: str
    outcome: str
    states: list
    roles: dict = field(default_factory=dict)
    faults: list = field(default_factory=list)
    reason: str = ""
    attempts: int = 1
    orphan_leases: int = 0

    def to_dict(self) -> dict:
        return {"schemaVersion": SCHEMA_VERSION, "scenarioId": self.scenario_id, "attemptId": self.attempt_id,
                "outcome": self.outcome, "states": self.states, "roles": self.roles, "faults": self.faults,
                "reason": self.reason, "attempts": self.attempts, "orphanLeases": self.orphan_leases}


def _fail_outcome(kind: str) -> str:
    if kind == "cancelled":
        return "cancelled"
    if kind in INFRA_FAULTS:
        return "infra"
    return "failed"


class Coordinator:
    def __init__(self, store: LeaseStore, adapter: Adapter, clock: Callable[[], float] = lambda: 0.0,
                 cancelled: Callable[[], bool] = lambda: False):
        self.store, self.adapter, self.clock, self.cancelled = store, adapter, clock, cancelled
        self._seen = {}            # (attempt, role key) -> canonical result, replay guard

    def run(self, m: dict, workers: list, request_key: str = "") -> ScenarioResult:
        errs = validate_manifest(m)
        sid = scenario_id(m)
        if errs:
            return ScenarioResult(sid, "", "failed", [], reason="invalid manifest: " + "; ".join(errs))
        attempts = m.get("retry", {}).get("maxAttempts", 1) if m.get("retry", {}).get("safe") else 1
        res = None
        for n in range(1, attempts + 1):
            res = self._attempt(m, workers, attempt_id(m, n, request_key), request_key)
            res.attempts = n
            if res.outcome in ("passed", "failed", "cancelled", "unschedulable"):
                break
            if not (res.faults and all(f["kind"] in INFRA_FAULTS for f in res.faults)):
                break
        return res

    def _attempt(self, m, workers, aid, request_key) -> ScenarioResult:
        out = ScenarioResult(scenario_id(m), aid, "failed", [])
        a = self.adapter
        owner = aid
        ttl = m.get("timeouts", {}).get("leaseTtlSeconds", 600)
        started: list = []

        def enter(s): out.states.append(s)

        def fault(kind, role="", detail=""):
            out.faults.append({"kind": kind, "role": role, "detail": detail})

        enter("prepare")
        insts, why = plan_placement(m, workers)
        if insts is None:
            out.outcome, out.reason = "unschedulable", why
            enter("terminal")
            return out
        tokens = self.store.acquire_all(owner, [i.worker for i in insts], self.clock(), ttl)
        if tokens is None:
            out.outcome, out.reason = "unschedulable", "workers are leased by another scenario"
            enter("terminal")
            return out
        topology = {i.key: {"worker": i.worker, "host": i.host} for i in insts}
        roles = {i.key: {"worker": i.worker, "host": i.host, "fence": tokens[i.worker], "status": "pending",
                         "assertions": [], "artifacts": [], "logs": []} for i in insts}
        out.roles = roles
        failed = None
        try:
            enter("provision")
            for i in insts:
                if self.cancelled():
                    failed = Fault("cancelled"); break
                started.append(i)
                f = a.provision(i, topology)
                if f:
                    failed = Fault(f.kind, i.key, f.detail); break
            if not failed:
                enter("ready")
                for i in insts:
                    if not a.ready(i):
                        failed = Fault("partial_start", i.key, "readiness probe failed"); break
            if not failed:
                enter("execute")
                failed = self._execute(m, insts, roles, tokens, owner, topology)
        finally:
            enter("collect")
            for i in started:
                try:
                    roles[i.key]["logs"] = a.collect(i).get("logs", [])   # evidence survives failure
                except Exception as e:  # noqa: BLE001 - collection must not block teardown
                    roles[i.key]["logs"] = [f"collect failed: {e}"]
            enter("teardown")
            for i in reversed(started):
                try:
                    a.teardown(i)
                except Exception as e:  # noqa: BLE001
                    fault("teardown_error", i.key, str(e))
            self.store.release_all(owner)
            out.orphan_leases = sum(1 for o in self.store.held(self.clock()).values() if o == owner)
            enter("terminal")
        if failed:
            fault(failed.kind, failed.role, failed.detail)
            out.outcome = _fail_outcome(failed.kind)
            out.reason = f"{failed.kind} in {failed.role or 'coordinator'}"
            for k, r in roles.items():
                if r["status"] == "pending":
                    r["status"] = "cancelled"
            return out
        bad = [k for k, r in roles.items() if any(not x.get("ok") for x in r["assertions"])]
        out.outcome = "failed" if bad else "passed"
        out.reason = f"assertions failed in {bad}" if bad else ""
        return out

    def _execute(self, m, insts, roles, tokens, owner, topology) -> Optional[Fault]:
        a = self.adapter
        reached = {}
        for i in insts:
            if self.cancelled():
                return Fault("cancelled")
            if not self.store.valid(owner, i.worker, tokens[i.worker], self.clock()):
                return Fault("stale_fence", i.key, "lease expired or taken over")
            try:
                r = a.execute(i, {"topology": topology, "attemptRoles": list(roles)})
            except Exception as e:  # noqa: BLE001
                return Fault("role_crashed", i.key, str(e))
            if r.get("fault"):
                return Fault(r["fault"], i.key, r.get("detail", ""))
            if r.get("fence", tokens[i.worker]) != tokens[i.worker]:
                return Fault("stale_fence", i.key, "result carries a stale fence")
            digest = canonical(r)
            prev = self._seen.setdefault((owner, i.key), digest)
            if prev != digest:
                return Fault("replayed_result", i.key, "conflicting duplicate result")
            reached[i.key] = set(r.get("checkpoints", []))
            roles[i.key].update(status="done", assertions=r.get("assertions", []),
                                artifacts=r.get("artifacts", []))
        for b in m.get("barriers", []):
            missing = [k for k in reached if k.split("#")[0] in b["roles"] and b["name"] not in reached[k]]
            if missing:
                return Fault("timeout", missing[0], f"barrier {b['name']} not reached by {missing}")
        return None
