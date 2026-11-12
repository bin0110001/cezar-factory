#!/usr/bin/env python3
"""Promotion policy and the small, testable pieces the local promoter composes.

One engine serves two postures. ``autonomous`` promotes on validation evidence plus a
recorded self-review and only interrupts a human when it cannot recover. ``controlled``
adds an independent approval, a soak period, and an explicit human approval before
``stable`` moves. The posture is data in ``config/local-release-scheduler.json``; no code
path forks on it outside of ``normalize_policy`` and ``review_decision``.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

MODES = ("autonomous", "controlled")
REVIEW_KINDS = ("self-review", "approval")
STABLE_KINDS = ("auto", "approval")
DEFAULT_SELF_REVIEW = r"(?im)^\s{0,3}#{1,6}\s*self[- ]review\b"
DEFAULT_CANARY_TRANSIENT = r"rate limit|HTTP 50[234]|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|unexpected end of JSON|connection reset|ECONNRESET|temporarily unavailable|Cezar API unavailable"
TERMINAL_RUN = {"done": "passed", "failed": "failed", "cancelled": "failed"}
WAITING_RUN = {"queued", "pending", "waiting"}


class PolicyError(RuntimeError):
    pass


def _argv(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(i, str) and i for i in value):
        raise PolicyError(f"{name} must be a non-empty argv array")
    return list(value)


def _int(value: Any, name: str, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise PolicyError(f"{name} must be an integer between {low} and {high}")
    return value


def normalize_policy(raw: Any) -> dict[str, Any] | None:
    """Validate the optional ``promotion`` section. ``None`` keeps the validate-and-activate-dev behaviour."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise PolicyError("promotion must be an object")
    mode = raw.get("mode", "autonomous")
    if mode not in MODES:
        raise PolicyError(f"promotion.mode must be one of {', '.join(MODES)}")
    modes = raw.get("modes", {})
    if not isinstance(modes, dict):
        raise PolicyError("promotion.modes must be an object")
    defaults = {
        "autonomous": {"review": "self-review", "stable": "auto", "soakSeconds": 0},
        "controlled": {"review": "approval", "stable": "approval", "soakSeconds": 3600},
    }
    posture = {**defaults[mode], **(modes.get(mode) or {})}
    if posture["review"] not in REVIEW_KINDS:
        raise PolicyError(f"promotion.modes.{mode}.review must be one of {', '.join(REVIEW_KINDS)}")
    if posture["stable"] not in STABLE_KINDS:
        raise PolicyError(f"promotion.modes.{mode}.stable must be one of {', '.join(STABLE_KINDS)}")
    soak = _int(posture["soakSeconds"], "soakSeconds", 0, 7 * 24 * 3600, 0)
    pattern = raw.get("selfReviewPattern", DEFAULT_SELF_REVIEW)
    try:
        review_re = re.compile(pattern)
    except (re.error, TypeError) as exc:
        raise PolicyError(f"promotion.selfReviewPattern is invalid: {exc}") from exc

    canaries = raw.get("canaries", {}) or {}
    items = []
    seen: set[str] = set()
    for item in canaries.get("items", []):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise PolicyError("every canary requires an id")
        if item["id"] in seen:
            raise PolicyError(f"duplicate canary id: {item['id']}")
        seen.add(item["id"])
        if not isinstance(item.get("automation"), str) or not item["automation"]:
            raise PolicyError(f"canary {item['id']} requires an automation name or id")
        when = item.get("when", ["**"])
        if not isinstance(when, list) or not when or not all(isinstance(p, str) and p for p in when):
            raise PolicyError(f"canary {item['id']} when must be a non-empty pattern list")
        items.append({
            "id": item["id"], "automation": item["automation"], "when": when,
            "timeoutSeconds": _int(item.get("timeoutSeconds"), "canary timeoutSeconds", 30, 4 * 3600, 1800),
            "queueTimeoutSeconds": _int(item.get("queueTimeoutSeconds"), "canary queueTimeoutSeconds", 60, 24 * 3600, 7200),
        })

    stable = raw.get("stable", {}) or {}
    breaker = raw.get("breaker", {}) or {}
    issues = raw.get("issues", {}) or {}
    drift = raw.get("drift", {}) or {}
    blocked = raw.get("blocked", {}) or {}
    deploy = stable.get("deployCommand")
    try:
        transient_re = re.compile(canaries.get("transientPattern", DEFAULT_CANARY_TRANSIENT), re.IGNORECASE)
    except (re.error, TypeError) as exc:
        raise PolicyError(f"promotion.canaries.transientPattern is invalid: {exc}") from exc
    return {
        "mode": mode,
        "review": posture["review"],
        "stable": posture["stable"],
        "soakSeconds": soak,
        "selfReviewPattern": review_re,
        "gh": _argv(raw.get("ghCommand", ["gh"]), "promotion.ghCommand"),
        "canaryProject": canaries.get("projectId", "cezar-factory"),
        "canaryReadySeconds": _int(canaries.get("readySeconds"), "canaries.readySeconds", 0, 3600, 180),
        "canaries": items,
        "canaryTransientPattern": transient_re,
        "blockedEscalationSeconds": _int(blocked.get("escalateSeconds"), "blocked.escalateSeconds", 60, 7 * 24 * 3600, 3600),
        "stableBranch": stable.get("branch", "stable"),
        "deployCommand": _argv(deploy, "stable.deployCommand") if deploy is not None else None,
        "deployIdleWaitSeconds": _int(stable.get("deployIdleWaitSeconds"), "stable.deployIdleWaitSeconds", 0, 3600, 600),
        "breakerMax": _int(breaker.get("maxConsecutiveFailures"), "breaker.maxConsecutiveFailures", 1, 100, 3),
        "breakerPauseSeconds": _int(breaker.get("pauseSeconds"), "breaker.pauseSeconds", 60, 7 * 24 * 3600, 3600),
        "issueLabels": list(issues.get("labels", ["factory:new"])),
        "escalationLabels": list(issues.get("escalationLabels", ["factory:needs-help"])),
        "driftGraceSeconds": _int(drift.get("graceSeconds"), "drift.graceSeconds", 0, 7 * 24 * 3600, 1800),
    }


