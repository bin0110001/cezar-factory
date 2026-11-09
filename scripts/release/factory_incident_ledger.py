#!/usr/bin/env python3
"""Bounded, host-local incident history for the Factory release controller.

The ledger is authoritative for incident attempts and backoff. Optional Hindsight
summaries are advisory and cannot affect any ledger decision.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import pathlib
import re
import sqlite3
import sys
import time
from collections.abc import Callable, Iterator, Mapping
from typing import Any

SCHEMA_VERSION = 1
FAILURE_CLASSES = (
    "release", "automation", "shadow_drift", "failed_refetch", "compatibility", "infrastructure",
)
DEFAULT_POLICIES: dict[str, dict[str, int]] = {
    "release": {"budget": 3, "baseDelaySeconds": 300, "maxDelaySeconds": 3600},
    "automation": {"budget": 3, "baseDelaySeconds": 60, "maxDelaySeconds": 1800},
    "shadow_drift": {"budget": 3, "baseDelaySeconds": 300, "maxDelaySeconds": 3600},
    "failed_refetch": {"budget": 5, "baseDelaySeconds": 30, "maxDelaySeconds": 600},
    "compatibility": {"budget": 2, "baseDelaySeconds": 600, "maxDelaySeconds": 3600},
    "infrastructure": {"budget": 3, "baseDelaySeconds": 60, "maxDelaySeconds": 1800},
}
MAX_SUMMARY_CHARS = 500
MAX_EVIDENCE_CHARS = 256

_SHA = re.compile(r"\b[0-9a-f]{7,64}\b", re.IGNORECASE)
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
_ISO_TIME = re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b", re.IGNORECASE)
_EPOCH = re.compile(r"\b(?:1[5-9]\d{8}|2\d{9})(?:\.\d+)?\b")
_PATH = re.compile(r"(?:\b[A-Za-z]:[\\/]|/)(?:[^\s:'\"<>|]+[\\/])+[^\s:'\"<>|,;]+")
_RELATIVE_PATH = re.compile(r"\b(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,12}\b")
_LABELED_ID = re.compile(r"\b(?:run|task|event|artifact|incident|process|pid|port|id)(?:[_ -]?id)?\s*[:=#]\s*[A-Za-z0-9._-]+", re.IGNORECASE)
_DURATION = re.compile(r"\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|seconds?|secs?|minutes?|mins?|hours?)\b", re.IGNORECASE)
_SECRET = re.compile(r"(?i)(bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})")


class IncidentLedgerError(ValueError):
    """Invalid ledger input or unsupported database schema."""


def normalize_failure(reason: str) -> str:
    """Return a bounded, secret-redacted signature that ignores volatile identifiers."""
    if not isinstance(reason, str):
        raise IncidentLedgerError("failure summary must be text")
    text = _SECRET.sub("<secret>", reason)
    text = _ISO_TIME.sub("<time>", text)
    text = _EPOCH.sub("<time>", text)
    text = _UUID.sub("<id>", text)
    text = _SHA.sub("<sha>", text)
    text = _PATH.sub("<path>", text)
    text = _RELATIVE_PATH.sub("<path>", text)
    text = re.sub(r"<path>:\d+(?::\d+)?", "<path>", text)
    text = re.sub(r"(?<![\w])#\d+\b", "<id>", text)
    text = _LABELED_ID.sub("<id>", text)
    text = _DURATION.sub("<duration>", text)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text[:MAX_SUMMARY_CHARS]


def failure_fingerprint(failure_class: str, reason: str) -> str:
    if failure_class not in FAILURE_CLASSES:
        raise IncidentLedgerError(f"unknown failure class: {failure_class}")
    normalized = normalize_failure(reason) or "unknown failure"
    return hashlib.sha256(f"{failure_class}\0{normalized}".encode("utf-8")).hexdigest()


def _validate_policies(overrides: Mapping[str, Mapping[str, Any]] | None) -> dict[str, dict[str, int]]:
    policies = {name: dict(policy) for name, policy in DEFAULT_POLICIES.items()}
    for failure_class, override in (overrides or {}).items():
        if failure_class not in policies or not isinstance(override, Mapping):
            raise IncidentLedgerError(f"invalid policy for failure class: {failure_class}")
        policies[failure_class].update(override)
    for failure_class, policy in policies.items():
        budget, base, cap = (policy.get("budget"), policy.get("baseDelaySeconds"), policy.get("maxDelaySeconds"))
        if any(not isinstance(value, int) or isinstance(value, bool) for value in (budget, base, cap)):
            raise IncidentLedgerError(f"{failure_class} policy values must be integers")
        if not (1 <= budget <= 1000 and 0 <= base <= cap <= 30 * 24 * 3600):
            raise IncidentLedgerError(f"{failure_class} policy budget or delay is out of range")
    return policies


def _safe_evidence(candidate_sha: str | None, evidence: Mapping[str, Any] | None) -> dict[str, str]:
    if candidate_sha is not None and not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", candidate_sha, re.IGNORECASE):
        raise IncidentLedgerError("candidate_sha must be a full 40- or 64-character commit SHA")
    if candidate_sha is None or evidence is None or not isinstance(evidence, Mapping):
        return {}
    output: dict[str, str] = {}
    for key in ("candidateSha", "source", "stage", "evidenceId", "receipt"):
        value = evidence.get(key)
        if isinstance(value, str) and value.strip():
            output[key] = _SECRET.sub("<secret>", value.strip())[:MAX_EVIDENCE_CHARS]
    return output


def _has_candidate_cause(candidate_sha: str | None, evidence: Mapping[str, str]) -> bool:
    return bool(
        candidate_sha
        and evidence.get("candidateSha", "").lower() == candidate_sha.lower()
        and evidence.get("source")
        and (evidence.get("stage") or evidence.get("evidenceId") or evidence.get("receipt"))
    )


class IncidentLedger:
    """SQLite incident ledger with atomic admission, budgets and exponential backoff."""

    def __init__(
        self,
        db_path: pathlib.Path | str,
        *,
        policies: Mapping[str, Mapping[str, Any]] | None = None,
        clock: Callable[[], float] = time.time,
        hindsight_summarizer: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        self.db_path = pathlib.Path(db_path).expanduser().absolute()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.policies = _validate_policies(policies)
        self.clock = clock
        self.hindsight_summarizer = hindsight_summarizer
        self._init_db()

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _init_db(self) -> None:
        with self._db() as db:
            version = int(db.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise IncidentLedgerError(f"database schema {version} is newer than supported schema {SCHEMA_VERSION}")
            if version == 0:
                db.execute("""CREATE TABLE IF NOT EXISTS incidents (
                    failure_class TEXT NOT NULL,
                    fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
                    summary TEXT NOT NULL,
                    first_seen REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
                    next_attempt_at REAL,
                    escalated INTEGER NOT NULL DEFAULT 0 CHECK(escalated IN (0,1)),
                    release_failure_count INTEGER NOT NULL DEFAULT 0 CHECK(release_failure_count>=0),
                    known_debt INTEGER NOT NULL DEFAULT 1 CHECK(known_debt IN (0,1)),
                    candidate_sha TEXT,
                    causal_evidence TEXT NOT NULL DEFAULT '{}',
                    PRIMARY KEY(failure_class, fingerprint)
                )""")
                columns = {row["name"] for row in db.execute("PRAGMA table_info(incidents)")}
                additions = {
                    "summary": "TEXT NOT NULL DEFAULT ''",
                    "first_seen": "REAL NOT NULL DEFAULT 0",
                    "last_seen": "REAL NOT NULL DEFAULT 0",
                    "attempt_count": "INTEGER NOT NULL DEFAULT 0",
                    "next_attempt_at": "REAL",
                    "escalated": "INTEGER NOT NULL DEFAULT 0",
                    "release_failure_count": "INTEGER NOT NULL DEFAULT 0",
                    "known_debt": "INTEGER NOT NULL DEFAULT 1",
                    "candidate_sha": "TEXT",
                    "causal_evidence": "TEXT NOT NULL DEFAULT '{}'",
                }
                for name, ddl in additions.items():
                    if name not in columns:
                        db.execute(f"ALTER TABLE incidents ADD COLUMN {name} {ddl}")
                db.execute("""CREATE TABLE IF NOT EXISTS incident_attempts (
                    id INTEGER PRIMARY KEY,
                    failure_class TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    attempt INTEGER NOT NULL CHECK(attempt>0),
                    occurred_at REAL NOT NULL,
                    next_attempt_at REAL,
                    escalated INTEGER NOT NULL CHECK(escalated IN (0,1)),
                    known_debt INTEGER NOT NULL CHECK(known_debt IN (0,1)),
                    release_failure INTEGER NOT NULL CHECK(release_failure IN (0,1)),
                    UNIQUE(failure_class, fingerprint, attempt),
                    FOREIGN KEY(failure_class, fingerprint) REFERENCES incidents(failure_class, fingerprint) ON DELETE CASCADE
                )""")
                db.execute("CREATE INDEX IF NOT EXISTS incident_attempts_recent ON incident_attempts(failure_class, fingerprint, occurred_at DESC)")
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @staticmethod
    def _epoch(value: float | None, clock: Callable[[], float]) -> float:
        result = clock() if value is None else value
        if not isinstance(result, (int, float)) or not math.isfinite(result):
            raise IncidentLedgerError("now must be a finite epoch timestamp")
        return float(result)

    def record_failure(
        self,
        failure_class: str,
        reason: str,
        *,
        candidate_sha: str | None = None,
        causal_evidence: Mapping[str, Any] | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        """Record one failed attempt, refusing repeats before backoff or after escalation."""
        if failure_class not in self.policies:
            raise IncidentLedgerError(f"unknown failure class: {failure_class}")
        instant = self._epoch(now, self.clock)
        normalized = normalize_failure(reason) or "unknown failure"
        fingerprint = failure_fingerprint(failure_class, reason)
        evidence = _safe_evidence(candidate_sha, causal_evidence)
        linked = _has_candidate_cause(candidate_sha, evidence)
        release_failure = failure_class == "release" and linked
        known_debt = failure_class == "release" and not linked
        policy = self.policies[failure_class]
        with self._db() as db:
            row = db.execute(
                "SELECT * FROM incidents WHERE failure_class=? AND fingerprint=?",
                (failure_class, fingerprint),
            ).fetchone()
            if row and row["escalated"]:
                return {"allowed": False, "reason": "budget-exhausted", "fingerprint": fingerprint, "attempt": row["attempt_count"]}
            if row and row["next_attempt_at"] is not None and instant < row["next_attempt_at"]:
                return {"allowed": False, "reason": "backoff", "fingerprint": fingerprint, "attempt": row["attempt_count"], "nextAttemptAt": row["next_attempt_at"]}

            attempt = (row["attempt_count"] if row else 0) + 1
            escalated = attempt >= policy["budget"]
            delay = min(policy["baseDelaySeconds"] * (2 ** (attempt - 1)), policy["maxDelaySeconds"])
            next_attempt_at = None if escalated else instant + delay
            serialized_evidence = json.dumps(evidence, sort_keys=True, separators=(",", ":"))
            if row:
                db.execute("""UPDATE incidents SET summary=?,last_seen=?,attempt_count=?,next_attempt_at=?,escalated=?,
                    release_failure_count=release_failure_count+?,known_debt=?,candidate_sha=?,causal_evidence=?
                    WHERE failure_class=? AND fingerprint=?""", (
                    normalized, instant, attempt, next_attempt_at, int(escalated), int(release_failure), int(known_debt),
                    candidate_sha, serialized_evidence, failure_class, fingerprint,
                ))
            else:
                db.execute("""INSERT INTO incidents(failure_class,fingerprint,summary,first_seen,last_seen,attempt_count,
                    next_attempt_at,escalated,release_failure_count,known_debt,candidate_sha,causal_evidence)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    failure_class, fingerprint, normalized, instant, instant, attempt, next_attempt_at, int(escalated),
                    int(release_failure), int(known_debt), candidate_sha, serialized_evidence,
                ))
            db.execute("""INSERT INTO incident_attempts(failure_class,fingerprint,attempt,occurred_at,next_attempt_at,
                escalated,known_debt,release_failure) VALUES(?,?,?,?,?,?,?,?)""", (
                failure_class, fingerprint, attempt, instant, next_attempt_at, int(escalated), int(known_debt), int(release_failure),
            ))

        result: dict[str, Any] = {
            "allowed": True, "failureClass": failure_class, "fingerprint": fingerprint, "attempt": attempt,
            "budget": policy["budget"], "nextAttemptAt": next_attempt_at, "escalated": escalated,
            "knownDebt": known_debt, "releaseFailure": release_failure,
        }
        if self.hindsight_summarizer:
            safe_summary = {key: result[key] for key in ("failureClass", "fingerprint", "attempt", "escalated", "knownDebt", "releaseFailure")}
            try:
                self.hindsight_summarizer(safe_summary)
                result["hindsightSummary"] = "ok"
            except Exception as exc:  # optional memory must never change ledger outcomes
                print(f"warning: optional Hindsight summary unavailable ({type(exc).__name__})", file=sys.stderr)
                result["hindsightSummary"] = "unavailable"
        return result

    def get_incident(self, failure_class: str, fingerprint: str) -> dict[str, Any] | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM incidents WHERE failure_class=? AND fingerprint=?", (failure_class, fingerprint)).fetchone()
        if not row:
            return None
        value = dict(row)
        value["causal_evidence"] = json.loads(value["causal_evidence"])
        return value

    def attempts(self, failure_class: str, fingerprint: str) -> list[dict[str, Any]]:
        with self._db() as db:
            rows = db.execute("SELECT * FROM incident_attempts WHERE failure_class=? AND fingerprint=? ORDER BY attempt", (failure_class, fingerprint)).fetchall()
        return [dict(row) for row in rows]
