#!/usr/bin/env python3
"""Validate each new merged dev SHA locally, stage its exact bytes, then activate dev.

The scheduler is intentionally single-flight. It persists every attempt before
starting work, validates in a detached worktree, stores bounded output and an
integrity digest, and never advances a release pointer after a failed check.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import shutil
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Any, Iterator

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.release.factory_activation import ActivationCoordinator, ActivationError  # noqa: E402
from scripts.release.factory_release_controller import (  # noqa: E402
    ControllerError,
    ReleaseController,
    atomic_write,
    canonical_json,
    exclusive_lock,
    run_git,
)

SHA_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
MAX_OUTPUT_BYTES = 128 * 1024


class SchedulerError(RuntimeError):
    pass


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LocalPromotionScheduler:
    def __init__(
        self,
        repo: pathlib.Path,
        store: pathlib.Path,
        config_path: pathlib.Path,
        *,
        remote: str = "origin",
        branch: str = "dev",
        registry: pathlib.Path | None = None,
        timeout_seconds: int = 7200,
        request: Any = None,
    ) -> None:
        self.repo = repo.resolve(strict=True)
        self.store = store.resolve() if store.exists() else store.absolute()
        self.config_path = config_path.resolve(strict=True)
        self.remote = remote
        self.branch = branch
        self.registry = registry or self.repo / "config" / "factory-projects.json"
        self.timeout_seconds = max(60, min(int(timeout_seconds), 8 * 60 * 60))
        self.records = self.store / "promotion-records"
        self.worktrees = self.store / "worktrees"
        self.db_path = self.store / "scheduler.sqlite3"
        self.store.mkdir(parents=True, exist_ok=True)
        self.records.mkdir(parents=True, exist_ok=True)
        self.worktrees.mkdir(parents=True, exist_ok=True)
        self.config = self._load_config()
        self.github_repo = self.config.get("githubRepository")
        if not isinstance(self.github_repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.github_repo):
            raise SchedulerError("scheduler config requires an explicit owner/repository githubRepository")
        self._init_db()
        self.controller = ReleaseController(self.repo, self.store / "release-store", remote, branch, 3, 30, 4)
        self.coordinator = ActivationCoordinator(self.controller, self.registry, request=request)

    def _load_config(self) -> dict[str, Any]:
        try:
            value = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SchedulerError(f"scheduler config is unreadable: {exc}") from exc
        if not isinstance(value, dict) or value.get("schemaVersion") != "factory-local-promotion/v1":
            raise SchedulerError("scheduler config must use schemaVersion factory-local-promotion/v1")
        if value.get("maxParallel") != 1:
            raise SchedulerError("local promotion is single-flight; maxParallel must be exactly 1")
        if value.get("gpuSlots") != 0:
            raise SchedulerError("automatic dev promotion must reserve zero GPU slots")
        checks = value.get("checks")
        if not isinstance(checks, list) or not checks:
            raise SchedulerError("scheduler config must define a non-empty checks list")
        ids: set[str] = set()
        for check in checks:
            if not isinstance(check, dict) or not isinstance(check.get("id"), str) or not check["id"]:
                raise SchedulerError("every configured check requires an id")
            if check["id"] in ids:
                raise SchedulerError(f"duplicate check id: {check['id']}")
            ids.add(check["id"])
            command = check.get("command")
            if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
                raise SchedulerError(f"check {check['id']} command must be a non-empty argv array")
            if not isinstance(check.get("required", True), bool):
                raise SchedulerError(f"check {check['id']} required must be boolean")
            if check.get("requiresGpu", False):
                raise SchedulerError(f"check {check['id']} requests a GPU, but automatic promotions reserve zero GPU slots")
            patterns = check.get("when", ["**"])
            if not isinstance(patterns, list) or not patterns or not all(isinstance(item, str) and item for item in patterns):
                raise SchedulerError(f"check {check['id']} when must be a non-empty pattern list")
            check["when"] = patterns
            check["timeoutSeconds"] = max(10, min(int(check.get("timeoutSeconds", 3600)), 8 * 60 * 60))
            if check.get("allowExistingFailures", False):
                if not isinstance(check.get("baselineCommand"), list) or not check["baselineCommand"] or not all(isinstance(item, str) and item for item in check["baselineCommand"]):
                    raise SchedulerError(f"check {check['id']} allows existing failures but has no baselineCommand")
                pattern = check.get("failureFingerprintPattern")
                if not isinstance(pattern, str) or not pattern:
                    raise SchedulerError(f"check {check['id']} allows existing failures but has no failureFingerprintPattern")
                try:
                    re.compile(pattern)
                except re.error as exc:
                    raise SchedulerError(f"check {check['id']} has an invalid failureFingerprintPattern: {exc}") from exc
        return value

    @contextlib.contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("PRAGMA journal_mode=WAL")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _init_db(self) -> None:
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS promotions (
                sha TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
                finished_at TEXT, record_path TEXT, record_digest TEXT, reason TEXT
            )""")

    def _fetch_candidate(self) -> str:
        run_git(self.repo, "fetch", "--no-tags", self.remote, f"refs/heads/{self.branch}", timeout=120)
        sha = run_git(self.repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}").decode().strip()
        if not SHA_RE.fullmatch(sha):
            raise SchedulerError("remote returned an invalid dev commit SHA")
        return sha

    def _verify_reviewed_merge(self, sha: str) -> None:
        if not shutil.which("gh"):
            raise SchedulerError("gh CLI is required to verify merged PR review evidence")
        associated = subprocess.run(
            ["gh", "api", f"repos/{self.github_repo}/commits/{sha}/pulls", "--jq", ".[].number"],
            cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
        )
        if associated.returncode:
            detail = associated.stderr.decode("utf-8", "replace")[-1000:]
            raise SchedulerError(f"could not inspect PRs associated with dev SHA: {detail}")
        numbers = [line.strip() for line in associated.stdout.decode("utf-8", "replace").splitlines() if line.strip().isdigit()]
        for number in numbers:
            result = subprocess.run(
                ["gh", "pr", "view", number, "--repo", self.github_repo, "--json", "state,baseRefName,reviewDecision,mergeCommit"],
                cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
            )
            if result.returncode:
                continue
            try:
                pr = json.loads(result.stdout.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            merge_commit = pr.get("mergeCommit") or {}
            if (pr.get("state") == "MERGED" and pr.get("baseRefName") == self.branch
                    and pr.get("reviewDecision") == "APPROVED" and merge_commit.get("oid") == sha):
                return
        raise SchedulerError(f"dev SHA {sha} has no associated merged {self.branch} PR with an approved review")

    def _changed_paths(self, sha: str) -> list[str]:
        current = self.controller.channels / f"{self.branch}.json"
        base = None
        if current.is_file():
            try:
                value = json.loads(current.read_text(encoding="utf-8"))
                candidate = value.get("currentSha")
                if isinstance(candidate, str) and SHA_RE.fullmatch(candidate):
                    base = candidate
            except (OSError, json.JSONDecodeError):
                raise SchedulerError("dev channel pointer is unreadable; refusing to select validation scope")
        if base:
            result = subprocess.run(["git", "-C", str(self.repo), "merge-base", "--is-ancestor", base, sha], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if result.returncode != 0:
                raise SchedulerError(f"remote dev SHA {sha} is not a descendant of active dev SHA {base}")
            output = run_git(self.repo, "diff", "--name-only", "-z", f"{base}..{sha}")
        else:
            # With no active dev baseline, conservatively select checks for the full tree.
            output = run_git(self.repo, "ls-tree", "-r", "--name-only", "-z", sha)
        return sorted(path for path in output.decode("utf-8", "replace").split("\x00") if path)

    @staticmethod
    def _matches(pattern: str, path: str) -> bool:
        # Match slash-aware patterns and make ** useful on both Python versions.
        return fnmatch.fnmatchcase(path, pattern) or (pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:]))

    def _selected_checks(self, paths: list[str]) -> list[dict[str, Any]]:
        selected = []
        for check in self.config["checks"]:
            if any(self._matches(pattern, path) for pattern in check["when"] for path in paths):
                selected.append(check)
        if not any(item.get("required", True) for item in selected):
            raise SchedulerError("no required validation check matches the candidate changes")
        return selected

    def _execute(self, check: dict[str, Any], command: list[str], worktree: pathlib.Path, sha: str) -> tuple[int | None, bytes, bool, int, str, list[str]]:
        start_clock = time.monotonic()
        try:
            result = subprocess.run(
                command, cwd=worktree, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=min(self.timeout_seconds, check["timeoutSeconds"]), check=False,
                env={**self._safe_environment(), "FACTORY_CANDIDATE_SHA": sha, "FACTORY_LOCAL_PROMOTION": "1", "FACTORY_WORKER_CONCURRENCY": "1", "FACTORY_GPU_SLOTS": "0"},
            )
            output = result.stdout or b""
            exit_code = result.returncode
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or b""
            if isinstance(output, str):
                output = output.encode("utf-8", "replace")
            exit_code = None
        truncated = len(output) > MAX_OUTPUT_BYTES
        preview = output[:MAX_OUTPUT_BYTES].decode("utf-8", "replace")
        pattern = re.compile(check["failureFingerprintPattern"]) if check.get("allowExistingFailures") else None
        fingerprints = pattern.findall(output.decode("utf-8", "replace")) if pattern else []
        if fingerprints and isinstance(fingerprints[0], tuple):
            fingerprints = [" ".join(item) for item in fingerprints]
        return exit_code, output, truncated, int((time.monotonic() - start_clock) * 1000), preview, sorted(set(fingerprints))

    def _run_check(self, check: dict[str, Any], worktree: pathlib.Path, sha: str) -> dict[str, Any]:
        started = now()
        exit_code, output, truncated, duration_ms, preview, fingerprints = self._execute(check, check["command"], worktree, sha)
        status = "passed" if exit_code == 0 else "failed"
        result: dict[str, Any] = {
            "id": check["id"], "required": check.get("required", True), "status": status,
            "exitCode": exit_code, "startedAt": started, "finishedAt": now(),
            "durationMs": duration_ms, "outputPreview": preview, "outputTruncated": truncated,
            "outputDigest": "sha256:" + hashlib.sha256(output).hexdigest(),
        }
        if check.get("allowExistingFailures") and status == "failed":
            base_sha = self._active_sha()
            if not base_sha or not fingerprints:
                result["baseline"] = {"status": "unavailable", "sha": base_sha, "reason": "no active baseline SHA or no failure fingerprints"}
                return result
            baseline_path = self.worktrees / f"{base_sha}-{uuid.uuid4()}-baseline"
            try:
                subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--detach", str(baseline_path), base_sha], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=True)
                baseline_exit, baseline_output, baseline_truncated, baseline_ms, baseline_preview, baseline_fingerprints = self._execute(check, check["baselineCommand"], baseline_path, base_sha)
                result["baseline"] = {"sha": base_sha, "status": "passed" if baseline_exit == 0 else "failed", "exitCode": baseline_exit, "durationMs": baseline_ms, "outputTruncated": baseline_truncated, "outputPreview": baseline_preview, "outputDigest": "sha256:" + hashlib.sha256(baseline_output).hexdigest()}
                result["candidateFailureFingerprints"] = fingerprints[:128]
                result["baselineFailureFingerprints"] = baseline_fingerprints[:128]
                if baseline_exit not in (None, 0) and fingerprints and set(fingerprints).issubset(set(baseline_fingerprints)):
                    result["status"] = "preexisting-debt"
                    result["nonblockingExistingFailures"] = len(fingerprints)
            finally:
                if baseline_path.exists():
                    subprocess.run(["git", "-C", str(self.repo), "worktree", "remove", "--force", str(baseline_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
        return result

    def _active_sha(self) -> str | None:
        path = self.controller.channels / f"{self.branch}.json"
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SchedulerError("active channel pointer is unreadable; baseline comparison is unsafe") from exc
        sha = value.get("currentSha") if isinstance(value, dict) else None
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise SchedulerError("active channel pointer has no valid current SHA")
        return sha

    @staticmethod
    def _safe_environment() -> dict[str, str]:
        return {
            key: value for key, value in os.environ.items()
            if not re.search(r"(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL|PRIVATE_KEY)", key, re.IGNORECASE)
        }

    def _write_record(self, record: dict[str, Any]) -> tuple[pathlib.Path, str]:
        data = canonical_json(record)
        value = "sha256:" + hashlib.sha256(data).hexdigest()
        record["recordDigest"] = value
        data = canonical_json(record)
        path = self.records / f"{record['sourceSha']}-{record['promotionId']}.json"
        atomic_write(path, data, mode=0o600)
        return path, "sha256:" + hashlib.sha256(data).hexdigest()

    def _record_status(self, sha: str, status: str, path: pathlib.Path | None = None, record_digest: str | None = None, reason: str | None = None) -> None:
        with self._db() as db:
            db.execute("UPDATE promotions SET status=?,finished_at=?,record_path=?,record_digest=?,reason=? WHERE sha=?",
                       (status, now(), str(path) if path else None, record_digest, reason[:2000] if reason else None, sha))

    def run_once(self, *, retry_failed: bool = False) -> dict[str, Any]:
        with exclusive_lock(self.store / "scheduler.lock"):
            with self._db() as db:
                db.execute("UPDATE promotions SET status='interrupted',finished_at=?,reason='scheduler process exited before recording a result' WHERE status='running'", (now(),))
            sha = self._fetch_candidate()
            with self._db() as db:
                existing = db.execute("SELECT status,record_path,record_digest,reason FROM promotions WHERE sha=?", (sha,)).fetchone()
                if existing and existing["status"] in ("healthy", "failed") and not (retry_failed and existing["status"] == "failed"):
                    return {"status": "unchanged", "sourceSha": sha, "candidateStatus": existing["status"], "recordPath": existing["record_path"]}
                if existing and existing["status"] not in ("interrupted", "failed"):
                    return {"status": "unchanged", "sourceSha": sha, "candidateStatus": existing["status"]}
                db.execute("INSERT INTO promotions(sha,status,started_at) VALUES(?, 'running', ?) ON CONFLICT(sha) DO UPDATE SET status='running',started_at=excluded.started_at,finished_at=NULL,reason=NULL", (sha, now()))

            promotion_id = str(uuid.uuid4())
            paths: list[str] = []
            checks: list[dict[str, Any]] = []
            activation: dict[str, Any] | None = None
            record: dict[str, Any] = {
                "schemaVersion": "factory-local-promotion-record/v1", "promotionId": promotion_id,
                "sourceSha": sha, "branch": self.branch, "status": "failed",
                "startedAt": now(), "changedPaths": paths, "checks": checks,
                "candidateState": "unvalidated",
                "activation": None,
            }
            worktree = self.worktrees / f"{sha}-{promotion_id}"
            try:
                self._verify_reviewed_merge(sha)
                paths = self._changed_paths(sha)
                record["changedPaths"] = paths
                selected = self._selected_checks(paths)
                subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--detach", str(worktree), sha], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=True)
                for check in selected:
                    result = self._run_check(check, worktree, sha)
                    checks.append(result)
                    if result["status"] not in ("passed", "preexisting-debt") and result["required"]:
                        raise SchedulerError(f"required check {result['id']} failed with exit code {result['exitCode']}")
                record["candidateState"] = "validated"
                staged = self.controller.stage_sha(sha)
                record["candidateState"] = "staged"
                record["artifactDigest"] = staged["artifactDigest"]
                record["manifestDigest"] = staged["manifestDigest"]
                activation = self.coordinator.activate(sha)
                record["activation"] = {"status": activation["status"], "activationId": activation.get("activationId"), "targetCount": activation.get("targetCount", 0)}
                record["candidateState"] = "active"
                record["status"] = "healthy"
                record["reason"] = None
            except Exception as exc:
                record["status"] = "failed"
                record["reason"] = str(exc)[:2000]
                raise
            finally:
                record["finishedAt"] = now()
                record["changedPaths"] = paths
                record["checks"] = checks
                if activation is not None:
                    record["activation"] = {"status": activation.get("status"), "activationId": activation.get("activationId"), "targetCount": activation.get("targetCount", 0)}
                path, value = self._write_record(record)
                self._record_status(sha, record["status"], path, value, record.get("reason"))
                if worktree.exists():
                    subprocess.run(["git", "-C", str(self.repo), "worktree", "remove", "--force", str(worktree)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
            return {"status": record["status"], "sourceSha": sha, "recordPath": str(path), "recordDigest": value, "activation": record["activation"]}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=("run",))
    p.add_argument("--repo", default=os.environ.get("FACTORY_CONTROLLER_REPO", "~/cezar-factory"))
    p.add_argument("--store", default=os.environ.get("FACTORY_RELEASE_STORE", "~/.local/share/cezar-factory/release-store"))
    p.add_argument("--config", default="")
    p.add_argument("--registry", default="")
    p.add_argument("--remote", default="origin")
    p.add_argument("--branch", default="dev")
    p.add_argument("--timeout-seconds", type=int, default=7200)
    p.add_argument("--retry-failed", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        repo = pathlib.Path(args.repo).expanduser()
        config = pathlib.Path(args.config).expanduser() if args.config else repo / "config" / "local-release-scheduler.json"
        registry = pathlib.Path(args.registry).expanduser() if args.registry else repo / "config" / "factory-projects.json"
        scheduler = LocalPromotionScheduler(repo, pathlib.Path(args.store).expanduser(), config, remote=args.remote, branch=args.branch, registry=registry, timeout_seconds=args.timeout_seconds)
        print(json.dumps(scheduler.run_once(retry_failed=args.retry_failed), sort_keys=True, separators=(",", ":")))
        return 0
    except (SchedulerError, ActivationError, ControllerError, OSError, sqlite3.Error, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:2000]}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
