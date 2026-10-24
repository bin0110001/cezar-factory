import io
import json
import os
import pathlib
import stat
import subprocess
import tarfile
import tempfile
import unittest

from scripts.release.factory_release_controller import ControllerError, ReleaseController, canonical_json, check_relative_member, exclusive_lock


def git(path: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


class ReleaseControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-controller-test-")
        root = pathlib.Path(self.tmp.name)
        self.repo = root / "repo"
        self.origin = root / "origin.git"
        self.store = root / "store"
        self.origin.mkdir()
        subprocess.run(["git", "init", "--bare", str(self.origin)], check=True, capture_output=True)
        self.repo.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(self.repo)], check=True, capture_output=True)
        git(self.repo, "config", "user.name", "Factory Test")
        git(self.repo, "config", "user.email", "factory-test@example.invalid")
        (self.repo / "VERSION").write_text("0.0.1\n", encoding="utf-8")
        (self.repo / "nested").mkdir()
        (self.repo / "nested" / "file.txt").write_text("safe content\n", encoding="utf-8")
        git(self.repo, "add", "VERSION", "nested/file.txt")
        git(self.repo, "commit", "-m", "fixture")
        git(self.repo, "remote", "add", "origin", str(self.origin))
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", "HEAD:refs/heads/stable"], check=True, capture_output=True)
        self.sha = git(self.repo, "rev-parse", "HEAD")
        self.controller = ReleaseController(self.repo, self.store, "origin", "stable", 3, 30, 1)

    def tearDown(self) -> None:
        root = pathlib.Path(self.tmp.name)
        for item in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            with self.subTest(path=str(item)):
                try: os.chmod(item, stat.S_IWRITE | stat.S_IREAD | (stat.S_IEXEC if item.is_dir() else 0))
                except OSError: pass
        self.tmp.cleanup()

    def test_sync_stages_verifiable_immutable_bundle_and_is_idempotent(self) -> None:
        first = self.controller.sync()
        self.assertEqual(first["status"], "staged")
        release = self.store / "releases" / self.sha
        self.assertEqual(self.controller.verify_release(release)["state"], "verified")
        second = self.controller.sync()
        self.assertEqual(second["status"], "unchanged")
        pointer = json.loads((self.store / "channels" / "stable.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["currentSha"], self.sha)
        self.assertEqual(pathlib.Path(pointer["currentPath"]), release)
        with (release / "manifest.json").open(encoding="utf-8") as stream:
            manifest = json.load(stream)
        self.assertEqual(manifest["source"]["sha"], self.sha)
        self.assertEqual([f["path"] for f in manifest["files"]], ["VERSION", "nested/file.txt"])

    def test_tampered_bundle_is_rejected_without_replacing_channel_pointer(self) -> None:
        self.controller.sync()
        pointer = json.loads((self.store / "channels" / "stable.json").read_text(encoding="utf-8"))["currentSha"]
        bundle = self.store / "releases" / self.sha / "artifact.tar"
        os.chmod(bundle, stat.S_IWRITE | stat.S_IREAD)
        with bundle.open("ab") as stream:
            stream.write(b"tamper")
        with self.assertRaisesRegex(ControllerError, "digest mismatch"):
            self.controller.sync()
        self.assertEqual(json.loads((self.store / "channels" / "stable.json").read_text(encoding="utf-8"))["currentSha"], pointer)

    def test_rollback_uses_verified_local_artifact_without_remote_access(self) -> None:
        self.controller.sync()
        self.controller.remote = "offline-remote"
        result = self.controller.rollback(self.sha)
        self.assertEqual(result["status"], "rolled-back")
        self.assertEqual(result["sourceSha"], self.sha)

    def test_pointer_recovers_a_crash_before_sqlite_checkpoint(self) -> None:
        self.controller.sync()
        with self.controller._db() as db:
            db.execute("DELETE FROM channel_pointers WHERE channel='stable'")
        result = self.controller.sync()
        self.assertEqual(result["status"], "unchanged")
        with self.controller._db() as db:
            self.assertEqual(db.execute("SELECT current_sha FROM channel_pointers WHERE channel='stable'").fetchone()[0], self.sha)

    def test_active_reference_protects_an_artifact_and_release_is_idempotent(self) -> None:
        self.controller.sync()
        held = self.controller.protect(self.sha, "lease", "task-123", None)
        self.assertEqual(held["status"], "protected")
        self.assertEqual(self.controller.unprotect(self.sha, "lease", "task-123")["status"], "unprotected")
        self.assertEqual(self.controller.unprotect(self.sha, "lease", "task-123")["status"], "unprotected")

    def test_retention_keeps_minimum_and_honors_explicit_references(self) -> None:
        self.controller.sync()
        oldest = self.sha
        for index in range(3):
            (self.repo / f"release-{index}.txt").write_text(f"revision {index}\n", encoding="utf-8")
            git(self.repo, "add", f"release-{index}.txt")
            git(self.repo, "commit", "-m", f"revision {index}")
            subprocess.run(["git", "-C", str(self.repo), "push", "origin", "HEAD:refs/heads/stable"], check=True, capture_output=True)
            self.controller.sync()
        with self.controller._db() as db:
            db.execute("UPDATE releases SET staged_at='2000-01-01T00:00:00Z' WHERE source_sha=?", (oldest,))
        self.controller.protect(oldest, "lease", "open-task", None)
        self.assertEqual(self.controller._retention(), 0)
        self.assertTrue((self.store / "releases" / oldest).is_dir())
        self.controller.unprotect(oldest, "lease", "open-task")
        self.assertEqual(self.controller._retention(), 1)
        self.assertFalse((self.store / "releases" / oldest).exists())

    def test_lock_refuses_overlapping_invocations(self) -> None:
        lock = self.store / "controller.lock"
        with exclusive_lock(lock), self.assertRaisesRegex(ControllerError, "another release-controller"):
            with exclusive_lock(lock):
                pass

    def test_fetch_failure_is_checkpointed(self) -> None:
        broken = ReleaseController(self.repo, self.store / "broken", "origin", "missing", 3, 30, 1)
        with self.assertRaisesRegex(ControllerError, "bounded attempts"):
            broken.sync()
        with broken._db() as db:
            row = db.execute("SELECT status,retry_count FROM attempts").fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["retry_count"], 1)

    def test_archive_paths_reject_traversal_and_normalization(self) -> None:
        for name in ("release/../escape", "release/a//b", "outside/file", "release/a\\b"):
            with self.subTest(name=name), self.assertRaises(ControllerError):
                check_relative_member(name, "release/")

    def test_canonical_json_is_stable(self) -> None:
        self.assertEqual(canonical_json({"z": 1, "a": {"b": "\u00e9"}}), b'{"a":{"b":"\xc3\xa9"},"z":1}')
        self.assertEqual(canonical_json({"\ue000": 1, "\U0001f600": 2}), '{"\U0001f600":2,"\ue000":1}'.encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