def glob_match(pattern: str, path: str) -> bool:
    return fnmatch.fnmatchcase(path, pattern) or (pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:]))


def select_canaries(policy: dict[str, Any], paths: list[str]) -> list[dict[str, Any]]:
    return [c for c in policy["canaries"] if any(glob_match(p, path) for p in c["when"] for path in paths)]


def review_decision(policy: dict[str, Any], pr: dict[str, Any], sha: str, branch: str) -> tuple[bool, str]:
    """Pure review gate. ``approval`` needs an independent approval; ``self-review`` also accepts a recorded self-review."""
    merge = pr.get("mergeCommit") or {}
    if pr.get("state") != "MERGED" or pr.get("baseRefName") != branch or merge.get("oid") != sha:
        return False, "not the merged pull request for this commit"
    if pr.get("reviewDecision") == "APPROVED":
        return True, "approved review"
    if policy["review"] == "self-review" and policy["selfReviewPattern"].search(pr.get("body") or ""):
        return True, "recorded self-review"
    needed = "an approved review" if policy["review"] == "approval" else "an approved review or a recorded self-review"
    return False, f"pull request has {needed} missing"


def fingerprint(kind: str, subject: str, reason: str) -> str:
    """Stable id for 'the same failure again': volatile SHAs, ids, durations and timestamps are removed first."""
    text = re.sub(r"\b[0-9a-f]{7,64}\b", "#", reason.lower())
    text = re.sub(r"\d+", "#", text)
    text = re.sub(r"\s+", " ", text).strip()[:300]
    return hashlib.sha256(f"{kind}|{subject}|{text}".encode()).hexdigest()[:12]


