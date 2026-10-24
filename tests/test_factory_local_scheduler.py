import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
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
