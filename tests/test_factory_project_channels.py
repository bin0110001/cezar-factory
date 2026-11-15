import hashlib
import json
import pathlib
import tempfile
import unittest

from scripts.release.factory_project_channels import ProjectChannels

SHA_A = "a" * 40
SHA_B = "b" * 40


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ProjectChannelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-channels-")
        self.root = pathlib.Path(self.tmp.name)
        self.store = self.root / "store"
        (self.store / "channels").mkdir(parents=True)
        for channel, value in (("stable", SHA_A), ("dev", SHA_B)):
            (self.store / "channels" / f"{channel}.json").write_text(json.dumps({"channel": channel, "currentSha": value}))
        rel = self.store / "releases" / SHA_B / "workflows"
        rel.mkdir(parents=True)
        (rel / "x.yaml").write_text("new")
        self.registry = self.root / "projects.json"
        self.registry.write_text(json.dumps([{"projectId": "p1", "apiUrl": "http://x.invalid"}]))
        self.diag = {"channel": "stable", "status": "resolved", "sourceSha": SHA_A, "activeTasks": [{"id": "t1"}],
                     "overrides": [{"path": "workflows/x.yaml", "digest": "mod", "baseDigest": sha(b"old")}]}
        self.fail = None
        self.svc = ProjectChannels(self.store, self.registry, diagnostic=self._diag)

    def _diag(self, target):
        if self.fail:
            raise RuntimeError(self.fail)
        return dict(self.diag)

    def tearDown(self):
        self.tmp.cleanup()

    def receipt(self, state, sha_, gen):
        d = self.store / "receipts" / hashlib.sha256(b"p1").hexdigest()[:24] / "stable"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{gen}.json").write_text(json.dumps({"targetId": "p1", "state": state, "desiredSha": sha_, "requestedAt": f"2026-01-0{gen}", "activationGeneration": gen}))

    def test_configured_effective_and_deployed_are_distinct(self):
        self.receipt("healthy", SHA_A, 1)
        s = self.svc.detail("p1")
        self.assertEqual((s["configuredChannel"], s["configuredSha"], s["effectiveSha"]), ("stable", SHA_A, SHA_A))
        self.assertTrue(s["deployed"])
        self.diag["sourceSha"] = SHA_B
        s = self.svc.detail("p1")
        self.assertIn("shadow_drift", s["findings"])
        self.assertFalse(s["deployed"])
        self.assertEqual(s["lastSuccessfulActivation"]["sha"], SHA_A)
        self.assertTrue(s["remediation"])

    def test_configured_without_successful_activation_is_not_deployed(self):
        self.receipt("failed", SHA_A, 1)
        s = self.svc.detail("p1")
        self.assertFalse(s["deployed"])
        self.assertIn("failed", s["findings"])

    def test_offline_reports_stale_host_facts(self):
        self.fail = "connection refused"
        s = self.svc.detail("p1")
        self.assertTrue(s["stale"])
        self.assertIn("unreachable", s["findings"])
        self.assertIsNone(s["configuredChannel"])

    def test_preview_warns_active_tasks_and_diffs_override_read_only(self):
        before = sorted(p.name for p in self.store.rglob("*"))
        pv = self.svc.preview("p1", "dev", "alice")
        self.assertTrue(pv["allowed"] and pv["readOnly"] and pv["pinnedTasksUnaffected"])
        self.assertEqual(pv["targetSha"], SHA_B)
        self.assertEqual(pv["overrideDiff"], [{"path": "workflows/x.yaml", "status": "conflict"}])
        self.assertTrue(any("active task" in w for w in pv["warnings"]))
        self.assertEqual(before, sorted(p.name for p in self.store.rglob("*")))

    def test_preview_permission_denied_and_quarantine(self):
        self.assertEqual(self.svc.preview("p1", "dev", "mallory", {"alice"})["reason"], "permission-denied")
        (self.store / "quarantine").mkdir()
        (self.store / "quarantine" / f"{SHA_B}.json").write_text("{}")
        self.assertEqual(self.svc.preview("p1", "dev", "alice")["reason"], "target-release-quarantined")

    def test_request_is_audited_and_changes_no_pointer(self):
        token = self.svc.preview("p1", "dev", "alice")["token"]
        result = self.svc.request_change("p1", "dev", "alice", token)
        self.assertEqual(result["status"], "requested")
        self.assertEqual(json.loads(pathlib.Path(result["audit"]).read_text())["actor"], "alice")
        self.assertEqual(json.loads((self.store / "channels" / "stable.json").read_text())["currentSha"], SHA_A)

    def test_concurrent_change_makes_preview_stale(self):
        token = self.svc.preview("p1", "dev", "alice")["token"]
        self.diag["activeTasks"].append({"id": "t2"})
        self.assertEqual(self.svc.request_change("p1", "dev", "alice", token)["reason"], "stale-preview")
        self.assertEqual(self.svc.request_change("p1", "dev", "mallory", token, {"alice"})["reason"], "permission-denied")

    def test_unreadable_tasks_warn(self):
        del self.diag["activeTasks"]
        pv = self.svc.preview("p1", "dev", "alice")
        self.assertIsNone(pv["activeTasks"])
        self.assertTrue(any("could not be read" in w for w in pv["warnings"]))


if __name__ == "__main__":
    unittest.main()