class GhRunner:
    """Runs ``gh`` wherever it is authenticated (the Cezar container on the host)."""

    def __init__(self, command: list[str], runner: Callable[..., Any] = subprocess.run, timeout: int = 60):
        self.command, self.runner, self.timeout = command, runner, timeout

    def __call__(self, *args: str) -> subprocess.CompletedProcess:
        return self.runner([*self.command, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=self.timeout, check=False)

    def json(self, *args: str) -> Any:
        result = self(*args)
        if result.returncode:
            raise PolicyError(f"gh {' '.join(args[:2])} failed: {result.stderr.decode('utf-8', 'replace')[-500:]}")
        return json.loads(result.stdout.decode("utf-8") or "null")


class Breaker:
    """Consecutive-failure circuit breaker persisted in the scheduler's sqlite state."""

    def __init__(self, get: Callable[[str, str], str], put: Callable[[str, str], None], limit: int, pause_seconds: int,
                 clock: Callable[[], float] = time.time):
        self.get, self.put, self.limit, self.pause, self.clock = get, put, limit, pause_seconds, clock

    def open_until(self) -> float:
        return float(self.get("breaker_open_until", "0") or 0)

    def is_open(self) -> bool:
        return self.clock() < self.open_until()

    def failures(self) -> int:
        return int(self.get("consecutive_failures", "0") or 0)

    def record_failure(self) -> bool:
        """Count a failed candidate; returns True when this failure opens the breaker."""
        count = self.failures() + 1
        self.put("consecutive_failures", str(count))
        if count >= self.limit:
            self.put("breaker_open_until", str(self.clock() + self.pause))
            self.put("consecutive_failures", "0")
            return True
        return False

    def record_success(self) -> None:
        self.put("consecutive_failures", "0")
        self.put("breaker_open_until", "0")

    def reset(self) -> None:
        self.record_success()


class CanaryRunner:
    """Queues Cezar automations against the freshly activated release and waits for a verdict."""

    def __init__(self, api_url: str, project: str, *, request: Callable[[str, str, Any], Any] | None = None,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 ready_seconds: int = 180, poll_seconds: int = 15):
        self.base = f"{api_url.rstrip('/')}/api/v1/p/{urllib.parse.quote(project, safe='')}"
        self.request = request or self._http
        self.sleep, self.clock = sleep, clock
        self.ready_seconds, self.poll_seconds = ready_seconds, poll_seconds

    @staticmethod
    def _http(method: str, url: str, body: Any) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method, headers={"Accept": "application/json", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read(4 * 1024 * 1024)
        return json.loads(payload.decode("utf-8")) if payload else None

    def _retry(self, method: str, suffix: str, body: Any = None, *, window: int | None = None) -> Any:
        """Retry transient failures (a restarting Cezar, a held lease) inside a readiness window."""
        deadline = self.clock() + (self.ready_seconds if window is None else window)
        while True:
            try:
                return self.request(method, f"{self.base}{suffix}", body)
            except urllib.error.HTTPError as exc:
                transient = exc.code in (409, 502, 503, 504)
                error: Exception = exc
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                transient, error = True, exc
            if not transient or self.clock() >= deadline:
                raise error
            self.sleep(min(self.poll_seconds, 5))

    def run(self, canary: dict[str, Any]) -> dict[str, Any]:
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        result: dict[str, Any] = {"id": canary["id"], "automation": canary["automation"], "startedAt": started, "status": "failed"}
        try:
            listing = self._retry("GET", "/automations")
            items = listing.get("automations", listing) if isinstance(listing, dict) else listing
            wanted = canary["automation"]
            match = next((a for a in items if a.get("id") == wanted or a.get("name") in (wanted, f"[factory] {wanted}")), None)
            if match is None:
                result["reason"] = f"automation '{wanted}' not found"
                return result
            if match.get("kind") != "schedule":
                result["reason"] = "canaries must be schedule automations they can run directly"
                return result
            queued = self._retry("POST", f"/automations/{match['id']}/run")
            run_id = (queued or {}).get("runId")
            if not run_id:
                result["reason"] = "Cezar did not return a run id"
                return result
            result["runId"] = run_id
            # Cezar runs one job at a time, so a canary can wait behind real work. Judge it on how long it RUNS;
            # the time spent queued has its own, larger allowance.
            queue_deadline = self.clock() + canary["queueTimeoutSeconds"]
            deadline = None
            while True:
                run = self._retry("GET", f"/runs/{urllib.parse.quote(run_id, safe='')}")
                state = TERMINAL_RUN.get(run.get("status"))
                if state:
                    result["status"], result["runStatus"] = state, run.get("status")
                    if state == "failed":
                        failed = [s for s in run.get("steps", []) if s.get("status") == "failed"]
                        result["reason"] = "; ".join(f"step {s.get('id')}: {s.get('error', 'failed')}" for s in failed)[:500] or f"run {run.get('status')}"
                    return result
                if run.get("status") in WAITING_RUN:
                    if self.clock() >= queue_deadline:
                        result["reason"] = f"still {run.get('status')} after {canary['queueTimeoutSeconds']}s; Cezar never started it"
                        return result
                else:
                    if deadline is None:
                        deadline = self.clock() + canary["timeoutSeconds"]
                    if self.clock() >= deadline:
                        result["reason"] = f"timed out after {canary['timeoutSeconds']}s running (status {run.get('status')})"
                        return result
                self.sleep(self.poll_seconds)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError, KeyError) as exc:
            result["reason"] = f"Cezar API unavailable: {exc}"[:500]
            return result
        finally:
            result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def promote_stable_ref(gh: GhRunner, repo: str, branch: str, sha: str) -> None:
    """Fast-forward ``branch`` to ``sha`` through the GitHub refs API (force=false enforces ancestry)."""
    result = gh("api", "-X", "PATCH", f"repos/{repo}/git/refs/heads/{branch}", "-f", f"sha={sha}", "-F", "force=false")
    if result.returncode:
        raise PolicyError(f"could not fast-forward {branch} to {sha[:9]}: {result.stderr.decode('utf-8', 'replace')[-500:]}")


def file_issue(gh: GhRunner, repo: str, title: str, body: str, labels: list[str], fp: str) -> str:
    """Open one issue per failure fingerprint; a repeat adds a comment instead of a duplicate."""
    marker = f"promotion-fingerprint:{fp}"
    existing = gh.json("issue", "list", "--repo", repo, "--state", "open", "--search", f'"{marker}" in:body', "--json", "number", "--limit", "1")
    full_body = f"{body}\n\n<!-- {marker} -->"
    if existing:
        number = str(existing[0]["number"])
        gh("issue", "comment", number, "--repo", repo, "--body", body)
        return f"commented #{number}"
    args = ["issue", "create", "--repo", repo, "--title", title, "--body", full_body]
    for label in labels:
        args += ["--label", label]
    result = gh(*args)
    if result.returncode:
        raise PolicyError(f"could not open issue: {result.stderr.decode('utf-8', 'replace')[-500:]}")
    return result.stdout.decode("utf-8", "replace").strip()
