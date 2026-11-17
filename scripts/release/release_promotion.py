"""Stable promotion, approvals, deployment receipts and rollback (#595).

Library only (own SQLite ledger). Promotion is two separate phases so Git ref movement is never mistaken for a
deployment:

1. authorize + move the `stable` ref (compare-and-swap, fast-forward only, exact tested SHA);
2. activate: readiness probes and health receipts decide `active`; a failure restores the prior stable and keeps the
   audit trail. Only `complete_activation` with passing receipts marks a promotion active.

Never two promotions at once for a project (a partial unique index), implementation agents cannot approve a release,
and every decision is appended to an immutable audit table.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

IN_PROGRESS = ("authorized", "ref-moved", "activating")
TERMINAL = ("active", "rolled-back", "failed", "refused")

SCHEMA = """
CREATE TABLE IF NOT EXISTS promotions(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, candidate_id TEXT NOT NULL UNIQUE, sha TEXT NOT NULL, manifest_hash TEXT NOT NULL,
  prior_stable_sha TEXT NOT NULL, state TEXT NOT NULL, activation_started REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_promotion_in_progress ON promotions(project_id) WHERE state IN ('authorized','ref-moved','activating');
CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, promotion_id TEXT, actor TEXT, event TEXT, detail TEXT, at REAL);
CREATE TABLE IF NOT EXISTS quarantine(sha TEXT PRIMARY KEY, reason TEXT, at REAL);
"""


class PromotionError(RuntimeError):
    pass


# ---- authorization -------------------------------------------------------------------------------------------------
def authorize(*, manifest: dict[str, Any], gate: dict[str, Any], mode: str, approval: dict[str, Any] | None, forward_port_blockers: list[str],
              newer_dev_commits: int = 0, freshness: str = "allow", now: float, quarantined: frozenset[str] = frozenset()) -> dict[str, Any]:
    """Decide whether the exact candidate SHA may move stable. Returns every reason it may not.

    `mode`: `approval` (default, human) or `auto` (explicitly configured autonomy). `freshness` is how a newer dev is treated:
    `allow` (older tested candidate still promotes), `warn` (allowed, flagged) or `block`."""
    reasons: list[str] = []
    warnings: list[str] = []
    if manifest["sha"] in quarantined:
        reasons.append("candidate SHA is quarantined after a failed activation")
    if not gate.get("eligible"):
        reasons.append("required suite evidence is missing, stale, pending or failing: " + ",".join(gate.get("blocking", [])))
    if forward_port_blockers:
        reasons.append(f"unresolved forward-port obligations block stable: {len(forward_port_blockers)}")
    if newer_dev_commits > 0:
        if freshness == "block":
            reasons.append(f"dev is {newer_dev_commits} commit(s) ahead and the freshness policy blocks")
        elif freshness == "warn":
            warnings.append(f"dev is {newer_dev_commits} commit(s) ahead of the tested candidate")
    if mode == "approval":
        if approval is None:
            reasons.append("approval is required and none was given")
        else:
            if approval.get("actorKind") not in ("human", "operator"):
                reasons.append("an implementation agent cannot approve a release")
            if approval.get("sha") != manifest["sha"] or approval.get("manifestHash") != manifest["manifestHash"]:
                reasons.append("approval is for a different SHA or manifest")
            if approval.get("expiresAt") is not None and now >= approval["expiresAt"]:
                reasons.append("approval has expired")
            if approval.get("approver") and approval["approver"] == approval.get("author"):
                reasons.append("the author cannot approve their own release")
    elif mode != "auto":
        reasons.append(f"unknown promotion mode {mode!r}")
    return {"allowed": not reasons, "reasons": reasons, "warnings": warnings}


# ---- ledger --------------------------------------------------------------------------------------------------------
class PromotionLedger:
    def __init__(self, path: str):
        self.path = path
        with self._tx() as db:
            for stmt in SCHEMA.split(";"):
                if stmt.strip():
                    db.execute(stmt)

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def _audit(db: sqlite3.Connection, pid: str | None, actor: str, event: str, detail: Any, now: float) -> None:
        db.execute("INSERT INTO audit(promotion_id,actor,event,detail,at) VALUES(?,?,?,?,?)", (pid, actor, event, json.dumps(detail, sort_keys=True), now))

    def begin(self, *, project_id: str, manifest: dict[str, Any], prior_stable_sha: str, decision: dict[str, Any], actor: str, now: float) -> dict[str, Any]:
        """Record an authorized promotion. Replaying the same candidate returns it; a second in-progress promotion is refused."""
        if not decision["allowed"]:
            with self._tx() as db:
                self._audit(db, None, actor, "refused", decision["reasons"], now)
            raise PromotionError("promotion not authorized: " + "; ".join(decision["reasons"]))
        pid = "promo-" + manifest["candidateId"]
        with self._tx() as db:
            row = db.execute("SELECT * FROM promotions WHERE candidate_id=?", (manifest["candidateId"],)).fetchone()
            if row:
                return {**dict(row), "replayed": True}
            try:
                db.execute("INSERT INTO promotions(id,project_id,candidate_id,sha,manifest_hash,prior_stable_sha,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                           (pid, project_id, manifest["candidateId"], manifest["sha"], manifest["manifestHash"], prior_stable_sha, "authorized", now, now))
            except sqlite3.IntegrityError as e:
                raise PromotionError("another promotion is already in progress for this project") from e
            self._audit(db, pid, actor, "authorized", {"sha": manifest["sha"], "warnings": decision["warnings"]}, now)
            return {**dict(db.execute("SELECT * FROM promotions WHERE id=?", (pid,)).fetchone()), "replayed": False}

    def _set(self, pid: str, expect: tuple[str, ...], to: str, actor: str, event: str, detail: Any, now: float, **cols: Any) -> None:
        with self._tx() as db:
            row = db.execute("SELECT state FROM promotions WHERE id=?", (pid,)).fetchone()
            if row is None:
                raise PromotionError("unknown promotion")
            if row["state"] not in expect:
                raise PromotionError(f"cannot {event} from {row['state']}")
            sets = ", ".join(f"{k}=?" for k in cols)
            db.execute(f"UPDATE promotions SET state=?, updated_at=?{', ' + sets if sets else ''} WHERE id=?", (to, now, *cols.values(), pid))
            self._audit(db, pid, actor, event, detail, now)

    def get(self, pid: str) -> dict[str, Any]:
        with self._tx() as db:
            row = db.execute("SELECT * FROM promotions WHERE id=?", (pid,)).fetchone()
            if row is None:
                raise PromotionError("unknown promotion")
            return dict(row)

    def audit_log(self, pid: str) -> list[dict[str, Any]]:
        with self._tx() as db:
            return [dict(r) for r in db.execute("SELECT * FROM audit WHERE promotion_id=? ORDER BY seq", (pid,)).fetchall()]

    def is_quarantined(self, sha: str) -> bool:
        with self._tx() as db:
            return db.execute("SELECT 1 FROM quarantine WHERE sha=?", (sha,)).fetchone() is not None

    def quarantined(self) -> frozenset[str]:
        with self._tx() as db:
            return frozenset(r["sha"] for r in db.execute("SELECT sha FROM quarantine").fetchall())

    # ---- phase 1: the ref ------------------------------------------------------------------------------------------
    def move_stable(self, pid: str, git: Any, *, stable_branch: str, now: float, actor: str = "promoter") -> None:
        """Fast-forward `stable` to the exact tested SHA by compare-and-swap. Refuses if stable is no longer the prior value
        (someone else wrote it) or the tested SHA is not a descendant of it, so tested-tree equivalence holds."""
        p = self.get(pid)
        ref = f"refs/heads/{stable_branch}"
        current = git.ref_value(ref)
        if p["state"] == "ref-moved" and current == p["sha"]:
            return  # replay after a crash between the CAS and the ledger write
        if current != p["prior_stable_sha"]:
            self._set(pid, ("authorized",), "refused", actor, "stable-drift", {"expected": p["prior_stable_sha"], "found": current}, now)
            raise PromotionError(f"{ref} is {current}, expected {p['prior_stable_sha']}; refusing to overwrite")
        if not git.is_ancestor(p["prior_stable_sha"], p["sha"]):
            self._set(pid, ("authorized",), "refused", actor, "not-fast-forward", {"sha": p["sha"]}, now)
            raise PromotionError("tested SHA does not descend from stable; promotion would not preserve the tested tree")
        if not git.cas(ref, p["sha"], p["prior_stable_sha"]):
            self._set(pid, ("authorized",), "refused", actor, "ref-race", {}, now)
            raise PromotionError(f"{ref} changed during the move")
        self._set(pid, ("authorized",), "ref-moved", actor, "ref-moved", {"from": p["prior_stable_sha"], "to": p["sha"]}, now)

    # ---- phase 2: activation ---------------------------------------------------------------------------------------
    def begin_activation(self, pid: str, *, now: float, actor: str = "deployer") -> None:
        self._set(pid, ("ref-moved",), "activating", actor, "activation-started", {}, now, activation_started=now)

    def record_probe(self, pid: str, *, name: str, ok: bool, detail: Any, now: float, actor: str = "deployer") -> None:
        if self.get(pid)["state"] != "activating":
            raise PromotionError("probes are only recorded during activation")
        with self._tx() as db:
            self._audit(db, pid, actor, "probe", {"name": name, "ok": ok, "detail": detail}, now)

    def complete_activation(self, pid: str, *, required_probes: list[str], now: float, actor: str = "deployer") -> None:
        """`active` only when every required readiness/health probe has a passing receipt; Git ref movement alone is not enough."""
        events = [e for e in self.audit_log(pid) if e["event"] == "probe"]
        latest: dict[str, bool] = {}
        for e in events:
            d = json.loads(e["detail"])
            latest[d["name"]] = d["ok"]
        missing = [p for p in required_probes if latest.get(p) is not True]
        if missing or not required_probes:
            raise PromotionError(f"activation not confirmed; probes missing or failing: {missing or 'none required (refusing)'}")
        self._set(pid, ("activating",), "active", actor, "activated", {"probes": required_probes}, now)

    def fail_activation(self, pid: str, git: Any, *, stable_branch: str, reason: str, now: float, actor: str = "deployer") -> dict[str, Any]:
        """Restore the prior stable (CAS back, only if stable still names the promoted SHA), quarantine the SHA, keep the audit."""
        p = self.get(pid)
        ref = f"refs/heads/{stable_branch}"
        restored = False
        if git.ref_value(ref) == p["sha"]:
            restored = git.cas(ref, p["prior_stable_sha"], p["sha"])
        with self._tx() as db:
            db.execute("INSERT OR IGNORE INTO quarantine(sha,reason,at) VALUES(?,?,?)", (p["sha"], reason, now))
        self._set(pid, ("authorized", "ref-moved", "activating"), "rolled-back" if restored else "failed", actor, "rollback",
                  {"reason": reason, "restoredPriorStable": restored, "priorStable": p["prior_stable_sha"]}, now)
        return {"restored": restored, "priorStable": p["prior_stable_sha"]}

    def stale_activations(self, *, now: float, timeout: float) -> list[dict[str, Any]]:
        """Interrupted activations (no completion within `timeout`): the caller probes and then completes or rolls back."""
        with self._tx() as db:
            rows = db.execute("SELECT * FROM promotions WHERE state='activating' AND activation_started <= ?", (now - timeout,)).fetchall()
            return [dict(r) for r in rows]


def detect_drift(*, stable_ref_sha: str | None, serving_sha: str | None, last_active_sha: str | None) -> dict[str, Any]:
    """Compare the Git ref, what is serving and the last confirmed-active promotion (a deployment is only what serves)."""
    if serving_sha is None:
        return {"drift": True, "kind": "serving-unknown", "detail": "no confirmed serving version"}
    if stable_ref_sha != serving_sha:
        kind = "ref-ahead-of-serving" if serving_sha == last_active_sha else "serving-diverged"
        return {"drift": True, "kind": kind, "detail": f"stable ref {stable_ref_sha} but serving {serving_sha}"}
    return {"drift": False, "kind": "none", "detail": "ref and serving agree"}
