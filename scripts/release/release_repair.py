"""Regression repair, bounded retries and dev forward-port reconciliation (#594).

Library only. A defect found in a frozen candidate revision becomes one linked repair task with hard caps. The fix is
recorded as a forward-port obligation to dev: detected as already present (equivalent), cleanly applicable, or in
conflict, and tracked with receipts. Duplicate events never duplicate tasks or obligations, a conflict is claimed by
one resolver at a time, and a repair that cannot succeed escalates instead of looping.

Durable state is SQLite (own file), so it survives restarts and enforces its uniqueness in the database.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from contextlib import contextmanager
from typing import Any, Iterator

OPEN, ESCALATED, DONE = "open", "escalated", "done"
FP_STATES = ("pending", "applied", "equivalent", "conflict", "waived")
BLOCKING = ("pending", "conflict")
FP_TRANSITIONS = {"pending": ("applied", "equivalent", "conflict", "waived"), "conflict": ("applied", "equivalent", "waived"),
                  "applied": (), "equivalent": (), "waived": ()}

SCHEMA = """
CREATE TABLE IF NOT EXISTS repairs(
  id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, candidate_id TEXT NOT NULL, revision INTEGER NOT NULL, scope TEXT NOT NULL,
  max_attempts INTEGER NOT NULL, max_seconds REAL NOT NULL, max_cost REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, escalation TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS forward_ports(
  id TEXT PRIMARY KEY, repair_id TEXT NOT NULL, candidate_id TEXT NOT NULL, patch_id TEXT NOT NULL, fix_sha TEXT NOT NULL,
  state TEXT NOT NULL, claimed_by TEXT, authored_by_candidate INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL,
  UNIQUE(candidate_id, patch_id));
CREATE TABLE IF NOT EXISTS receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT, forward_port_id TEXT, actor TEXT, from_state TEXT, to_state TEXT, detail TEXT, at REAL);
"""


class RepairError(RuntimeError):
    pass


def _id(prefix: str, *parts: Any) -> str:
    return prefix + "-" + hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]


class RepairLedger:
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

    # ---- repair tasks ---------------------------------------------------------------------------------------------
    def open_repair(self, *, candidate_id: str, revision: int, current_revision: int, failure_key: str, scope: list[str],
                    max_attempts: int = 3, max_seconds: float = 7200, max_cost: float = 10.0, validation_terminal: bool, now: float) -> dict[str, Any]:
        """One repair per (candidate, revision, failure). A replay returns the same task. Refused for an obsolete revision
        or while validation runs for the revision are still active, so revisions stay sequential."""
        if revision != current_revision:
            raise RepairError(f"revision {revision} is obsolete; the candidate is at {current_revision}")
        if not validation_terminal:
            raise RepairError("prior validation runs are not terminal; cancel or await them before repairing")
        if not scope:
            raise RepairError("a repair needs a narrow scope (at least one path)")
        idem = json.dumps([candidate_id, revision, failure_key])
        rid = _id("repair", candidate_id, revision, failure_key)
        with self._tx() as db:
            row = db.execute("SELECT * FROM repairs WHERE idem=?", (idem,)).fetchone()
            if row:
                return {**dict(row), "replayed": True}
            db.execute("INSERT INTO repairs(id,idem,candidate_id,revision,scope,max_attempts,max_seconds,max_cost,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (rid, idem, candidate_id, revision, json.dumps(sorted(scope)), max_attempts, max_seconds, max_cost, OPEN, now))
            return {**dict(db.execute("SELECT * FROM repairs WHERE id=?", (rid,)).fetchone()), "replayed": False}

    def record_attempt(self, repair_id: str, *, outcome: str, cost: float, now: float, manual_review: bool = False) -> dict[str, Any]:
        """Count an attempt. When a cap is reached without success the task escalates (`manual` or `abandon`), never loops."""
        with self._tx() as db:
            r = db.execute("SELECT * FROM repairs WHERE id=?", (repair_id,)).fetchone()
            if r is None:
                raise RepairError("unknown repair")
            if r["status"] != OPEN:
                return {"status": r["status"], "escalation": r["escalation"], "attempts": r["attempts"]}
            attempts, spent = r["attempts"] + 1, r["cost"] + cost
            status, esc = OPEN, None
            if outcome == "fixed":
                status = DONE
            elif attempts >= r["max_attempts"] or spent >= r["max_cost"] or now - r["created_at"] >= r["max_seconds"]:
                status, esc = ESCALATED, ("manual" if manual_review else "abandon")
            db.execute("UPDATE repairs SET attempts=?, cost=?, status=?, escalation=? WHERE id=?", (attempts, spent, status, esc, repair_id))
            return {"status": status, "escalation": esc, "attempts": attempts, "cost": spent}

    # ---- forward-port obligations ---------------------------------------------------------------------------------
    def register_fix(self, repair_id: str, *, fix_sha: str, patch_id: str, authored_by_candidate: bool = True, now: float) -> dict[str, Any]:
        """Record a fix commit. The obligation is unique per (candidate, patch id): a duplicate repair event adds nothing."""
        with self._tx() as db:
            r = db.execute("SELECT * FROM repairs WHERE id=?", (repair_id,)).fetchone()
            if r is None:
                raise RepairError("unknown repair")
            fid = _id("fp", r["candidate_id"], patch_id)
            if db.execute("SELECT 1 FROM forward_ports WHERE id=?", (fid,)).fetchone():
                return {"id": fid, "replayed": True}
            db.execute("INSERT INTO forward_ports(id,repair_id,candidate_id,patch_id,fix_sha,state,authored_by_candidate,created_at) VALUES(?,?,?,?,?,?,?,?)",
                       (fid, repair_id, r["candidate_id"], patch_id, fix_sha, "pending", int(authored_by_candidate), now))
            db.execute("INSERT INTO receipts(forward_port_id,actor,from_state,to_state,detail,at) VALUES(?,?,?,?,?,?)", (fid, "system", None, "pending", json.dumps({"fixSha": fix_sha}), now))
            return {"id": fid, "replayed": False}

    def set_state(self, fp_id: str, to: str, *, actor: str, now: float, detail: Any = None) -> str:
        if to not in FP_STATES:
            raise RepairError(f"unknown state {to}")
        if to == "waived" and actor != "operator":
            raise RepairError("only an operator may waive a forward-port obligation")
        with self._tx() as db:
            row = db.execute("SELECT * FROM forward_ports WHERE id=?", (fp_id,)).fetchone()
            if row is None:
                raise RepairError("unknown forward-port obligation")
            if row["state"] == to:
                return to  # replayed event
            if to not in FP_TRANSITIONS[row["state"]]:
                raise RepairError(f"illegal forward-port transition {row['state']} -> {to}")
            db.execute("UPDATE forward_ports SET state=?, claimed_by=CASE WHEN ? IN ('applied','equivalent','waived') THEN NULL ELSE claimed_by END WHERE id=?", (to, to, fp_id))
            db.execute("INSERT INTO receipts(forward_port_id,actor,from_state,to_state,detail,at) VALUES(?,?,?,?,?,?)", (fp_id, actor, row["state"], to, json.dumps(detail), now))
            return to

    def claim_conflict(self, fp_id: str, owner: str) -> bool:
        """Exactly one resolver at a time works a conflicting forward-port (single controlled resolution)."""
        with self._tx() as db:
            row = db.execute("SELECT state, claimed_by FROM forward_ports WHERE id=?", (fp_id,)).fetchone()
            if row is None or row["state"] != "conflict":
                return False
            if row["claimed_by"] not in (None, owner):
                return False
            db.execute("UPDATE forward_ports SET claimed_by=? WHERE id=?", (owner, fp_id))
            return True

    def obligations(self, candidate_id: str) -> list[dict[str, Any]]:
        with self._tx() as db:
            return [dict(r) for r in db.execute("SELECT * FROM forward_ports WHERE candidate_id=? ORDER BY created_at, id", (candidate_id,)).fetchall()]

    def receipts(self, fp_id: str) -> list[dict[str, Any]]:
        with self._tx() as db:
            return [dict(r) for r in db.execute("SELECT * FROM receipts WHERE forward_port_id=? ORDER BY seq", (fp_id,)).fetchall()]

    def blocks_stable(self, candidate_id: str, *, block_authored: bool = True, block_all: bool = False) -> list[str]:
        """Obligation ids that block stable promotion. Default: unresolved candidate-authored fixes block."""
        out = []
        for o in self.obligations(candidate_id):
            if o["state"] in BLOCKING and (block_all or (block_authored and o["authored_by_candidate"])):
                out.append(o["id"])
        return out


# ---- git classification --------------------------------------------------------------------------------------------
def _git(repo: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, encoding="utf8")


def patch_id(repo: str, commit: str) -> str:
    """Stable content id of a commit's patch (independent of SHA, parents and dates)."""
    show = subprocess.run(["git", "-C", repo, "show", commit], capture_output=True, check=True)
    out = subprocess.run(["git", "-C", repo, "patch-id", "--stable"], input=show.stdout, capture_output=True, check=True)
    first = out.stdout.decode().split()
    if not first:
        raise RepairError(f"{commit} has no patch (empty or merge commit)")
    return first[0]


