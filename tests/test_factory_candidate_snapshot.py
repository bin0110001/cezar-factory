import json
import pathlib
import subprocess
import tempfile
import unittest

from scripts.release import factory_candidate_snapshot as cs


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          capture_output=True, text=True, check=True).stdout.strip()


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-candidate-")
        root = pathlib.Path(self.tmp.name)
        self.repo, self.store = root / "repo", root / "store"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "dev")
        self.commit("base")
        git(self.repo, "branch", "stable")
        self.commit("feature")
        self.sha = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, msg):
        (self.repo / f"{msg}.txt").write_text(msg)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", msg)

    def snap(self, policy=None, **kw):
        return cs.create_snapshot(self.repo, self.store, "c1", self.sha, policy, {"env": "e1"}, {"suite": "d" * 8}, now=100, **kw)

    def test_dev_advancing_leaves_candidate_unchanged(self):
        out = self.snap()
        self.assertEqual(out["status"], "created")
        before = pathlib.Path(out["recordPath"]).read_bytes()
        for i in range(20):
            self.commit(f"dev{i}")
        self.assertEqual(git(self.repo, "rev-parse", "refs/tags/rc/c1/1"), self.sha)
        self.assertEqual(pathlib.Path(out["recordPath"]).read_bytes(), before)
        self.assertEqual(cs.verify_snapshot(self.repo, self.store, "c1", 1)["status"], "ok")
        self.assertEqual(out["record"]["stableBase"], git(self.repo, "rev-parse", "stable"))

    def test_unmerged_sha_and_duplicate_blocked(self):
        git(self.repo, "checkout", "-q", "-b", "side")
        self.commit("side")
        side = git(self.repo, "rev-parse", "HEAD")
        out = cs.create_snapshot(self.repo, self.store, "c2", side)
        self.assertEqual(out["reason"], "sha-not-merged-to-dev")
        self.snap()
        self.assertEqual(self.snap()["status"], "blocked")

    def test_rc_ref_deleted_and_drifted(self):
        self.snap()
        git(self.repo, "tag", "-d", "rc/c1/1")
        v = cs.verify_snapshot(self.repo, self.store, "c1", 1)
        self.assertEqual((v["reason"], v["observed"]), ("rc-ref-deleted", None))
        git(self.repo, "tag", "rc/c1/1", "stable")
        v = cs.verify_snapshot(self.repo, self.store, "c1", 1)
        self.assertEqual(v["reason"], "rc-ref-drift")
        self.assertEqual(v["expected"], self.sha)

    def test_tampered_record_blocked(self):
        out = self.snap()
        path = pathlib.Path(out["recordPath"])
        data = json.loads(path.read_text())
        data["sha"] = "f" * 40
        path.write_text(json.dumps(data))
        self.assertEqual(cs.verify_snapshot(self.repo, self.store, "c1", 1)["reason"], "record-invalid")

    def test_pointer_create_fast_forward_and_drift(self):
        r = cs.move_pointer(self.repo, None, self.sha, None)
        self.assertEqual((r["status"], r["mode"]), ("moved", "create"))
        stable = git(self.repo, "rev-parse", "stable")
        # unexpected writer moves the pointer; the guarded transition must not overwrite it
        git(self.repo, "branch", "-f", "regression", stable)
        r = cs.move_pointer(self.repo, None, self.sha, self.sha)
        self.assertEqual((r["reason"], r["expected"], r["observed"]), ("pointer-drift", self.sha, stable))
        self.assertEqual(git(self.repo, "rev-parse", "regression"), stable)
        self.assertEqual(cs.move_pointer(self.repo, None, self.sha, stable)["mode"], "fast-forward")
        git(self.repo, "branch", "-D", "regression")
        self.assertEqual(cs.move_pointer(self.repo, None, self.sha, self.sha)["reason"], "pointer-deleted")
        self.assertEqual(cs.move_pointer(self.repo, None, self.sha, None)["status"], "moved")

    def test_non_fast_forward_needs_lease_and_protected_refs(self):
        cs.move_pointer(self.repo, None, self.sha, None)
        stable = git(self.repo, "rev-parse", "stable")
        r = cs.move_pointer(self.repo, None, stable, self.sha)
        self.assertEqual(r["reason"], "non-fast-forward")
        self.assertEqual(cs.move_pointer(self.repo, None, stable, self.sha, force_with_lease=True)["mode"], "force-with-lease")
        r = cs.move_pointer(self.repo, {"protectedRefs": ["regression"]}, self.sha, stable)
        self.assertEqual(r["reason"], "protected-ref")
        r = cs.move_pointer(self.repo, {"branches": {"regression": "dev"}}, self.sha, self.sha)
        self.assertEqual(r["reason"], "protected-ref")
        r = cs.move_pointer(self.repo, {"branches": {"regression": "rc/x"}}, self.sha, None)
        self.assertEqual(r["reason"], "protected-ref")

    def test_cas_race_blocks(self):
        real = cs._cas
        calls = []

        def racing(repo, ref, new, expected):
            if not calls:
                calls.append(1)
                git(self.repo, "branch", "regression", "stable")  # concurrent writer wins
            return real(repo, ref, new, expected)
        cs._cas = racing
        try:
            r = cs.move_pointer(self.repo, None, self.sha, None)
        finally:
            cs._cas = real
        self.assertEqual(r["reason"], "pointer-race")
        self.assertEqual(r["observed"], git(self.repo, "rev-parse", "stable"))

    def test_config_modes(self):
        legacy = {"legacyTwoBranchMode": True}
        out = self.snap(legacy)
        self.assertIsNone(out["record"]["rcRef"])
        self.assertEqual(git(self.repo, "tag", "--list"), "")
        self.assertEqual(cs.move_pointer(self.repo, legacy, self.sha, None)["reason"], "legacy-two-branch-mode")
        self.assertEqual(cs.move_pointer(self.repo, {"regressionPointer": False}, self.sha, None)["status"], "skipped")
        self.assertEqual(cs.move_pointer(self.repo, {"branches": {"regression": None}}, self.sha, None)["status"], "skipped")
        git(self.repo, "branch", "main-line", "dev")
        r = cs.move_pointer(self.repo, {"branches": {"regression": "qa-candidate"}}, self.sha, None)
        self.assertEqual(r["ref"], "refs/heads/qa-candidate")

    def test_revision_derives_from_candidate_without_dev(self):
        first = self.snap()
        git(self.repo, "checkout", "-q", "-b", "repair", self.sha)
        self.commit("repair")
        fix = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "dev")
        self.commit("later-dev")
        out = cs.build_revision(self.repo, self.store, "c1", fix, now=200)
        self.assertEqual(out["status"], "created")
        rec = out["record"]
        self.assertEqual((rec["rev"], rec["parentRev"], rec["sha"]), (2, 1, fix))
        self.assertEqual(rec["evidence"], {})
        self.assertEqual(rec["invalidates"][0]["evidence"], {"suite": "d" * 8})
        self.assertTrue(pathlib.Path(first["recordPath"]).with_suffix(".invalidated.json").is_file())
        self.assertEqual(git(self.repo, "rev-parse", "refs/tags/rc/c1/1"), self.sha)
        self.assertEqual(git(self.repo, "rev-parse", "refs/tags/rc/c1/2"), fix)
        # latest dev merged into the repair is refused, as is a SHA not derived from the candidate
        git(self.repo, "checkout", "-q", "repair")
        git(self.repo, "merge", "-q", "--no-edit", "dev")
        merged = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(cs.build_revision(self.repo, self.store, "c1", merged)["reason"], "repair-contains-dev-commits")
        self.assertEqual(cs.build_revision(self.repo, self.store, "c1", "stable")["reason"], "not-derived-from-candidate")

    def test_retention_cleanup(self):
        self.snap()
        cs.move_pointer(self.repo, None, self.sha, None)
        pol = {"retentionSeconds": 10, "auditRetentionSeconds": 100}
        args = (self.repo, self.store, "c1", 1)
        self.assertEqual(cs.retention_cleanup(*args, None, None, pol, now=500)["reason"], "not-terminal")
        self.assertEqual(cs.retention_cleanup(*args, "promoted", 495, pol, now=500)["status"], "nothing-to-clean")
        dry = cs.retention_cleanup(*args, "promoted", 400, pol, now=420, dry_run=True)
        self.assertEqual(dry["status"], "dry-run")
        self.assertEqual(git(self.repo, "rev-parse", "regression"), self.sha)
        out = cs.retention_cleanup(*args, "promoted", 400, pol, now=420)
        self.assertEqual([a["kind"] for a in out["actions"]], ["pointer"])
        self.assertEqual(git(self.repo, "rev-parse", "refs/tags/rc/c1/1"), self.sha)  # audit tag kept
        out = cs.retention_cleanup(*args, "promoted", 400, pol, now=600)
        self.assertEqual([a["kind"] for a in out["actions"]], ["rc-tag"])
        self.assertTrue((self.store / "candidates" / "c1" / "1.json").is_file())  # record never deleted
        lines = (self.store / "cleanup.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 3)

    def test_context_and_provenance(self):
        out = self.snap()
        ctx = cs.candidate_context(out["record"])
        self.assertEqual((ctx["sha"], ctx["devBranch"]), (self.sha, "dev"))
        prov = cs.promotion_provenance(self.repo, out["record"])
        self.assertEqual(prov["status"], "ready")
        self.assertEqual(prov["provenance"]["snapshotId"], "c1/1")
        self.assertEqual(prov["provenance"]["evidenceDigests"], {"suite": "d" * 8})
        git(self.repo, "checkout", "-q", "-b", "other", "stable~0")
        self.commit("diverge")
        git(self.repo, "branch", "-f", "stable", "HEAD")
        self.assertEqual(cs.promotion_provenance(self.repo, out["record"])["reason"], "stable-not-ancestor")

    def test_cli_blocked_exit_code(self):
        self.snap()
        self.assertEqual(cs._main(["--repo", str(self.repo), "--store", str(self.store), "verify", "--id", "c1", "--rev", "1"]), 0)
        git(self.repo, "tag", "-d", "rc/c1/1")
        self.assertEqual(cs._main(["--repo", str(self.repo), "--store", str(self.store), "verify", "--id", "c1", "--rev", "1"]), 2)

    def test_invalid_id_rejected(self):
        with self.assertRaises(cs.SnapshotError):
            cs.create_snapshot(self.repo, self.store, "../x", self.sha)


if __name__ == "__main__":
    unittest.main()
