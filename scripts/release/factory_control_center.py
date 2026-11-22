#!/usr/bin/env python3
"""Local, versioned Control Center API over the existing Factory release store.

Reads are projections of release manifests, controller checkpoints, activation
receipts, scheduler records and an optional structured worker snapshot. Mutations
delegate to ReleaseController under its existing controller lock.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import hashlib
import hmac
import http.server
import ipaddress
import json
import os
import pathlib
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.parse
from typing import Any, Callable

from scripts.release.factory_release_controller import (
    ControllerError,
    ReleaseController,
    canonical_json,
    exclusive_lock,
)

API_SCHEMA = "factory-control-center/v1"
ACTION_SCHEMA = "factory-control-center-action/v1"
RECEIPT_SCHEMA = "factory-control-center-action-receipt/v1"
AUDIT_SCHEMA = "factory-control-center-audit-event/v1"
ERROR_SCHEMA = "factory-control-center-error/v1"
SHA_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{16,128}$")
CHANNEL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
MAX_BODY = 32 * 1024
MAX_LIMIT = 100
MAX_WAIT_SECONDS = 20
FRESH_SECONDS = 300
ALLOWED_ACTIONS = {"sync", "stage", "rollback", "verify", "protect", "unprotect"}
ROLE_SCOPES = {
    "viewer": {"read"},
    "operator": {"read", "sync", "stage", "verify", "protect", "unprotect"},
    "release-admin": {"read", *ALLOWED_ACTIONS},
}


class ControlCenterError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(dt.timezone.utc)


def _freshness(value: Any, now: dt.datetime, threshold: int = FRESH_SECONDS) -> str:
    parsed = _parse_time(value)
    if parsed is None:
        return "unknown"
    age = (now - parsed).total_seconds()
    return "fresh" if 0 <= age <= threshold else "stale"


def _scrub_text(value: str) -> str:
    text = value[:2000]
    # Path and credential redaction is defense in depth; read-model builders
    # also use field allowlists and never serialize arbitrary controller objects.
    text = re.sub(r"(?i)\\\\[^\\\s\"']+", "[REDACTED_PATH]", text)
    text = re.sub(r"(?i)\b[A-Z]:\\(?:[^\s\"']+)", "[REDACTED_PATH]", text)
    text = re.sub(r"(?<![\w:])/(?:[A-Za-z0-9._~-]+/)+[^\s\"']*", "[REDACTED_PATH]", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)(token|password|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+", r"\1\2[REDACTED]", text)
    return text


def _safe_reason(value: Any, default: str = "Request could not be completed.") -> str:
    if not isinstance(value, str) or not value.strip():
        return default
    return _scrub_text(value.strip())


def _sha256_text(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_json(path: pathlib.Path, *, max_bytes: int = 2_000_000) -> Any:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > max_bytes:
        raise ValueError("record is missing, unsafe, or too large")
    return json.loads(path.read_text(encoding="utf-8"))


def _readonly_db(path: pathlib.Path) -> sqlite3.Connection:
    if path.is_symlink() or not path.is_file():
        raise FileNotFoundError(path.name)
    uri = path.resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=0.2)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA busy_timeout=200")
    return db


def _cursor_encode(staged_at: str, source_sha: str) -> str:
    raw = f"{staged_at}\n{source_sha}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _cursor_decode(value: str) -> tuple[str, str]:
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        staged_at, source_sha = decoded.split("\n", 1)
    except (ValueError, UnicodeError) as exc:
        raise ControlCenterError("invalid_cursor", "The pagination cursor is invalid.") from exc
    if not SHA_RE.fullmatch(source_sha):
        raise ControlCenterError("invalid_cursor", "The pagination cursor is invalid.")
    return staged_at, source_sha


class ControlCenter:
    """Structured read model and idempotent action dispatcher."""

    def __init__(
        self,
        repo: pathlib.Path,
        store: pathlib.Path,
        *,
        scheduler_store: pathlib.Path | None = None,
        registry: pathlib.Path | None = None,
        token_file: pathlib.Path | None = None,
        worker_snapshot: pathlib.Path | None = None,
        cache_file: pathlib.Path | None = None,
        freshness_seconds: int = FRESH_SECONDS,
        clock: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self.repo = repo.expanduser().resolve(strict=False)
        self.store = store.expanduser().resolve(strict=False)
        self.scheduler_store = (scheduler_store or self.store.parent).expanduser().resolve(strict=False)
        self.registry = registry.expanduser().resolve(strict=False) if registry else None
        self.token_file = token_file.expanduser().resolve(strict=False) if token_file else None
        self.worker_snapshot = worker_snapshot.expanduser().resolve(strict=False) if worker_snapshot else None
        self.cache_file = (cache_file or self.store.parent / "control-center-cache.json").expanduser().resolve(strict=False)
        self.freshness_seconds = max(1, min(int(freshness_seconds), 24 * 60 * 60))
        self.clock = clock or (lambda: dt.datetime.now(dt.timezone.utc))
        self.db_path = self.store / "control-center.sqlite3"
        self._event_lock = threading.Lock()

    def _now(self) -> dt.datetime:
        value = self.clock()
        if value.tzinfo is None:
            raise ControlCenterError("invalid_clock", "The API clock must include a timezone.", 500)
        return value.astimezone(dt.timezone.utc)

    def load_tokens(self) -> dict[str, dict[str, Any]]:
        if self.token_file is None:
            return {}
        try:
            raw = _read_json(self.token_file, max_bytes=256_000)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise ControlCenterError("access_config_unavailable", "The local access file is unavailable or invalid.", 503) from exc
        if not isinstance(raw, dict) or raw.get("schemaVersion") != "factory-control-center-access/v1" or not isinstance(raw.get("tokens"), list):
            raise ControlCenterError("invalid_access_config", "The local access file is invalid.", 503)
        result: dict[str, dict[str, Any]] = {}
        for entry in raw["tokens"]:
            if not isinstance(entry, dict):
                raise ControlCenterError("invalid_access_config", "The local access file is invalid.", 503)
            token_id, token_hash, roles = entry.get("tokenId"), entry.get("tokenSha256"), entry.get("roles")
            if not isinstance(token_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", token_id) or not isinstance(token_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", token_hash) or not isinstance(roles, list) or not roles or any(role not in ROLE_SCOPES for role in roles):
                raise ControlCenterError("invalid_access_config", "The local access file is invalid.", 503)
            if token_hash in result:
                raise ControlCenterError("invalid_access_config", "The local access file has duplicate credentials.", 503)
            result[token_hash] = {"tokenId": token_id, "roles": sorted(set(roles)), "scopes": sorted(set().union(*(ROLE_SCOPES[role] for role in roles)))}
        return result

    def authenticate(self, token: str | None) -> dict[str, Any]:
        if not token or len(token) > 1024:
            raise ControlCenterError("unauthorized", "A valid bearer token is required.", 401)
        digest_value = _sha256_text(token.encode("utf-8"))
        for known_hash, identity in self.load_tokens().items():
            if hmac.compare_digest(digest_value, known_hash):
                return identity
        raise ControlCenterError("unauthorized", "A valid bearer token is required.", 401)

    def authorize(self, identity: dict[str, Any], scope: str) -> None:
        if scope not in identity.get("scopes", []):
            self._append_audit("action-denied", identity.get("tokenId", "unknown"), {"scope": scope, "reason": "permission-denied"})
            raise ControlCenterError("forbidden", "The token does not have permission for this operation.", 403)

    def _controller(self, channel: str, *, initialize: bool = False) -> ReleaseController:
        if channel not in {"dev", "stable"}:
            raise ControlCenterError("invalid_channel", "The release channel is invalid.")
        if not self.repo.is_dir() or not (self.repo / ".git").exists():
            raise ControlCenterError("controller_unavailable", "The release controller is unavailable.", 503)
        return ReleaseController(self.repo, self.store, "origin", channel, 3, 30, 4, initialize=initialize)

    def _registry_projects(self) -> list[dict[str, str]]:
        if self.registry is None:
            return []
        try:
            raw = _read_json(self.registry, max_bytes=1_000_000)
        except (OSError, ValueError, json.JSONDecodeError):
            return []
        if not isinstance(raw, list):
            return []
        result = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            project_id = item.get("projectId")
            if not isinstance(project_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", project_id):
                continue
            name = item.get("name")
            result.append({"projectId": project_id, "name": _scrub_text(name) if isinstance(name, str) else project_id})
        return sorted(result, key=lambda row: row["projectId"])

    def _pointer(self, channel: str) -> dict[str, Any] | None:
        path = self.store / "channels" / f"{channel}.json"
        try:
            row = _read_json(path, max_bytes=64_000)
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        if not isinstance(row, dict) or row.get("schemaVersion") != "factory-release-channel-pointer/v1" or row.get("channel") != channel or not SHA_RE.fullmatch(str(row.get("currentSha", ""))):
            return None
        return {"channel": channel, "currentSha": row["currentSha"], "lastGoodSha": row.get("lastGoodSha") if isinstance(row.get("lastGoodSha"), str) and SHA_RE.fullmatch(row["lastGoodSha"]) else row["currentSha"], "updatedAt": row.get("updatedAt") if _parse_time(row.get("updatedAt")) else None}

    def _receipts(self, channel: str) -> list[dict[str, Any]]:
        base = self.store / "receipts"
        if base.is_symlink() or not base.is_dir():
            return []
        rows: list[dict[str, Any]] = []
        # This walk is strictly inside the explicitly configured release store.
        for path in base.glob(f"*/{channel}/*.json"):
            try:
                if path.is_symlink() or not path.resolve().is_relative_to(base.resolve()):
                    continue
                value = _read_json(path, max_bytes=128_000)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if not isinstance(value, dict) or value.get("schemaVersion") != "factory-deployment-receipt/v1":
                continue
            if not isinstance(value.get("targetId"), str) or not SHA_RE.fullmatch(str(value.get("desiredSha", ""))):
                continue
            rows.append({key: value.get(key) for key in ("receiptId", "targetId", "channel", "desiredSha", "actualSha", "observedSha", "state", "requestedAt", "stagedAt", "activatedAt", "observedAt", "compatibility", "reasonCode", "message") if key in value})
        return rows

    def _release_rows(self, channel: str | None = None) -> list[dict[str, Any]]:
        database = self.store / "controller.sqlite3"
        try:
            with contextlib.closing(_readonly_db(database)) as db:
                sql = "SELECT source_sha, channel, manifest_digest, artifact_digest, state, staged_at FROM releases"
                args: tuple[Any, ...] = ()
                if channel:
                    sql += " WHERE channel=?"
                    args = (channel,)
                sql += " ORDER BY staged_at DESC, source_sha ASC, channel ASC"
                db_rows = [dict(row) for row in db.execute(sql, args)]
        except (OSError, sqlite3.Error):
            return []
        output = []
        for row in db_rows:
            sha, channel_name = row.get("source_sha"), row.get("channel")
            if not isinstance(sha, str) or not SHA_RE.fullmatch(sha) or not isinstance(channel_name, str) or not CHANNEL_RE.fullmatch(channel_name):
                continue
            path = self.store / "releases" / sha
            try:
                if path.is_symlink() or not path.resolve().is_relative_to((self.store / "releases").resolve()):
                    continue
                manifest = _read_json(path / "manifest.json")
                state = _read_json(path / "state.json", max_bytes=128_000)
            except (OSError, ValueError, json.JSONDecodeError):
                manifest, state = {}, {}
            source = manifest.get("source") if isinstance(manifest, dict) else None
            verification = manifest.get("verification") if isinstance(manifest, dict) else None
            if not isinstance(source, dict) or source.get("sha") != sha or not isinstance(verification, dict):
                manifest, state = {}, {}
            pointer = self._pointer(channel_name)
            desired = pointer.get("currentSha") if pointer else None
            observed = _parse_time((state or {}).get("updatedAt"))
            observed_at = observed.isoformat(timespec="milliseconds").replace("+00:00", "Z") if observed else None
            now = self._now()
            output.append({
                "channel": channel_name,
                "sourceSha": sha,
                "desiredSha": desired,
                "actualSha": sha if row.get("state") == "verified" else None,
                "observedSha": sha if row.get("state") == "verified" and observed else None,
                "state": row.get("state") if row.get("state") in {"verified", "failed", "unknown"} else "unknown",
                "stagedAt": row.get("staged_at") if _parse_time(row.get("staged_at")) else None,
                "observedAt": observed_at,
                "freshness": _freshness(observed_at, now, self.freshness_seconds),
                "drift": "unknown" if desired is None else "clear" if desired == sha else "drift",
                "health": "healthy" if row.get("state") == "verified" and observed_at and _freshness(observed_at, now, self.freshness_seconds) == "fresh" else "unknown",
                "manifestDigest": row.get("manifest_digest") if isinstance(row.get("manifest_digest"), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", row["manifest_digest"]) else None,
                "artifactDigest": row.get("artifact_digest") if isinstance(row.get("artifact_digest"), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", row["artifact_digest"]) else None,
                "verification": {"status": verification.get("status"), "digest": verification.get("digest")} if isinstance(verification, dict) and verification.get("status") in {"passed", "failed", "unknown"} else None,
            })
        return output

    def _promotions(self) -> list[dict[str, Any]]:
        db_path = self.scheduler_store / "scheduler.sqlite3"
        rows: list[dict[str, Any]] = []
        try:
            with contextlib.closing(_readonly_db(db_path)) as db:
                cols = {row[1] for row in db.execute("PRAGMA table_info(promotions)")}
                if {"sha", "status", "started_at", "finished_at", "record_path", "record_digest"}.issubset(cols):
                    rows = [dict(row) for row in db.execute("SELECT sha,status,started_at,finished_at,record_path,record_digest,stage,stage_at FROM promotions ORDER BY started_at DESC, sha ASC LIMIT 200")]
        except (OSError, sqlite3.Error):
            return []
        output = []
        for row in rows:
            sha = row.get("sha")
            if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
                continue
            record = None
            raw_path = row.get("record_path")
            if isinstance(raw_path, str) and not pathlib.PurePosixPath(raw_path).is_absolute() and not pathlib.PureWindowsPath(raw_path).is_absolute():
                candidate = self.scheduler_store / raw_path
                try:
                    if candidate.resolve().is_relative_to(self.scheduler_store.resolve()):
                        record = _read_json(candidate, max_bytes=512_000)
                except (OSError, ValueError, json.JSONDecodeError):
                    pass
            output.append({"sourceSha": sha, "status": _scrub_text(str(row.get("status", "unknown"))), "stage": _scrub_text(str(row.get("stage") or "unknown")), "startedAt": row.get("started_at") if _parse_time(row.get("started_at")) else None, "finishedAt": row.get("finished_at") if _parse_time(row.get("finished_at")) else None, "recordDigest": row.get("record_digest") if isinstance(row.get("record_digest"), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", row["record_digest"]) else None, "checks": _project_checks(record)})
        return output

    def _worker_resources(self) -> dict[str, Any]:
        if self.worker_snapshot:
            try:
                value = _read_json(self.worker_snapshot, max_bytes=256_000)
                if isinstance(value, dict) and value.get("schemaVersion") == "factory-worker-resources/v1":
                    rows = value.get("workers")
                    if isinstance(rows, list):
                        safe = []
                        for row in rows:
                            if not isinstance(row, dict) or not isinstance(row.get("workerId"), str):
                                continue
                            safe.append({"workerId": _scrub_text(row["workerId"]), "state": row.get("state") if row.get("state") in {"idle", "running", "waiting", "offline", "unknown"} else "unknown", "cpuMillis": _nonnegative_int(row.get("cpuMillis")), "memoryBytes": _nonnegative_int(row.get("memoryBytes")), "gpuSlots": _nonnegative_int(row.get("gpuSlots")), "observedAt": row.get("observedAt") if _parse_time(row.get("observedAt")) else None})
                        if safe:
                            return {"availability": "available", "observedAt": value.get("observedAt") if _parse_time(value.get("observedAt")) else None, "workers": safe}
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        # The release scheduler is single-flight by contract. Its durable active
        # promotion rows give a structured worker-slot count; CPU and memory use
        # remain unknown unless a worker sampler supplied them above.
        active = [row for row in self._promotions() if row["status"] in {"running", "started"}]
        return {"availability": "partial" if (self.scheduler_store / "scheduler.sqlite3").is_file() else "unknown", "observedAt": utc_now() if (self.scheduler_store / "scheduler.sqlite3").is_file() else None, "workers": [{"workerId": "factory-local-promotion", "state": "running" if active else "idle", "cpuMillis": None, "memoryBytes": None, "gpuSlots": 0, "observedAt": active[0]["startedAt"] if active else None}], "activeSlots": len(active), "slotLimit": 1, "unknownMetrics": ["cpuMillis", "memoryBytes"]}

    def _incidents(self) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        quarantine = self.store / "quarantine"
        if quarantine.is_dir() and not quarantine.is_symlink():
            for path in sorted(quarantine.glob("*.json"))[-200:]:
                try:
                    record = _read_json(path, max_bytes=64_000)
                except (OSError, ValueError, json.JSONDecodeError):
                    continue
                if not isinstance(record, dict) or record.get("schemaVersion") != "factory-release-quarantine/v1" or not SHA_RE.fullmatch(str(record.get("sourceSha", ""))):
                    continue
                output.append({"id": record["sourceSha"], "sourceSha": record["sourceSha"], "state": "quarantined", "reasonCode": _safe_reason(record.get("reasonCode"), "unknown"), "summary": _safe_reason(record.get("reason")), "updatedAt": record.get("updatedAt") if _parse_time(record.get("updatedAt")) else None})
        incident_db = self.store / "incidents.sqlite3"
        try:
            with contextlib.closing(_readonly_db(incident_db)) as db:
                rows = db.execute("SELECT failure_class,fingerprint,summary,last_seen,attempt_count,escalated,candidate_sha FROM incidents ORDER BY last_seen DESC LIMIT 200").fetchall()
            for row in rows:
                if not re.fullmatch(r"[0-9a-f]{64}", str(row["fingerprint"])):
                    continue
                output.append({"id": row["fingerprint"], "sourceSha": row["candidate_sha"] if isinstance(row["candidate_sha"], str) and SHA_RE.fullmatch(row["candidate_sha"]) else None, "state": "escalated" if row["escalated"] else "open", "failureClass": _scrub_text(str(row["failure_class"])), "summary": _safe_reason(row["summary"]), "attemptCount": _nonnegative_int(row["attempt_count"]), "updatedAt": dt.datetime.fromtimestamp(float(row["last_seen"]), dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})
        except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError):
            pass
        return sorted(output, key=lambda row: (row.get("updatedAt") or "", row["id"]), reverse=True)[:200]

    def _live_snapshot(self) -> dict[str, Any]:
        now = self._now()
        channels = sorted({p.stem for p in (self.store / "channels").glob("*.json") if CHANNEL_RE.fullmatch(p.stem)} | {"dev", "stable"})
        releases = self._release_rows()
        receipts = [receipt for channel in channels for receipt in self._receipts(channel)]
        promotions = self._promotions()
        projects = self._registry_projects()
        project_rows = []
        for project in projects:
            targets = []
            for channel in channels:
                matching = [row for row in receipts if row.get("targetId") == project["projectId"] and row.get("channel") == channel]
                latest = max(matching, key=lambda row: (row.get("requestedAt") or "", row.get("receiptId") or ""), default=None)
                if latest is None:
                    targets.append({"channel": channel, "desiredSha": None, "actualSha": None, "observedSha": None, "state": "unknown", "freshness": "unknown", "observedAt": None, "receiptId": None, "reasonCode": None})
                    continue
                freshness = _freshness(latest.get("observedAt"), now, self.freshness_seconds)
                desired, actual, observed = latest.get("desiredSha"), latest.get("actualSha"), latest.get("observedSha")
                targets.append({"channel": channel, "desiredSha": desired if isinstance(desired, str) and SHA_RE.fullmatch(desired) else None, "actualSha": actual if isinstance(actual, str) and SHA_RE.fullmatch(actual) else None, "observedSha": observed if isinstance(observed, str) and SHA_RE.fullmatch(observed) else None, "state": latest.get("state") if latest.get("state") in {"pending", "staged", "activating", "active", "incompatible", "failed", "rolled_back"} else "unknown", "freshness": freshness, "observedAt": latest.get("observedAt") if _parse_time(latest.get("observedAt")) else None, "receiptId": latest.get("receiptId") if isinstance(latest.get("receiptId"), str) else None, "reasonCode": _safe_reason(latest.get("reasonCode"), "unknown") if latest.get("reasonCode") else None})
            project_rows.append({**project, "channels": targets})
        release_rows = []
        for row in releases:
            matching_promotions = [p for p in promotions if p["sourceSha"] == row["sourceSha"] and p.get("status") not in {"succeeded", "complete", "completed"}]
            row = dict(row)
            row["stage"] = max(matching_promotions, key=lambda p: p.get("startedAt") or "", default={}).get("stage", "unknown")
            row["promotionStatus"] = max(matching_promotions, key=lambda p: p.get("startedAt") or "", default={}).get("status", "unknown")
            row["targets"] = [target for project in project_rows for target in project["channels"] if target["channel"] == row["channel"] and target["desiredSha"] == row["sourceSha"]]
            release_rows.append(row)
        stored = self.store.is_dir() and (self.store / "controller.sqlite3").is_file()
        reasons = [] if stored else ["release-store-unavailable"]
        return {"schemaVersion": API_SCHEMA, "generatedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"), "source": {"status": "online" if stored else "degraded", "observedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z") if stored else None, "reasons": reasons}, "projects": project_rows, "releases": release_rows, "promotions": promotions, "incidents": self._incidents(), "workerResources": self._worker_resources()}

    def read(self) -> dict[str, Any]:
        try:
            model = self._live_snapshot()
            if model["source"]["status"] == "online":
                self._write_cache(model)
            else:
                cached = self._read_cache()
                if cached:
                    return _as_degraded(cached, self._now(), "release-store-unavailable")
            return model
        except (OSError, sqlite3.Error, ValueError, TypeError, ControlCenterError):
            cached = self._read_cache()
            if cached:
                return _as_degraded(cached, self._now(), "release-store-unavailable")
            now = self._now().isoformat(timespec="milliseconds").replace("+00:00", "Z")
            return {"schemaVersion": API_SCHEMA, "generatedAt": now, "source": {"status": "offline", "observedAt": None, "reasons": ["release-store-unavailable"]}, "projects": [], "releases": [], "promotions": [], "incidents": [], "workerResources": {"availability": "unknown", "observedAt": None, "workers": [], "activeSlots": None, "slotLimit": None, "unknownMetrics": ["cpuMillis", "memoryBytes"]}}

    def _write_cache(self, model: dict[str, Any]) -> None:
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.cache_file.with_name(f".{self.cache_file.name}.{secrets.token_hex(8)}.tmp")
            temporary.write_bytes(canonical_json(model))
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            os.replace(temporary, self.cache_file)
        except OSError:
            pass

    def _read_cache(self) -> dict[str, Any] | None:
        try:
            value = _read_json(self.cache_file, max_bytes=4_000_000)
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) and value.get("schemaVersion") == API_SCHEMA else None

    def list_releases(self, *, channel: str | None = None, state: str | None = None, limit: int = 25, cursor: str | None = None) -> dict[str, Any]:
        if channel is not None and not CHANNEL_RE.fullmatch(channel):
            raise ControlCenterError("invalid_filter", "The channel filter is invalid.")
        if state is not None and state not in {"verified", "failed", "unknown"}:
            raise ControlCenterError("invalid_filter", "The state filter is invalid.")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
            raise ControlCenterError("invalid_limit", f"Limit must be between 1 and {MAX_LIMIT}.")
        rows = [row for row in self.read()["releases"] if (channel is None or row["channel"] == channel) and (state is None or row["state"] == state)]
        rows.sort(key=lambda row: (row.get("stagedAt") or "", row["sourceSha"]), reverse=True)
        if cursor:
            anchor_time, anchor_sha = _cursor_decode(cursor)
            rows = [row for row in rows if (row.get("stagedAt") or "", row["sourceSha"]) < (anchor_time, anchor_sha)]
        page = rows[:limit]
        next_cursor = _cursor_encode(page[-1].get("stagedAt") or "", page[-1]["sourceSha"]) if len(rows) > limit and page else None
        return {"schemaVersion": "factory-control-center-release-page/v1", "items": page, "nextCursor": next_cursor}

    def _connect_write(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS actions (idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, action TEXT NOT NULL, channel TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, submitted_at TEXT NOT NULL, completed_at TEXT, receipt_json TEXT)")
        db.execute("CREATE TABLE IF NOT EXISTS audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL, event_type TEXT NOT NULL, actor_id TEXT NOT NULL, payload_json TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS observed_snapshots (key TEXT PRIMARY KEY, digest TEXT NOT NULL, observed_at TEXT NOT NULL)")
        return db

    def _append_audit(self, event_type: str, actor_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            with contextlib.closing(self._connect_write()) as db:
                event_id = secrets.token_hex(16)
                occurred_at = utc_now()
                safe_payload = _safe_audit_payload(payload)
                db.execute("INSERT INTO audit_events(event_id,occurred_at,event_type,actor_id,payload_json) VALUES(?,?,?,?,?)", (event_id, occurred_at, event_type, _scrub_text(str(actor_id)), canonical_json(safe_payload).decode("utf-8")))
                sequence = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
                return {"schemaVersion": AUDIT_SCHEMA, "cursor": sequence, "eventId": event_id, "occurredAt": occurred_at, "eventType": event_type, "actorId": _scrub_text(str(actor_id)), "payload": safe_payload}
        except sqlite3.Error as exc:
            raise ControlCenterError("audit_unavailable", "The audit log is unavailable; no action was accepted.", 503) from exc

    def list_events(self, cursor: int = 0, limit: int = 50, wait_seconds: int = 0) -> dict[str, Any]:
        if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
            raise ControlCenterError("invalid_cursor", "The change cursor must be a non-negative integer.")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
            raise ControlCenterError("invalid_limit", f"Limit must be between 1 and {MAX_LIMIT}.")
        if isinstance(wait_seconds, bool) or not isinstance(wait_seconds, int) or not 0 <= wait_seconds <= MAX_WAIT_SECONDS:
            raise ControlCenterError("invalid_wait", f"Long-poll wait must be between 0 and {MAX_WAIT_SECONDS} seconds.")
        self._observe_source_changes()
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                with contextlib.closing(self._connect_write()) as db:
                    rows = db.execute("SELECT sequence,event_id,occurred_at,event_type,actor_id,payload_json FROM audit_events WHERE sequence>? ORDER BY sequence LIMIT ?", (cursor, limit)).fetchall()
                    latest = int(db.execute("SELECT COALESCE(MAX(sequence),0) FROM audit_events").fetchone()[0])
            except sqlite3.Error as exc:
                raise ControlCenterError("event_feed_unavailable", "The event feed is unavailable.", 503) from exc
            if rows or time.monotonic() >= deadline:
                break
            time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
        events = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (ValueError, TypeError):
                payload = {}
            events.append({"schemaVersion": AUDIT_SCHEMA, "cursor": row["sequence"], "eventId": row["event_id"], "occurredAt": row["occurred_at"], "eventType": row["event_type"], "actorId": row["actor_id"], "payload": payload})
        return {"schemaVersion": "factory-control-center-event-page/v1", "items": events, "cursor": latest, "hasMore": bool(events and events[-1]["cursor"] < latest)}

    def _observe_source_changes(self) -> None:
        model = self.read()
        source = {key: model.get(key) for key in ("projects", "releases", "promotions", "incidents", "workerResources")}
        digest_value = _sha256_text(canonical_json(source))
        try:
            with contextlib.closing(self._connect_write()) as db:
                row = db.execute("SELECT digest FROM observed_snapshots WHERE key='live'").fetchone()
                if row and row["digest"] != digest_value:
                    db.execute("INSERT INTO audit_events(event_id,occurred_at,event_type,actor_id,payload_json) VALUES(?,?,?,?,?)", (secrets.token_hex(16), utc_now(), "read-model-changed", "factory-control-center", canonical_json({"sourceStatus": model.get("source", {}).get("status"), "releaseCount": len(model.get("releases", [])), "projectCount": len(model.get("projects", []))}).decode("utf-8")))
                db.execute("INSERT INTO observed_snapshots(key,digest,observed_at) VALUES('live',?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,observed_at=excluded.observed_at", (digest_value, utc_now()))
        except sqlite3.Error as exc:
            raise ControlCenterError("event_feed_unavailable", "The event feed is unavailable.", 503) from exc

    def get_action(self, key: str) -> dict[str, Any] | None:
        if not KEY_RE.fullmatch(key):
            raise ControlCenterError("invalid_idempotency_key", "The idempotency key is invalid.")
        try:
            with contextlib.closing(self._connect_write()) as db:
                row = db.execute("SELECT receipt_json,status,submitted_at FROM actions WHERE idempotency_key=?", (key,)).fetchone()
        except sqlite3.Error as exc:
            raise ControlCenterError("action_store_unavailable", "The action receipt store is unavailable.", 503) from exc
        if not row:
            return None
        if row["receipt_json"]:
            return json.loads(row["receipt_json"])
        return {"schemaVersion": RECEIPT_SCHEMA, "idempotencyKey": key, "status": "running" if row["status"] == "running" else "interrupted", "submittedAt": row["submitted_at"], "completedAt": None, "message": "The prior request did not record a completion receipt. It will not be repeated automatically."}

    def submit_action(self, request: dict[str, Any], identity: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        parsed = _validate_action_request(request)
        self.authorize(identity, parsed["action"])
        canonical = canonical_json(parsed)
        request_digest = _sha256_text(canonical)
        now = utc_now()
        key = parsed["idempotencyKey"]
        try:
            with contextlib.closing(self._connect_write()) as db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT request_digest,receipt_json,status,submitted_at,actor_id FROM actions WHERE idempotency_key=?", (key,)).fetchone()
                if existing:
                    if existing["request_digest"] != request_digest:
                        db.rollback()
                        raise ControlCenterError("idempotency_conflict", "This key was already used for a different request.", 409)
                    db.commit()
                    if existing["receipt_json"]:
                        return json.loads(existing["receipt_json"]), True
                    return ({"schemaVersion": RECEIPT_SCHEMA, "idempotencyKey": key, "action": parsed["action"], "channel": parsed["channel"], "status": "running" if existing["status"] == "running" else "interrupted", "actorId": existing["actor_id"], "submittedAt": existing["submitted_at"], "completedAt": None, "message": "The prior request has no completion receipt and will not be repeated automatically."}, True)
                db.execute("INSERT INTO actions(idempotency_key,request_digest,action,channel,actor_id,status,submitted_at) VALUES(?,?,?,?,?,'running',?)", (key, request_digest, parsed["action"], parsed["channel"], identity["tokenId"], now))
                db.execute("INSERT INTO audit_events(event_id,occurred_at,event_type,actor_id,payload_json) VALUES(?,?,?,?,?)", (secrets.token_hex(16), now, "action-accepted", identity["tokenId"], canonical_json({"idempotencyKey": key, "action": parsed["action"], "channel": parsed["channel"], "requestDigest": request_digest}).decode("utf-8")))
                db.commit()
        except ControlCenterError:
            raise
        except sqlite3.Error as exc:
            raise ControlCenterError("action_store_unavailable", "The action could not be recorded, so it was not accepted.", 503) from exc
        result: dict[str, Any] | None = None
        failure: str | None = None
        try:
            controller = self._controller(parsed["channel"], initialize=True)
            with exclusive_lock(controller.store / "controller.lock"):
                controller.recover_interrupted_attempts()
                result = _run_controller_action(controller, parsed)
        except (ControllerError, OSError, sqlite3.Error, ValueError, KeyError, TypeError) as exc:
            failure = _safe_reason(str(exc))
        completed = utc_now()
        receipt = {"schemaVersion": RECEIPT_SCHEMA, "idempotencyKey": key, "action": parsed["action"], "channel": parsed["channel"], "status": "failed" if failure else "succeeded", "actorId": identity["tokenId"], "submittedAt": now, "completedAt": completed, "reason": parsed["reason"], "result": _safe_result(result) if result is not None else None, "message": failure}
        encoded = canonical_json(receipt).decode("utf-8")
        try:
            with contextlib.closing(self._connect_write()) as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE actions SET status=?,completed_at=?,receipt_json=? WHERE idempotency_key=?", (receipt["status"], completed, encoded, key))
                db.execute("INSERT INTO audit_events(event_id,occurred_at,event_type,actor_id,payload_json) VALUES(?,?,?,?,?)", (secrets.token_hex(16), completed, "action-completed", identity["tokenId"], canonical_json({"idempotencyKey": key, "action": parsed["action"], "channel": parsed["channel"], "status": receipt["status"], "requestDigest": request_digest}).decode("utf-8")))
                db.commit()
        except sqlite3.Error as exc:
            # The durable running row fences duplicate execution. A retry returns
            # an interrupted receipt instead of repeating a possibly completed action.
            raise ControlCenterError("receipt_unavailable", "The controller action ran but its final receipt could not be recorded; do not retry with a new key.", 503) from exc
        return receipt, False


def _project_checks(record: Any) -> list[dict[str, Any]]:
    if not isinstance(record, dict):
        return []
    raw = record.get("checks")
    if not isinstance(raw, list):
        return []
    result = []
    for item in raw[:100]:
        if not isinstance(item, dict):
            continue
        result.append({"id": _scrub_text(str(item.get("id", "unknown")))[:128], "status": _scrub_text(str(item.get("status", "unknown")))[:64], "required": item.get("required") is True, "durationMs": _nonnegative_int(item.get("durationMs")), "exitCode": item.get("exitCode") if isinstance(item.get("exitCode"), int) and not isinstance(item.get("exitCode"), bool) else None})
    return result


def _nonnegative_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**53 - 1 else None


def _safe_audit_payload(payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"scope", "reason", "idempotencyKey", "action", "channel", "requestDigest", "status", "releaseCount", "projectCount", "sourceStatus"}
    return {key: _scrub_text(str(value))[:256] if isinstance(value, str) else value for key, value in payload.items() if key in allowed and (isinstance(value, (str, int, bool)) or value is None)}


def _safe_result(value: Any) -> Any:
    if isinstance(value, dict):
        safe = {}
        for key, item in value.items():
            if re.search(r"(?:path|token|secret|password|credential|auth)", str(key), re.I):
                continue
            safe[str(key)] = _safe_result(item)
        return safe
    if isinstance(value, list):
        return [_safe_result(item) for item in value[:200]]
    if isinstance(value, str):
        return _scrub_text(value)
    if value is None or isinstance(value, (bool, int)):
        return value
    return None


def _as_degraded(model: dict[str, Any], now: dt.datetime, reason: str) -> dict[str, Any]:
    result = dict(model)
    result["generatedAt"] = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    result["source"] = {"status": "offline", "observedAt": model.get("generatedAt"), "reasons": [reason]}
    result["releases"] = [{**row, "freshness": "stale" if row.get("freshness") != "unknown" else "unknown", "health": "unknown"} for row in model.get("releases", [])]
    result["projects"] = [{**project, "channels": [{**channel, "freshness": "stale" if channel.get("freshness") != "unknown" else "unknown"} for channel in project.get("channels", [])]} for project in model.get("projects", [])]
    return result


def _validate_action_request(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("schemaVersion") != ACTION_SCHEMA:
        raise ControlCenterError("invalid_action", "The action request schema is invalid.")
    allowed = {"schemaVersion", "idempotencyKey", "action", "channel", "reason", "sha", "referenceKind", "referenceId", "expiresAt"}
    if set(raw) - allowed:
        raise ControlCenterError("invalid_action", "The action request contains unsupported fields.")
    action, key, channel = raw.get("action"), raw.get("idempotencyKey"), raw.get("channel")
    if action not in ALLOWED_ACTIONS or not isinstance(key, str) or not KEY_RE.fullmatch(key) or channel not in {"dev", "stable"}:
        raise ControlCenterError("invalid_action", "The action, idempotency key, or channel is invalid.")
    reason = raw.get("reason")
    if not isinstance(reason, str) or not 3 <= len(reason.strip()) <= 500:
        raise ControlCenterError("invalid_action", "A reason between 3 and 500 characters is required.")
    result: dict[str, Any] = {"schemaVersion": ACTION_SCHEMA, "idempotencyKey": key, "action": action, "channel": channel, "reason": _scrub_text(reason.strip())}
    sha = raw.get("sha")
    if sha is not None:
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise ControlCenterError("invalid_action", "A SHA must be a full lowercase Git object id.")
        result["sha"] = sha
    if action == "sync" and sha is not None:
        raise ControlCenterError("invalid_action", "The sync action follows the configured channel ref and does not accept a SHA.")
    kind, reference = raw.get("referenceKind"), raw.get("referenceId")
    expires = raw.get("expiresAt")
    if action in {"rollback", "verify", "protect", "unprotect"} and not sha:
        raise ControlCenterError("invalid_action", f"The {action} action requires a SHA.")
    if action in {"protect", "unprotect"}:
        if not isinstance(kind, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", kind) or not isinstance(reference, str) or not 1 <= len(reference) <= 256 or "\n" in reference:
            raise ControlCenterError("invalid_action", f"The {action} action requires a valid reference kind and id.")
        result["referenceKind"], result["referenceId"] = kind, _scrub_text(reference)
        if expires is not None:
            if action != "protect" or not isinstance(expires, str) or _parse_time(expires) is None:
                raise ControlCenterError("invalid_action", "expiresAt must be an ISO-8601 timestamp with a timezone.")
            result["expiresAt"] = expires
    elif any(raw.get(key) is not None for key in ("referenceKind", "referenceId", "expiresAt")):
        raise ControlCenterError("invalid_action", "Reference fields are only valid for protect and unprotect actions.")
    if action == "stage" and sha:
        result["sha"] = sha
    return result


def _run_controller_action(controller: ReleaseController, request: dict[str, Any]) -> dict[str, Any]:
    action = request["action"]
    if action == "sync":
        return controller.sync()
    if action == "stage":
        return controller.stage_sha(request["sha"]) if request.get("sha") else controller.stage_current()
    if action == "rollback":
        return controller.rollback(request["sha"])
    if action == "verify":
        return controller.verify_release(controller.releases / request["sha"], expected_sha=request["sha"])
    if action == "protect":
        return controller.protect(request["sha"], request["referenceKind"], request["referenceId"], request.get("expiresAt"))
    if action == "unprotect":
        return controller.unprotect(request["sha"], request["referenceKind"], request["referenceId"])
    raise ControlCenterError("invalid_action", "The requested action is unsupported.")


class ControlCenterHandler(http.server.BaseHTTPRequestHandler):
    server_version = "FactoryControlCenter/1"
    sys_version = ""

    @property
    def service(self) -> ControlCenter:
        return self.server.service  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        # Request paths and error text can contain user-provided values.
        return

    def _json(self, status: int, value: dict[str, Any]) -> None:
        body = canonical_json(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _identity(self, scope: str = "read") -> dict[str, Any]:
        header = self.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer":
            token = ""
        identity = self.service.authenticate(token)
        self.service.authorize(identity, scope)
        return identity

    def _error(self, error: ControlCenterError) -> None:
        self._json(error.status, {"schemaVersion": ERROR_SCHEMA, "error": {"code": error.code, "message": _safe_reason(str(error), "The request failed.")}})

    def do_GET(self) -> None:  # noqa: N802
        try:
            identity = self._identity("read")
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, max_num_fields=20)
            if parsed.path == "/api/v1/control-center":
                self._json(200, self.service.read())
                return
            if parsed.path == "/api/v1/releases":
                limit = _query_int(query, "limit", 25)
                result = self.service.list_releases(channel=_query_one(query, "channel"), state=_query_one(query, "state"), limit=limit, cursor=_query_one(query, "cursor"))
                self._json(200, result)
                return
            if parsed.path == "/api/v1/events":
                result = self.service.list_events(_query_int(query, "cursor", 0), _query_int(query, "limit", 50), _query_int(query, "waitSeconds", 0))
                self._json(200, result)
                return
            match = re.fullmatch(r"/api/v1/actions/([A-Za-z0-9._:-]{16,128})", parsed.path)
            if match:
                receipt = self.service.get_action(match.group(1))
                if receipt is None:
                    self._json(404, {"schemaVersion": ERROR_SCHEMA, "error": {"code": "not_found", "message": "The action receipt was not found."}})
                else:
                    self._json(200, receipt)
                return
            self._json(404, {"schemaVersion": ERROR_SCHEMA, "error": {"code": "not_found", "message": "The requested endpoint was not found."}})
        except ControlCenterError as exc:
            self._error(exc)
        except (ValueError, TypeError):
            self._error(ControlCenterError("invalid_query", "The query parameters are invalid."))

    def do_POST(self) -> None:  # noqa: N802
        identity: dict[str, Any] | None = None
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path != "/api/v1/actions":
                self._json(404, {"schemaVersion": ERROR_SCHEMA, "error": {"code": "not_found", "message": "The requested endpoint was not found."}})
                return
            header = self.headers.get("Authorization", "")
            scheme, _, token = header.partition(" ")
            identity = self.service.authenticate(token if scheme.lower() == "bearer" else None)
            if self.headers.get_content_type() != "application/json":
                raise ControlCenterError("invalid_content_type", "Content-Type must be application/json.", 415)
            length = int(self.headers.get("Content-Length", "-1"))
            if length < 0 or length > MAX_BODY:
                raise ControlCenterError("invalid_body_size", "The request body is missing or too large.", 413)
            raw = self.rfile.read(length)
            try:
                request = json.loads(raw.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise ControlCenterError("invalid_json", "The request body must be valid JSON.") from exc
            receipt, replayed = self.service.submit_action(request, identity)
            self._json(200, {**receipt, "replayed": replayed})
        except ControlCenterError as exc:
            self._error(exc)
        except (ValueError, TypeError):
            self._error(ControlCenterError("invalid_request", "The request is invalid."))


def _query_one(query: dict[str, list[str]], key: str) -> str | None:
    values = query.get(key)
    if not values:
        return None
    if len(values) != 1:
        raise ControlCenterError("invalid_query", f"Query parameter {key} may appear only once.")
    return values[0] or None


def _query_int(query: dict[str, list[str]], key: str, default: int) -> int:
    value = _query_one(query, key)
    if value is None:
        return default
    if not re.fullmatch(r"\d{1,8}", value):
        raise ControlCenterError("invalid_query", f"Query parameter {key} must be a non-negative integer.")
    return int(value)


class ThreadingControlCenterServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], service: ControlCenter):
        super().__init__(address, ControlCenterHandler)
        self.service = service


def run_server(service: ControlCenter, host: str = "127.0.0.1", port: int = 8765) -> None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ControlCenterError("invalid_bind_address", "The bind address must be a loopback IP address.") from exc
    if not address.is_loopback or not 0 <= port <= 65535:
        raise ControlCenterError("invalid_bind_address", "The Control Center API binds only to a loopback address and a valid port.")
    server = ThreadingControlCenterServer((host, port), service)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Run the loopback-only Control Center API")
    serve.add_argument("--repo", default=str(pathlib.Path(__file__).resolve().parents[2]))
    serve.add_argument("--store", default="~/.local/share/cezar-factory/release-store")
    serve.add_argument("--scheduler-store", default="~/.local/share/cezar-factory")
    serve.add_argument("--registry", default="~/cezar-factory/config/factory-projects.json")
    serve.add_argument("--token-file", required=True)
    serve.add_argument("--worker-snapshot")
    serve.add_argument("--cache-file")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--freshness-seconds", type=int, default=FRESH_SECONDS)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "serve":
        try:
            service = ControlCenter(pathlib.Path(args.repo), pathlib.Path(args.store), scheduler_store=pathlib.Path(args.scheduler_store), registry=pathlib.Path(args.registry), token_file=pathlib.Path(args.token_file), worker_snapshot=pathlib.Path(args.worker_snapshot) if args.worker_snapshot else None, cache_file=pathlib.Path(args.cache_file) if args.cache_file else None, freshness_seconds=args.freshness_seconds)
            run_server(service, args.host, args.port)
            return 0
        except (ControlCenterError, OSError) as exc:
            print(json.dumps({"schemaVersion": ERROR_SCHEMA, "error": {"code": getattr(exc, "code", "server_error"), "message": _safe_reason(str(exc))}}, sort_keys=True), file=sys.stderr)
            return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
