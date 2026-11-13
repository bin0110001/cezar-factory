import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

from scripts.release.factory_local_scheduler import LocalPromotionScheduler, SchedulerError


def git(path: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


class LocalPromotionSchedulerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-local-promotion-test-")
        root = pathlib.Path(self.tmp.name)
        self.repo = root / "repo"
        self.origin = root / "origin.git"
        self.store = root / "store"
        self.config = root / "scheduler.json"
        self.repo.mkdir()
        subprocess.run(["git", "init", "--bare", str(self.origin)], check=True, capture_output=True)
        subprocess.run(["git", "init", "-b", "main", str(self.repo)], check=True, capture_output=True)
        git(self.repo, "config", "user.name", "Factory Test")
        git(self.repo, "config", "user.email", "factory-test@example.invalid")
        (self.repo / "tracked.txt").write_text("baseline\n", encoding="utf-8")
        git(self.repo, "add", "tracked.txt")
        git(self.repo, "commit", "-m", "baseline")
        self.base_sha = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "tracked.txt").write_text("candidate\n", encoding="utf-8")
        git(self.repo, "add", "tracked.txt")
        git(self.repo, "commit", "-m", "candidate")
        git(self.repo, "remote", "add", "origin", str(self.origin))
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", "HEAD:refs/heads/dev"], check=True, capture_output=True)
        self.sha = git(self.repo, "rev-parse", "HEAD")
        self._config([{"id": "release-wide", "when": ["**"], "command": [sys.executable, "-c", "import os; assert os.environ['FACTORY_CANDIDATE_SHA'] == '" + self.sha + "'"], "required": True, "timeoutSeconds": 60}])
        self.scheduler = LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev")
        self.scheduler._verify_reviewed_merge = lambda _sha: None
        self.activations: list[str] = []
        self.scheduler.coordinator.activate = lambda sha: self._activate(sha)

    def _config(self, checks: list[dict]) -> None:
        self.config.write_text(json.dumps({"schemaVersion": "factory-local-promotion/v1", "githubRepository": "example/factory", "maxParallel": 1, "gpuSlots": 0, "checks": checks}), encoding="utf-8")

    def _activate(self, sha: str) -> dict:
        self.activations.append(sha)
        return {"status": "healthy", "activationId": "fixture-activation", "targetCount": 1}

    def tearDown(self) -> None:
        for item in sorted(pathlib.Path(self.tmp.name).rglob("*"), key=lambda p: len(p.parts), reverse=True):
            try:
                os.chmod(item, 0o700 if item.is_dir() else 0o600)
            except OSError:
                pass
        self.tmp.cleanup()

    def test_success_validates_exact_sha_stages_and_activates_once(self) -> None:
        result = self.scheduler.run_once()
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["sourceSha"], self.sha)
        self.assertEqual(self.activations, [self.sha])
        record_path = pathlib.Path(result["recordPath"])
        record = json.loads(record_path.read_text(encoding="utf-8"))
        self.assertEqual(record["sourceSha"], self.sha)
        self.assertEqual(record["candidateState"], "active")
        self.assertEqual(record["checks"][0]["status"], "passed")
        self.assertEqual(record["activation"]["status"], "healthy")
        unsigned = dict(record)
        claimed = unsigned.pop("recordDigest")
        self.assertEqual(claimed, "sha256:" + hashlib.sha256(json.dumps(unsigned, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest())
        self.assertFalse(list((self.store / "worktrees").iterdir()))
        self.assertEqual(self.scheduler.run_once()["status"], "unchanged")
        self.assertEqual(len(self.activations), 1)

    def test_failed_required_check_never_stages_or_activates_and_is_cached(self) -> None:
        self._config([{"id": "must-fail", "when": ["**"], "command": [sys.executable, "-c", "raise SystemExit(7)"], "required": True, "timeoutSeconds": 60}])
        self.scheduler = LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev")
        self.scheduler._verify_reviewed_merge = lambda _sha: None
        self.activations = []
        self.scheduler.coordinator.activate = lambda sha: self._activate(sha)
        with self.assertRaisesRegex(SchedulerError, "required check must-fail failed"):
            self.scheduler.run_once()
        with self.scheduler._db() as db:
            row = db.execute("SELECT status,record_path FROM promotions WHERE sha=?", (self.sha,)).fetchone()
        self.assertEqual(row["status"], "failed")
        record = json.loads(pathlib.Path(row["record_path"]).read_text(encoding="utf-8"))
        self.assertEqual(record["candidateState"], "unvalidated")
        self.assertEqual(record["checks"][0]["exitCode"], 7)
        self.assertEqual(self.activations, [])
        self.assertEqual(self.scheduler.run_once()["status"], "unchanged")
        self.assertEqual(self.activations, [])

    def test_failed_check_records_the_failing_lines_and_the_tail_of_a_long_log(self) -> None:
        script = ("import sys\n"
                  "print('  ok   fine')\n"
                  "print('x' * 200000)\n"  # pushes the failure past the preview limit
                  "print('  FAIL release supports remote-only target registry entries')\n"
                  "print('FAILED: 1 assertion(s)')\n"
                  "sys.exit(1)\n")
        self._config([{"id": "suite", "when": ["**"], "command": [sys.executable, "-c", script], "required": True, "timeoutSeconds": 60}])
        self.scheduler = LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev")
        self.scheduler._verify_reviewed_merge = lambda _sha: None
        self.scheduler.coordinator.activate = lambda sha: self._activate(sha)
        with self.assertRaisesRegex(SchedulerError, "required check suite failed with exit code 1: .*FAIL release supports remote-only"):
            self.scheduler.run_once()
        with self.scheduler._db() as db:
            row = db.execute("SELECT record_path FROM promotions WHERE sha=?", (self.sha,)).fetchone()
        check = json.loads(pathlib.Path(row["record_path"]).read_text(encoding="utf-8"))["checks"][0]
        self.assertIn("FAIL release supports remote-only target registry entries", check["failureLines"])
        self.assertTrue(check["outputTruncated"])
        self.assertIn("FAILED: 1 assertion(s)", check["outputPreview"])  # the tail survives the cut

    def _promotion(self, sha: str, status: str, finished: str, reason: str | None = None) -> None:
        with self.scheduler._db() as db:
            db.execute("INSERT OR REPLACE INTO promotions (sha,status,started_at,finished_at,reason) VALUES (?,?,?,?,?)", (sha, status, finished, finished, reason))

    def test_health_reports_ok_degraded_and_stalled_from_the_promotion_history(self) -> None:
        self.assertEqual("ok", self.scheduler.health()["state"])  # nothing recorded, nothing failing
        def ago(hours: int) -> str:
            moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
            return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        recent, later = ago(2), ago(1)
        self._promotion("a" * 40, "healthy", recent)
        health = self.scheduler.health()
        self.assertEqual(("ok", 0, "a" * 40), (health["state"], health["failedSinceHealthy"], health["lastHealthySha"]))
        self._promotion("b" * 40, "failed", later, "required check full-suite failed with exit code 1: FAIL x")
        health = self.scheduler.health()
        self.assertEqual(("degraded", 1), (health["state"], health["failedSinceHealthy"]))
        self.assertIn("FAIL x", health["lastFailure"]["reason"])
        self._promotion("c" * 40, "failed", later)
        self._promotion("d" * 40, "failed", later)
        self.assertEqual(("stalled", 3), (self.scheduler.health()["state"], self.scheduler.health()["failedSinceHealthy"]))

    def test_health_is_stalled_when_nothing_has_ever_been_healthy_and_candidates_fail(self) -> None:
        self._promotion("e" * 40, "failed", "2026-11-09T00:00:00.000Z", "boom")
        health = self.scheduler.health()
        self.assertEqual(("stalled", None), (health["state"], health["lastHealthySha"]))

    def test_health_is_not_ok_while_a_candidate_waits_blocked_or_drift_persists(self) -> None:
        def ago(hours: float) -> str:
            moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
            return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self._promotion("a" * 40, "healthy", ago(20))
        self._promotion("b" * 40, "blocked", ago(0.2), "no merged dev PR satisfying the approval gate")
        self.assertEqual(("ok", []), (self.scheduler.health()["state"], self.scheduler.health()["reasons"]))  # a short wait is normal
        self._promotion("b" * 40, "blocked", ago(2), "no merged dev PR satisfying the approval gate")
        health = self.scheduler.health()
        self.assertEqual(("degraded", 2.0), (health["state"], health["blockedHours"]))
        self.assertIn("approval gate", health["reasons"][0])
        self._promotion("b" * 40, "blocked", ago(13), "no merged dev PR satisfying the approval gate")
        self.assertEqual("stalled", self.scheduler.health()["state"])
        # A later healthy promotion supersedes an old blocked candidate.
        self._promotion("c" * 40, "healthy", ago(1))
        self.assertEqual(("ok", None), (self.scheduler.health()["state"], self.scheduler.health()["blockedHours"]))
        # Drift that outlives its grace period means the host is not on the promoted release.
        self.scheduler._state_put("drift_since", str(time.time() - 600))
        self.assertEqual("ok", self.scheduler.health()["state"])
        self.scheduler._state_put("drift_since", str(time.time() - 2 * 3600))
        health = self.scheduler.health()
        self.assertEqual("degraded", health["state"])
        self.assertIn("release drift", health["reasons"][0])
        self.scheduler._state_put("drift_since", str(time.time() - 8 * 3600))
        self.assertEqual("stalled", self.scheduler.health()["state"])
        self.scheduler._state_put("drift_since", "0")
        self.assertEqual("ok", self.scheduler.health()["state"])

    def _drift_fixture(self, dev: str, stable: str) -> None:
        git(self.repo, "push", "origin", f"{stable}:refs/heads/stable", "--force")
        channels = self.scheduler.controller.channels
        channels.mkdir(parents=True, exist_ok=True)
        for name, sha in (("dev", dev), ("stable", stable)):
            (channels / f"{name}.json").write_text(json.dumps({"currentSha": sha}), encoding="utf-8")
        self.scheduler.policy = None  # the Cezar probe is covered separately

    def test_drift_accepts_stable_ahead_of_dev_when_stable_passed_dev_canaries(self) -> None:
        self._drift_fixture(self.base_sha, self.sha)  # dev rolled back to the older SHA
        self.assertIn("stable is ahead of dev", " ".join(self.scheduler.drift()["findings"]))
        self._promotion(self.sha, "healthy", "2026-11-13T00:00:00.000Z")
        self.assertNotIn("stable is ahead of dev", " ".join(self.scheduler.drift()["findings"]))

    def test_unreadable_cezar_probe_is_unknown_not_drift_until_it_persists(self) -> None:
        self._drift_fixture(self.sha, self.sha)
        self.scheduler.policy = {"stableBranch": "stable", "driftGraceSeconds": 1800, "issueLabels": [], "mode": "autonomous"}
        windows: list[int] = []
        class Runner:
            def _retry(self, method, suffix, body=None, *, window=None):
                windows.append(window)
                raise TimeoutError("timed out")
        self.scheduler._canary_runner = lambda: Runner()
        filed: list[str] = []
        import scripts.release.factory_local_scheduler as module
        original = module.file_issue
        module.file_issue = lambda *args, **kwargs: filed.append(args[2])
        try:
            report = self.scheduler._drift_watch()
            self.assertEqual("unknown", report["status"])
            self.assertGreater(windows[0], 0)  # a bounded retry window, not zero
            self.scheduler._state_put("probe_unknown_since", str(time.time() - 1800))
            self.assertEqual("unknown", self.scheduler._drift_watch()["status"])
            self.assertEqual([], filed)
            self.scheduler._state_put("probe_unknown_since", str(time.time() - 3 * 3600))
            self.scheduler._drift_watch()
            self.scheduler._state_put("drift_since", str(time.time() - 3600))
            self.scheduler._drift_watch()
            self.assertEqual(["[promotion] release drift persists"], filed)
        finally:
            module.file_issue = original

    def test_genuine_cezar_mismatch_is_still_drift(self) -> None:
        self._drift_fixture(self.sha, self.sha)
        self.scheduler.policy = {"stableBranch": "stable", "driftGraceSeconds": 1800, "issueLabels": [], "mode": "autonomous"}
        class Runner:
            def _retry(self, method, suffix, body=None, *, window=None):
                return {"channel": "dev", "sourceSha": "f" * 40}
        self.scheduler._canary_runner = lambda: Runner()
        report = self.scheduler.drift()
        self.assertEqual("drift", report["status"])
        self.assertIn("Cezar serves", report["findings"][0])

    def test_passing_check_has_no_failure_lines(self) -> None:
        result = self.scheduler.run_once()
        record = json.loads(pathlib.Path(result["recordPath"]).read_text(encoding="utf-8"))
        self.assertEqual([], record["checks"][0]["failureLines"])

    def test_scheduler_rejects_parallel_configuration(self) -> None:
        self._config([{"id": "one", "when": ["**"], "command": [sys.executable, "-c", "pass"]}])
        config = json.loads(self.config.read_text(encoding="utf-8"))
        config["maxParallel"] = 2
        self.config.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(SchedulerError, "maxParallel must be exactly 1"):
            LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev")

    def test_unchanged_failure_fingerprints_are_recorded_as_nonblocking_debt(self) -> None:
        failing_command = [sys.executable, "-c", "print('FAIL: legacy issue'); raise SystemExit(1)"]
        check = {
            "id": "project-validation", "when": ["tracked.txt"], "command": failing_command,
            "baselineCommand": failing_command, "failureFingerprintPattern": "FAIL: ([^\\n]+)",
            "allowExistingFailures": True, "required": True, "timeoutSeconds": 60,
        }
        self._config([check])
        self.scheduler = LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev")
        self.scheduler._verify_reviewed_merge = lambda _sha: None
        pointer = self.scheduler.controller.channels / "dev.json"
        pointer.parent.mkdir(parents=True, exist_ok=True)
        pointer.write_text(json.dumps({"schemaVersion": "factory-release-channel-pointer/v1", "channel": "dev", "currentSha": self.base_sha}), encoding="utf-8")
        self.activations = []
        self.scheduler.coordinator.activate = lambda sha: self._activate(sha)

        result = self.scheduler.run_once()
        record = json.loads(pathlib.Path(result["recordPath"]).read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(record["checks"][0]["status"], "preexisting-debt")
        self.assertEqual(record["checks"][0]["nonblockingExistingFailures"], 1)
        self.assertEqual(self.activations, [self.sha])

    def test_new_failure_fingerprint_blocks_candidate_over_baseline_debt(self) -> None:
        check = {
            "id": "project-validation", "when": ["tracked.txt"],
            "command": [sys.executable, "-c", "print('FAIL: legacy issue'); print('FAIL: new regression'); raise SystemExit(1)"],
            "baselineCommand": [sys.executable, "-c", "print('FAIL: legacy issue'); raise SystemExit(1)"],
            "failureFingerprintPattern": "FAIL: ([^\\n]+)", "allowExistingFailures": True,
            "required": True, "timeoutSeconds": 60,
        }
        self._config([check])
        self.scheduler = LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev")
        self.scheduler._verify_reviewed_merge = lambda _sha: None
        pointer = self.scheduler.controller.channels / "dev.json"
        pointer.parent.mkdir(parents=True, exist_ok=True)
        pointer.write_text(json.dumps({"schemaVersion": "factory-release-channel-pointer/v1", "channel": "dev", "currentSha": self.base_sha}), encoding="utf-8")
        self.activations = []
        self.scheduler.coordinator.activate = lambda sha: self._activate(sha)

        with self.assertRaisesRegex(SchedulerError, "required check project-validation failed"):
            self.scheduler.run_once()
        with self.scheduler._db() as db:
            row = db.execute("SELECT record_path FROM promotions WHERE sha=?", (self.sha,)).fetchone()
        record = json.loads(pathlib.Path(row["record_path"]).read_text(encoding="utf-8"))
        self.assertEqual(record["checks"][0]["status"], "failed")
        self.assertIn("new regression", record["checks"][0]["candidateFailureFingerprints"][-1])
        self.assertEqual(self.activations, [])

    def test_review_gate_failure_is_recorded_and_never_activates(self) -> None:
        self.scheduler._verify_reviewed_merge = lambda _sha: (_ for _ in ()).throw(SchedulerError("review was not approved"))
        self.activations = []
        with self.assertRaisesRegex(SchedulerError, "review was not approved"):
            self.scheduler.run_once()
        with self.scheduler._db() as db:
            row = db.execute("SELECT record_path FROM promotions WHERE sha=?", (self.sha,)).fetchone()
        record = json.loads(pathlib.Path(row["record_path"]).read_text(encoding="utf-8"))
        self.assertEqual(record["candidateState"], "unvalidated")
        self.assertIn("review was not approved", record["reason"])
        self.assertEqual(self.activations, [])


if __name__ == "__main__":
    unittest.main()