def classify_forward_port(repo: str, *, dev_tip: str, fix_sha: str, base_sha: str) -> str:
    """`equivalent` if dev already carries the same patch, `pending` if it applies cleanly, else `conflict`.

    Anything that cannot be decided (old git, error) is reported as `conflict`, the safe, human-or-agent-reviewed state."""
    cherry = _git(repo, "cherry", dev_tip, fix_sha, base_sha)
    if cherry.returncode != 0:
        return "conflict"
    marks = [line[:1] for line in cherry.stdout.splitlines() if line.strip()]
    if marks and all(m == "-" for m in marks):
        return "equivalent"
    merged = _git(repo, "merge-tree", "--write-tree", f"--merge-base={base_sha}", dev_tip, fix_sha)
    return "pending" if merged.returncode == 0 else "conflict"


# ---- emergency fixes -----------------------------------------------------------------------------------------------
def plan_emergency(*, active_candidate: dict[str, Any] | None, decision: str | None) -> dict[str, Any]:
    """An emergency fix branched from stable is validated on its own. If a candidate is active the operator must choose
    reconcile, revise or abandon first: two candidates are never promoted at once and the one-active rule holds."""
    if active_candidate is None:
        return {"allowed": True, "actions": ["validate-hotfix-independently", "open-forward-port-to-dev"]}
    if decision not in ("reconcile", "revise", "abandon"):
        return {"allowed": False, "reason": f"active candidate {active_candidate['id']} must be reconciled, revised or abandoned first", "actions": []}
    actions = {"reconcile": ["promote-hotfix", "open-forward-port-to-dev", "open-forward-port-to-candidate"],
               "revise": ["fold-hotfix-into-new-candidate-revision", "revalidate-candidate", "open-forward-port-to-dev"],
               "abandon": ["abandon-active-candidate", "validate-hotfix-independently", "open-forward-port-to-dev"]}[decision]
    return {"allowed": True, "actions": actions, "decision": decision}
