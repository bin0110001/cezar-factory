import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

from scripts.release.factory_drift_repair import DriftRepair
from scripts.release.factory_release_controller import ReleaseController, utc_now


class FakeCoordinator:
    def __init__(self, controller, registry, live):
        self.controller = controller
        self.registry = registry
        self.live = live
        self.reconcile_count = 0
        self.fail_reconcile = False
        self.diagnostic_sha = None
        self.diagnostic_error = None

    def load_targets(self):
        return self.registry

    def _diagnostic(self, target):
        if self.diagnostic_error:
            from scripts.release.factory_activation import ActivationError
            raise ActivationError(self.diagnostic_error)
        pointer = json.loads((self.controller.channels / "stable.json").read_text(encoding="utf-8"))
        return {"status": "resolved", "channel": "stable", "sourceSha": self.diagnostic_sha or pointer["currentSha"]}

    def _desired_automations(self, root, target):
        return {"[factory] sample": {"name": "[factory] sample", "task": {"workflow": "quick-task", "prompt": "desired"}}}

    def _list_automations(self, target):
        return [{"id": "automation-1", "name": name} for name in self.live]

    def _get_automation(self, target, automation_id):
        return dict(self.live["[factory] sample"])

    @staticmethod
    def _deep_subset(wanted, current):
        return wanted == current

    def _load_quarantine(self, sha):
        path = self.controller.store / "quarantine" / f"{sha}.json"
        return path if path.exists() else None

    def _reconcile(self, root, target):
        self.reconcile_count += 1
        if self.fail_reconcile:
            raise RuntimeError("fixture repair failure")
        self.live["[factory] sample"] = self._desired_automations(root, target)["[factory] sample"]


class FactoryDriftRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-drift-repair-")
        root = pathlib.Path(self.tmp.name)
        self.repo = root / "repo"
        self.origin = root / "origin.git"
        self.store = root / "store"
        subprocess.run(["git", "init", "--bare", str(self.origin)], check=True, capture_output=True)
        self.repo.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(self.repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "Factory Test"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "factory-test@example.invalid"], check=True)
        (self.repo / "VERSION").write_text("0.0.1\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "add", "VERSION"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-m", "fixture"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "remote", "add", "origin", str(self.origin)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", "HEAD:refs/heads/stable"], check=True, capture_output=True)
        self.controller = ReleaseController(self.repo, self.store, "origin", "stable", 3, 30, 1)
        self.sha = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        self.controller.sync()
        self.registry = [{"projectId": "listed-project", "apiUrl": "http://fake.invalid", "projectType": "test"}]
        self.live = {"[factory] sample": {"name": "[factory] sample", "task": {"workflow": "quick-task", "prompt": "old"}}}
        self.coordinator = FakeCoordinator(self.controller, self.registry, self.live)
        self.drift = DriftRepair(self.controller, self.coordinator)

    def tearDown(self):
        for path in sorted(pathlib.Path(self.tmp.name).rglob("*"), key=lambda item: len(item.parts), reverse=True):
            try:
                os.chmod(path, 0o700 if path.is_dir() else 0o600)
            except OSError:
                pass
        self.tmp.cleanup()

    def test_detect_reports_only_explicit_project_automation_drift(self):
        findings = self.drift.detect()["findings"]
        self.assertEqual([item["failureClass"] for item in findings], ["automation"])
        self.assertEqual(findings[0]["evidence"]["projectId"], "listed-project")
        self.assertEqual(self.coordinator.reconcile_count, 0)

    def test_repair_is_dry_run_by_default_then_rechecks_and_is_idempotent(self):
        preview = self.drift.repair()
        self.assertEqual(preview["results"][0]["status"], "dry-run")
        self.assertEqual(self.live["[factory] sample"]["task"]["prompt"], "old")
        repaired = self.drift.repair(apply=True)
        self.assertEqual(repaired["status"], "repaired")
        self.assertEqual(repaired["results"][0]["status"], "applied")
        receipt = json.loads(pathlib.Path(repaired["results"][0]["receipt"]).read_text(encoding="utf-8"))
        self.assertTrue(receipt["probePassed"])
        unchanged = self.drift.repair(apply=True)
        self.assertEqual(unchanged["status"], "unchanged")
        self.assertEqual(unchanged["results"][0]["status"], "unchanged")
        self.assertEqual(json.loads(pathlib.Path(unchanged["results"][0]["receipt"]).read_text(encoding="utf-8"))["state"], "unchanged")
        self.assertEqual(self.coordinator.reconcile_count, 1)

    def test_quarantine_guard_refuses_automation_repair(self):
        quarantine = self.store / "quarantine" / f"{self.sha}.json"
        quarantine.parent.mkdir()
        quarantine.write_text("{}", encoding="utf-8")
        result = self.drift.repair(apply=True)
        self.assertEqual(result["results"][0]["status"], "skipped")
        self.assertIn("quarantined", result["results"][0]["reason"])
        self.assertEqual(self.coordinator.reconcile_count, 0)

    def test_failed_probe_stays_open_and_ledger_backoff_skips_repeat(self):
        self.coordinator.fail_reconcile = True
        failed = self.drift.repair(apply=True)
        self.assertEqual(failed["results"][0]["status"], "failed")
        receipt = json.loads(pathlib.Path(failed["results"][0]["receipt"]).read_text(encoding="utf-8"))
        self.assertFalse(receipt["probePassed"])
        repeated = self.drift.repair(apply=True)
        self.assertEqual(repeated["results"][0]["status"], "skipped")
        self.assertEqual(repeated["results"][0]["reason"], "backoff")
        self.assertEqual(self.coordinator.reconcile_count, 1)

    def test_shadow_and_compatibility_probes_are_reported_without_mutation(self):
        self.coordinator.diagnostic_sha = "f" * 40
        self.assertIn("shadow_drift", [item["failureClass"] for item in self.drift.detect()["findings"]])
        self.coordinator.diagnostic_sha = None
        self.coordinator.diagnostic_error = "HTTP 503 incompatible-release"
        self.assertIn("compatibility", [item["failureClass"] for item in self.drift.detect()["findings"]])
        self.assertEqual(self.coordinator.reconcile_count, 0)

    def test_failed_refetch_is_retried_and_original_probe_clears(self):
        with self.controller._db() as db:
            started = utc_now()
            db.execute("INSERT INTO attempts(id,started_at,finished_at,channel,status,reason) VALUES(?,?,?,?,?,?)",
                       ("failed-fetch", started, started, "stable", "failed", "fetch failed after bounded attempts: unavailable"))
        self.assertIn("failed_refetch", [item["failureClass"] for item in self.drift.detect()["findings"]])
        result = self.drift.repair(apply=True)
        self.assertEqual(result["results"][0]["status"], "applied")
        self.assertTrue(json.loads(pathlib.Path(result["results"][0]["receipt"]).read_text(encoding="utf-8"))["probePassed"])

    def test_pointer_checkpoint_repair_does_not_change_channel_pointer(self):
        with self.controller._db() as db:
            db.execute("UPDATE channel_pointers SET current_sha=?,last_good_sha=? WHERE channel='stable'", ("0" * 40, "1" * 40))
        preview = self.drift.repair()
        self.assertEqual(preview["results"][0]["failureClass"], "release")
        self.assertEqual(self.drift.detect()["findings"][0]["key"], "pointer-checkpoint")
        repaired = self.drift.repair(apply=True)
        self.assertEqual(repaired["results"][0]["status"], "applied")
        pointer = json.loads((self.store / "channels" / "stable.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["currentSha"], self.sha)
        with self.controller._db() as db:
            self.assertEqual(db.execute("SELECT last_good_sha FROM channel_pointers WHERE channel='stable'").fetchone()[0], pointer["lastGoodSha"])

    def test_detect_cli_imports_outside_repo_and_does_not_create_store(self):
        empty_store = pathlib.Path(self.tmp.name) / "not-created"
        script = pathlib.Path(__file__).resolve().parents[1] / "scripts/release/factory_release_controller.py"
        result = subprocess.run([sys.executable, str(script), "detect", "--repo", str(self.repo), "--store", str(empty_store), "--registry", str(pathlib.Path(self.tmp.name) / "missing-registry.json")], cwd=self.tmp.name, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "drift")
        self.assertFalse(empty_store.exists())


if __name__ == "__main__":
    unittest.main()
