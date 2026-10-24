import json
import os
import pathlib
import subprocess
import tempfile
import unittest

from scripts.release.factory_activation import ActivationCoordinator, ActivationError
from scripts.release.factory_release_controller import ReleaseController


def git(path: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


def automation(name: str, prompt: str, workflow: str = "factory-intake", enabled: bool = False) -> dict:
    return {
        "name": name,
        "description": "Factory test",
        "enabled": enabled,
        "kind": "schedule",
        "schedule": {"timezone": "UTC", "rrule": "FREQ=DAILY"},
        "task": {"workflow": workflow, "prompt": prompt},
    }


class FakeCezar:
    def __init__(self, controller: ReleaseController) -> None:
        self.controller = controller
        self.items = [
            {**automation("[factory] keep", "old", enabled=True), "id": "old-keep", "revision": 3},
            {**automation("[factory] retire", "retire", enabled=True), "id": "old-retire", "revision": 2},
            {**automation("Personal automation", "leave me", enabled=True), "id": "personal", "revision": 1},
        ]
        self.next_id = 1
        self.fail_workflow_reads = 0
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, url: str, body: dict | None = None):
        path = url.split("/api/v1/p/shop", 1)[-1]
        self.calls.append((method, path))
        if path == "/factory-release" and method == "GET":
            pointer = json.loads((self.controller.channels / "stable.json").read_text(encoding="utf-8"))
            manifest = json.loads((self.controller.releases / pointer["currentSha"] / "manifest.json").read_text(encoding="utf-8"))
            return {"status": "resolved", "projectId": "shop", "channel": "stable", "sourceSha": pointer["currentSha"], "manifestDigest": manifest["manifestDigest"]}
        if path == "/workflows" and method == "GET":
            if self.fail_workflow_reads:
                self.fail_workflow_reads -= 1
                raise ActivationError("fixture timeout on workflow discovery")
            return {"workflows": [{"name": "quick-task"}, {"name": "factory-intake"}], "issues": []}
        if path == "/automations" and method == "GET":
            return {"available": True, "automations": [{"id": item["id"], "name": item["name"], "enabled": item["enabled"]} for item in self.items]}
        if path.startswith("/automations/"):
            automation_id = path.rsplit("/", 1)[-1]
            item = next((item for item in self.items if item["id"] == automation_id), None)
            if item is None:
                raise ActivationError(f"fixture HTTP 404 missing {automation_id}")
            if method == "GET":
                return {"automation": dict(item)}
            if method == "PUT":
                if body["expectedRevision"] != item["revision"]:
                    raise ActivationError("fixture revision conflict")
                item.update({key: value for key, value in body.items() if key != "expectedRevision"})
                item["revision"] += 1
                return {"automation": dict(item)}
            if method == "DELETE":
                self.items.remove(item)
                return None
        if path == "/automations" and method == "POST":
            item = {key: value for key, value in body.items() if key != "enable"}
            item["enabled"] = bool(body.get("enable", False))
            item["id"] = f"new-{self.next_id}"
            item["revision"] = 1
            self.next_id += 1
            self.items.append(item)
            return {"automation": dict(item)}
        raise AssertionError(f"unexpected fixture request: {method} {path}")


class FactoryActivationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-activation-test-")
        root = pathlib.Path(self.tmp.name)
        self.repo = root / "repo"
        self.origin = root / "origin.git"
        self.store = root / "store"
        self.registry = root / "factory-projects.json"
        self.origin.mkdir()
        subprocess.run(["git", "init", "--bare", str(self.origin)], check=True, capture_output=True)
        self.repo.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(self.repo)], check=True, capture_output=True)
        git(self.repo, "config", "user.name", "Factory Test")
        git(self.repo, "config", "user.email", "factory-test@example.invalid")
        self._write_release("0.1.0", [automation("[factory] keep", "old"), automation("[factory] retire", "retire")])
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-m", "initial release")
        git(self.repo, "remote", "add", "origin", str(self.origin))
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", "HEAD:refs/heads/stable"], check=True, capture_output=True)
        self.controller = ReleaseController(self.repo, self.store, "origin", "stable", 3, 30, 1)
        self.controller.sync()
        self.previous_sha = git(self.repo, "rev-parse", "HEAD")
        self._write_release("0.2.0", [automation("[factory] keep", "new"), automation("[factory] new", "start")])
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-m", "candidate release")
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", "HEAD:refs/heads/stable"], check=True, capture_output=True)
        self.candidate_sha = git(self.repo, "rev-parse", "HEAD")
        self.controller.stage_current()
        self.registry.write_text(json.dumps([{"apiUrl": "http://fake.invalid", "projectId": "shop", "projectType": "godot"}]), encoding="utf-8")
        self.fake = FakeCezar(self.controller)
        self.coordinator = ActivationCoordinator(self.controller, self.registry, request=self.fake)

    def _write_release(self, version: str, definitions: list[dict]) -> None:
        (self.repo / "VERSION").write_text(version + "\n", encoding="utf-8")
        (self.repo / "workflows").mkdir(exist_ok=True)
        (self.repo / "workflows" / "intake.yaml").write_text("name: factory-intake\nsteps: []\n", encoding="utf-8")
        (self.repo / "automations").mkdir(exist_ok=True)
        for path in (self.repo / "automations").glob("*.json"):
            path.unlink()
        for index, definition in enumerate(definitions):
            (self.repo / "automations" / f"{index}.json").write_text(json.dumps(definition), encoding="utf-8")

    def tearDown(self) -> None:
        for path in sorted(pathlib.Path(self.tmp.name).rglob("*"), key=lambda item: len(item.parts), reverse=True):
            try:
                os.chmod(path, 0o700 if path.is_dir() else 0o600)
            except OSError:
                pass
        self.tmp.cleanup()

    def test_activation_reconciles_and_records_a_verified_per_project_receipt(self) -> None:
        result = self.coordinator.activate(self.candidate_sha)
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(json.loads((self.controller.channels / "stable.json").read_text())["currentSha"], self.candidate_sha)
        by_name = {item["name"]: item for item in self.fake.items}
        self.assertEqual(by_name["[factory] keep"]["task"]["prompt"], "new")
        self.assertFalse(by_name["[factory] retire"]["enabled"])
        self.assertFalse(by_name["[factory] new"]["enabled"])
        self.assertTrue(by_name["Personal automation"]["enabled"])
        receipts = list((self.store / "receipts").rglob("*.json"))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "active")
        self.assertEqual(receipt["desiredSha"], self.candidate_sha)
        self.assertEqual(receipt["actualSha"], self.candidate_sha)
        self.assertEqual(receipt["observedSha"], self.candidate_sha)
        self.assertEqual(self.coordinator.activate(self.candidate_sha)["status"], "unchanged")

    def test_partial_automation_sync_is_compensated_and_candidate_quarantined(self) -> None:
        self.fake.fail_workflow_reads = 1
        with self.assertRaisesRegex(ActivationError, "rolled back"):
            self.coordinator.activate(self.candidate_sha)
        self.assertEqual(json.loads((self.controller.channels / "stable.json").read_text())["currentSha"], self.previous_sha)
        by_name = {item["name"]: item for item in self.fake.items}
        self.assertEqual(by_name["[factory] keep"]["task"]["prompt"], "old")
        self.assertTrue(by_name["[factory] retire"]["enabled"])
        self.assertNotIn("[factory] new", by_name)
        self.assertTrue(self.coordinator._load_quarantine(self.candidate_sha))
        self.assertEqual(json.loads(next((self.store / "receipts").rglob("*.json")).read_text())["state"], "rolled_back")
        self.assertEqual(self.coordinator.revalidate(self.candidate_sha)["status"], "revalidated")
        self.assertIsNone(self.coordinator._load_quarantine(self.candidate_sha))

    def test_interrupted_activation_is_compensated_before_another_attempt(self) -> None:
        original = self.coordinator._reconcile
        self.coordinator._reconcile = lambda *_args: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.coordinator.activate(self.candidate_sha)
        self.coordinator._reconcile = original
        self.assertEqual(self.coordinator.recover_incomplete(), 1)
        self.assertEqual(json.loads((self.controller.channels / "stable.json").read_text())["currentSha"], self.previous_sha)
        self.assertNotIn("[factory] new", {item["name"] for item in self.fake.items})
        self.assertEqual(self.coordinator.revalidate(self.candidate_sha)["status"], "revalidated")
        self.assertEqual(self.coordinator.activate(self.candidate_sha)["status"], "healthy")

    def test_operator_rollback_restores_pointer_and_factory_definitions(self) -> None:
        self.assertEqual(self.coordinator.activate(self.candidate_sha)["status"], "healthy")
        result = self.coordinator.rollback(self.previous_sha)
        self.assertEqual(result["status"], "rolled_back")
        self.assertEqual(json.loads((self.controller.channels / "stable.json").read_text())["currentSha"], self.previous_sha)
        by_name = {item["name"]: item for item in self.fake.items}
        self.assertEqual(by_name["[factory] keep"]["task"]["prompt"], "old")
        self.assertTrue(by_name["[factory] retire"]["enabled"])
        self.assertNotIn("[factory] new", by_name)

    def test_missing_target_registry_fails_before_pointer_change(self) -> None:
        self.registry.unlink()
        with self.assertRaisesRegex(ActivationError, "target registry is missing"):
            self.coordinator.activate(self.candidate_sha)
        self.assertEqual(json.loads((self.controller.channels / "stable.json").read_text())["currentSha"], self.previous_sha)


if __name__ == "__main__":
    unittest.main()
