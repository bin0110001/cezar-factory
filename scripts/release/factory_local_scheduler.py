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
from scripts.release.factory_promotion import (  # noqa: E402
    Breaker,
    CanaryRunner,
    GhRunner,
    PolicyError,
    file_issue,
    fingerprint,
    normalize_policy,
    promote_stable_ref,
    review_decision,
    select_canaries,
)
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
        sleep: Any = time.sleep,
        canary_request: Any = None,
        gh_runner: Any = None,
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
        try:
            self.policy = normalize_policy(self.config.get("promotion"))
        except PolicyError as exc:
            raise SchedulerError(str(exc)) from exc
        self.sleep = sleep
        self.canary_request = canary_request
        self.gh = gh_runner or GhRunner(self.policy["gh"] if self.policy else ["gh"])
        self._init_db()
        self.controller = ReleaseController(self.repo, self.store / "release-store", remote, branch, 3, 30, 4)
        self.coordinator = ActivationCoordinator(self.controller, self.registry, request=request)
        self.breaker = Breaker(self._state_get, self._state_put, self.policy["breakerMax"] if self.policy else 3,
                               self.policy["breakerPauseSeconds"] if self.policy else 3600)

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
            columns = {row["name"] for row in db.execute("PRAGMA table_info(promotions)")}
            for name, ddl in (("stage", "TEXT"), ("stage_at", "REAL"), ("deploy_attempts", "INTEGER DEFAULT 0")):
                if name not in columns:
                    db.execute(f"ALTER TABLE promotions ADD COLUMN {name} {ddl}")
            db.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS approvals (sha TEXT PRIMARY KEY, approved_at TEXT NOT NULL)")

    def _state_get(self, key: str, default: str = "") -> str:
        with self._db() as db:
            row = db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def _state_put(self, key: str, value: str) -> None:
        with self._db() as db:
            db.execute("INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def _fetch_ref(self, branch: str) -> str:
        """Fetch into a private remote-tracking ref so a concurrent fetch cannot overwrite FETCH_HEAD under us."""
        run_git(self.repo, "fetch", "--no-tags", self.remote, f"+refs/heads/{branch}:refs/remotes/{self.remote}/{branch}", timeout=120)
        sha = run_git(self.repo, "rev-parse", "--verify", f"refs/remotes/{self.remote}/{branch}^{{commit}}").decode().strip()
        if not SHA_RE.fullmatch(sha):
            raise SchedulerError(f"remote returned an invalid {branch} commit SHA")
        return sha

    def _fetch_candidate(self) -> str:
        return self._fetch_ref(self.branch)

    def _verify_reviewed_merge(self, sha: str) -> None:
        """Fail-closed review gate; the policy decides whether a recorded self-review is enough."""
        policy = self.policy or {"review": "approval"}
        try:
            numbers_raw = self.gh("api", f"repos/{self.github_repo}/commits/{sha}/pulls", "--jq", ".[].number")
        except (OSError, subprocess.SubprocessError) as exc:
            raise SchedulerError(f"gh is unavailable to verify merged PR review evidence: {exc}") from exc
        if numbers_raw.returncode:
            raise SchedulerError(f"could not inspect PRs associated with dev SHA: {numbers_raw.stderr.decode('utf-8', 'replace')[-1000:]}")
        numbers = [line.strip() for line in numbers_raw.stdout.decode("utf-8", "replace").splitlines() if line.strip().isdigit()]
        reasons: list[str] = []
        for number in numbers:
            result = self.gh("pr", "view", number, "--repo", self.github_repo, "--json", "state,baseRefName,reviewDecision,mergeCommit,body")
            if result.returncode:
                continue
            try:
                pr = json.loads(result.stdout.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            ok, why = review_decision(policy, pr, sha, self.branch)
            if ok:
                return
            reasons.append(f"#{number}: {why}")
        detail = "; ".join(reasons) if reasons else "no associated pull request"
        raise SchedulerError(f"dev SHA {sha} has no merged {self.branch} PR satisfying the {policy['review']} gate ({detail})")

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
                env={**self._safe_environment(), "FACTORY_CANDIDATE_SHA": sha, "FACTORY_GITHUB_REPOSITORY": self.github_repo, "FACTORY_CANDIDATE_BRANCH": self.branch, "FACTORY_LOCAL_PROMOTION": "1", "FACTORY_WORKER_CONCURRENCY": "1", "FACTORY_GPU_SLOTS": "0"},
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

    # ---- stages after the dev channel is active -------------------------------------------------
    FINAL_STAGE = "stable-deployed"

    def _row(self, sha: str) -> sqlite3.Row | None:
        with self._db() as db:
            return db.execute("SELECT * FROM promotions WHERE sha=?", (sha,)).fetchone()

    def _set_stage(self, sha: str, stage: str, **extra: Any) -> None:
        with self._db() as db:
            db.execute("UPDATE promotions SET stage=?,stage_at=? WHERE sha=?", (stage, time.time(), sha))
            if "deploy_attempts" in extra:
                db.execute("UPDATE promotions SET deploy_attempts=? WHERE sha=?", (extra["deploy_attempts"], sha))

    def approve(self, sha: str) -> dict[str, Any]:
        if not SHA_RE.fullmatch(sha):
            raise SchedulerError("approval requires a full lowercase SHA")
        with self._db() as db:
            db.execute("INSERT INTO approvals(sha,approved_at) VALUES(?,?) ON CONFLICT(sha) DO NOTHING", (sha, now()))
        return {"status": "approved", "sourceSha": sha}

    def _approved(self, sha: str) -> bool:
        with self._db() as db:
            return db.execute("SELECT 1 FROM approvals WHERE sha=?", (sha,)).fetchone() is not None

    def _canary_runner(self) -> CanaryRunner:
        targets = {t["projectId"]: t for t in self.coordinator.load_targets()}
        project = self.policy["canaryProject"]
        if project not in targets:
            raise SchedulerError(f"canary project {project} is not in the target registry")
        return CanaryRunner(targets[project]["apiUrl"], project, request=self.canary_request, sleep=self.sleep,
                            ready_seconds=self.policy["canaryReadySeconds"])

    def _run_canaries(self, paths: list[str]) -> list[dict[str, Any]]:
        selected = select_canaries(self.policy, paths) if self.policy else []
        if not selected:
            return []
        runner = self._canary_runner()
        results = []
        for canary in selected:
            result = runner.run(canary)
            results.append(result)
            if result["status"] != "passed":
                break
        return results

    def _rollback_dev(self, previous: str | None, failed: str, reason: str) -> str:
        """Restore the previous dev release and quarantine the failed one; never leaves the pointer on a bad SHA."""
        if not previous:
            return "no previous dev release to restore; operator action required"
        try:
            self.coordinator.rollback(previous)
            self.coordinator._quarantine(failed, "canary-failed", reason)
            return f"rolled dev back to {previous[:9]}"
        except Exception as exc:  # noqa: BLE001 - surfaced in the record and escalated
            return f"rollback to {previous[:9]} FAILED: {str(exc)[:300]}"

    def _failure(self, kind: str, sha: str, reason: str, *, subject: str = "candidate") -> None:
        """Count the failure, open an issue per fingerprint, and escalate when the breaker opens."""
        if not self.policy:
            return
        fp = fingerprint(kind, subject, reason)
        opened = self.breaker.record_failure()
        body = (f"Promotion of `{sha}` failed at **{kind}**.\n\n```\n{reason[:1500]}\n```\n\n"
                f"Pipeline mode: `{self.policy['mode']}`. The previous release stays active. "
                f"Fix on `{self.branch}`; the next merge is promoted automatically.")
        try:
            file_issue(self.gh, self.github_repo, f"[promotion] {kind} failed (fp {fp})", body, self.policy["issueLabels"], fp)
            if opened:
                file_issue(self.gh, self.github_repo, "[promotion] circuit breaker open: repeated promotion failures",
                           f"{self.policy['breakerMax']} consecutive candidates failed; automatic promotion is paused for "
                           f"{self.policy['breakerPauseSeconds']}s or until `factory_local_scheduler.py reset-breaker`.\n\nLatest: {reason[:800]}",
                           self.policy["escalationLabels"], fingerprint("breaker", "pipeline", "open"))
        except (PolicyError, OSError, subprocess.SubprocessError) as exc:
            self._state_put("last_issue_error", str(exc)[:500])

    def _stable_contains(self, sha: str) -> bool:
        try:
            tip = self._fetch_ref(self.policy["stableBranch"])
        except (SchedulerError, ControllerError, subprocess.SubprocessError):
            return False
        return subprocess.run(["git", "-C", str(self.repo), "merge-base", "--is-ancestor", sha, tip],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0

    def _stable_pointer(self) -> str | None:
        path = self.controller.channels / f"{self.policy['stableBranch']}.json"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        sha = value.get("currentSha") if isinstance(value, dict) else None
        return sha if isinstance(sha, str) and SHA_RE.fullmatch(sha) else None

    def _deploy_stable(self, sha: str) -> tuple[bool, str]:
        command = self.policy["deployCommand"]
        if not command:
            return True, "no deploy command configured"
        env = {**self._safe_environment(), "FACTORY_DEPLOY_IDLE_WAIT_SECONDS": str(self.policy["deployIdleWaitSeconds"])}
        try:
            result = subprocess.run(command, cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3600, check=False, env=env)
        except subprocess.TimeoutExpired:
            return False, "stable deploy timed out"
        tail = (result.stdout or b"").decode("utf-8", "replace")[-600:]
        if result.returncode:
            return False, f"stable deploy exited {result.returncode}: {tail}"
        if self._stable_pointer() != sha:
            return False, "deploy finished but the stable channel pointer has not reached this SHA yet (deferred while Cezar is busy)"
        return True, tail

    def _advance(self, sha: str) -> dict[str, Any]:
        """Move a dev-validated candidate through soak, approval, the stable ref, and the stable deploy."""
        row = self._row(sha)
        stage = (row["stage"] if row else None) or "canary-passed"
        if not self.policy or stage == self.FINAL_STAGE:
            return {"status": "unchanged", "sourceSha": sha, "candidateStatus": "healthy", "stage": stage}
        if stage == "canary-passed":
            waited = time.time() - float((row["stage_at"] if row else 0) or 0)
            if waited < self.policy["soakSeconds"]:
                return {"status": "soaking", "sourceSha": sha, "stage": stage, "remainingSeconds": int(self.policy["soakSeconds"] - waited)}
            if self.policy["stable"] == "approval" and not self._approved(sha):
                return {"status": "awaiting-approval", "sourceSha": sha, "stage": stage}
            if not self._stable_contains(sha):
                try:
                    promote_stable_ref(self.gh, self.github_repo, self.policy["stableBranch"], sha)
                except PolicyError as exc:
                    self._failure("stable-promotion", sha, str(exc), subject="stable")
                    return {"status": "stable-promotion-failed", "sourceSha": sha, "stage": stage, "reason": str(exc)[:500]}
            self._set_stage(sha, "stable-promoted")
            row = self._row(sha)
            stage = "stable-promoted"
        if stage == "stable-promoted":
            ok, detail = self._deploy_stable(sha)
            attempts = int((row["deploy_attempts"] if row else 0) or 0) + (0 if ok else 1)
            if ok:
                self._set_stage(sha, self.FINAL_STAGE)
                self.breaker.record_success()
                return {"status": "promoted", "sourceSha": sha, "stage": self.FINAL_STAGE}
            self._set_stage(sha, "stable-promoted", deploy_attempts=attempts)
            if attempts == 3:  # one issue per candidate, not per tick
                self._failure("stable-deploy", sha, detail, subject="stable")
            return {"status": "deploy-pending", "sourceSha": sha, "stage": stage, "attempts": attempts, "detail": detail[-300:]}
        return {"status": "unchanged", "sourceSha": sha, "stage": stage}

    def drift(self) -> dict[str, Any]:
        """Report disagreement between origin, the channel pointers, the host checkout, and what Cezar serves."""
        findings: list[str] = []
        seen: dict[str, Any] = {}
        try:
            seen["originDev"] = self._fetch_ref(self.branch)
            stable_branch = self.policy["stableBranch"] if self.policy else "stable"
            seen["originStable"] = self._fetch_ref(stable_branch)
        except (SchedulerError, ControllerError, subprocess.SubprocessError) as exc:
            return {"status": "unknown", "findings": [f"could not read origin: {exc}"], "seen": seen}
        for channel in ("dev", "stable"):
            path = self.controller.channels / f"{channel}.json"
            try:
                seen[f"{channel}Pointer"] = json.loads(path.read_text(encoding="utf-8")).get("currentSha")
            except (OSError, json.JSONDecodeError):
                seen[f"{channel}Pointer"] = None
        seen["hostCheckout"] = run_git(self.repo, "rev-parse", "HEAD").decode().strip()
        if seen["stablePointer"] and seen["stablePointer"] != seen["originStable"]:
            findings.append(f"stable pointer {seen['stablePointer'][:9]} lags origin/stable {seen['originStable'][:9]}")
        if seen["stablePointer"] and seen["hostCheckout"] != seen["stablePointer"] and seen["hostCheckout"] != seen["originStable"]:
            findings.append(f"host checkout {seen['hostCheckout'][:9]} matches neither the stable pointer nor origin/stable")
        if seen["devPointer"] and seen["stablePointer"] and seen["devPointer"] != seen["stablePointer"]:
            if subprocess.run(["git", "-C", str(self.repo), "merge-base", "--is-ancestor", seen["devPointer"], seen["stablePointer"]],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0:
                findings.append("stable is ahead of dev; stable must only contain SHAs that passed dev canaries")
        if self.policy:
            try:
                runner = self._canary_runner()
                served = runner._retry("GET", "/factory-release", window=0)
                seen["servedByCezar"] = {"channel": served.get("channel"), "sourceSha": served.get("sourceSha")}
                pointer = seen.get(f"{served.get('channel')}Pointer")
                if pointer and served.get("sourceSha") != pointer:
                    findings.append(f"Cezar serves {str(served.get('sourceSha'))[:9]} on {served.get('channel')} but the pointer is {pointer[:9]}")
            except Exception as exc:  # noqa: BLE001
                findings.append(f"could not read what Cezar serves: {str(exc)[:200]}")
        return {"status": "drift" if findings else "ok", "findings": findings, "seen": seen}

    def _drift_watch(self) -> dict[str, Any]:
        report = self.drift()
        if not self.policy:
            return report
        if report["status"] != "drift":
            self._state_put("drift_since", "0")
            return report
        since = float(self._state_get("drift_since", "0") or 0)
        if not since:
            self._state_put("drift_since", str(time.time()))
        elif time.time() - since > self.policy["driftGraceSeconds"]:
            summary = "; ".join(report["findings"])
            try:
                file_issue(self.gh, self.github_repo, "[promotion] release drift persists",
                           f"Drift has persisted past {self.policy['driftGraceSeconds']}s:\n\n{summary}", self.policy["issueLabels"],
                           fingerprint("drift", "pipeline", summary))
            except (PolicyError, OSError, subprocess.SubprocessError) as exc:
                self._state_put("last_issue_error", str(exc)[:500])
        return report

    def status(self, sha: str | None = None) -> dict[str, Any]:
        sha = sha or self._fetch_candidate()
        row = self._row(sha)
        out: dict[str, Any] = {"sourceSha": sha, "known": row is not None}
        if row:
            out.update({"status": row["status"], "stage": row["stage"], "reason": row["reason"], "recordPath": row["record_path"]})
        out["breakerOpen"] = self.breaker.is_open()
        out["consecutiveFailures"] = self.breaker.failures()
        return out

    def run_once(self, *, retry_failed: bool = False) -> dict[str, Any]:
        with exclusive_lock(self.store / "scheduler.lock"):
            with self._db() as db:
                db.execute("UPDATE promotions SET status='interrupted',finished_at=?,reason='scheduler process exited before recording a result' WHERE status='running'", (now(),))
            sha = self._fetch_candidate()
            result = self._run_candidate(sha, retry_failed=retry_failed)
            if self.policy and result["status"] != "paused":
                result["drift"] = self._drift_watch()["status"]
            return result

    def _run_candidate(self, sha: str, *, retry_failed: bool) -> dict[str, Any]:
        existing = self._row(sha)
        if existing and existing["status"] == "healthy":
            return self._advance(sha)
        if existing and existing["status"] == "failed" and not retry_failed:
            return {"status": "unchanged", "sourceSha": sha, "candidateStatus": "failed", "recordPath": existing["record_path"]}
        if existing and existing["status"] not in ("interrupted", "failed", "blocked"):
            return {"status": "unchanged", "sourceSha": sha, "candidateStatus": existing["status"]}
        if self.policy and self.breaker.is_open() and not retry_failed:
            return {"status": "paused", "sourceSha": sha, "reason": "circuit breaker is open after repeated failures",
                    "resumesAt": dt.datetime.fromtimestamp(self.breaker.open_until(), dt.timezone.utc).isoformat()}

        # The review gate runs first and is cheap: a merge that lacks evidence is "blocked", re-checked every tick,
        # and written to the ledger once per distinct reason.
        try:
            self._verify_reviewed_merge(sha)
        except SchedulerError as exc:
            reason = str(exc)[:2000]
            if existing and existing["status"] == "blocked" and existing["reason"] == reason:
                return {"status": "blocked", "sourceSha": sha, "reason": reason}
            with self._db() as db:
                db.execute("INSERT INTO promotions(sha,status,started_at) VALUES(?, 'running', ?) ON CONFLICT(sha) DO UPDATE SET status='running',started_at=excluded.started_at,finished_at=NULL,reason=NULL", (sha, now()))
            record = self._new_record(sha, str(uuid.uuid4()))
            record.update({"status": "failed", "reason": reason, "finishedAt": now()})
            path, value = self._write_record(record)
            self._record_status(sha, "blocked", path, value, reason)
            raise

        with self._db() as db:
            db.execute("INSERT INTO promotions(sha,status,started_at) VALUES(?, 'running', ?) ON CONFLICT(sha) DO UPDATE SET status='running',started_at=excluded.started_at,finished_at=NULL,reason=NULL,stage=NULL", (sha, now()))

        promotion_id = str(uuid.uuid4())
        paths: list[str] = []
        checks: list[dict[str, Any]] = []
        activation: dict[str, Any] | None = None
        record = self._new_record(sha, promotion_id)
        worktree = self.worktrees / f"{sha}-{promotion_id}"
        previous_dev = None
        failure_kind = None
        try:
            paths = self._changed_paths(sha)
            record["changedPaths"] = paths
            selected = self._selected_checks(paths)
            subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--detach", str(worktree), sha], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=True)
            failure_kind = "validation"
            for check in selected:
                result = self._run_check(check, worktree, sha)
                checks.append(result)
                if result["status"] not in ("passed", "preexisting-debt") and result["required"]:
                    raise SchedulerError(f"required check {result['id']} failed with exit code {result['exitCode']}")
            record["candidateState"] = "validated"
            failure_kind = "activation"
            staged = self.controller.stage_sha(sha)
            record["candidateState"] = "staged"
            record["artifactDigest"] = staged["artifactDigest"]
            record["manifestDigest"] = staged["manifestDigest"]
            previous_dev = self._active_sha()
            activation = self.coordinator.activate(sha)
            record["activation"] = {"status": activation["status"], "activationId": activation.get("activationId"), "targetCount": activation.get("targetCount", 0)}
            record["candidateState"] = "active"
            failure_kind = "canary"
            canaries = self._run_canaries(paths)
            if canaries:
                record["canaries"] = canaries
            bad = next((c for c in canaries if c["status"] != "passed"), None)
            if bad:
                reason = f"canary {bad['id']} failed: {bad.get('reason', 'no detail')}"
                record["rollback"] = self._rollback_dev(previous_dev, sha, reason)
                record["candidateState"] = "rolled-back"
                raise SchedulerError(f"{reason}; {record['rollback']}")
            record["status"] = "healthy"
            record["reason"] = None
        except Exception as exc:
            record["status"] = "failed"
            record["reason"] = str(exc)[:2000]
            if failure_kind and self.policy:
                self._failure(failure_kind, sha, record["reason"])
            raise
        finally:
            record["finishedAt"] = now()
            record["changedPaths"] = paths
            record["checks"] = checks
            if activation is not None:
                record["activation"] = {"status": activation.get("status"), "activationId": activation.get("activationId"), "targetCount": activation.get("targetCount", 0)}
            path, value = self._write_record(record)
            self._record_status(sha, record["status"], path, value, record.get("reason"))
            if record["status"] == "healthy":
                self._set_stage(sha, "canary-passed" if self.policy else self.FINAL_STAGE)
            if worktree.exists():
                subprocess.run(["git", "-C", str(self.repo), "worktree", "remove", "--force", str(worktree)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False)
        outcome = {"status": "healthy", "sourceSha": sha, "recordPath": str(path), "recordDigest": value, "activation": record["activation"]}
        if self.policy:
            outcome["promotion"] = self._advance(sha)
        return outcome

    def _new_record(self, sha: str, promotion_id: str) -> dict[str, Any]:
        return {
            "schemaVersion": "factory-local-promotion-record/v1", "promotionId": promotion_id,
            "sourceSha": sha, "branch": self.branch, "status": "failed", "startedAt": now(), "changedPaths": [], "checks": [],
            "candidateState": "unvalidated", "activation": None,
        }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=("run", "status", "approve", "drift", "reset-breaker"))
    p.add_argument("--sha", default=None)
    p.add_argument("--repo", default=os.environ.get("FACTORY_CONTROLLER_REPO", "~/cezar-factory"))
    p.add_argument("--store", default=os.environ.get("FACTORY_PROMOTION_STORE", "~/.local/share/cezar-factory"), help="scheduler state root; the release store lives in <store>/release-store")
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
        config = pathlib.Path(args.config).expanduser() if args.config else repo / "config" / "promotion-policy.json"
        registry = pathlib.Path(args.registry).expanduser() if args.registry else repo / "config" / "factory-projects.json"
        scheduler = LocalPromotionScheduler(repo, pathlib.Path(args.store).expanduser(), config, remote=args.remote, branch=args.branch, registry=registry, timeout_seconds=args.timeout_seconds)
        if args.command == "status":
            result = scheduler.status(args.sha)
        elif args.command == "approve":
            result = scheduler.approve(args.sha or "")
        elif args.command == "drift":
            result = scheduler.drift()
        elif args.command == "reset-breaker":
            scheduler.breaker.reset()
            result = {"status": "breaker-reset"}
        else:
            result = scheduler.run_once(retry_failed=args.retry_failed)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (SchedulerError, PolicyError, ActivationError, ControllerError, OSError, sqlite3.Error, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:2000]}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
