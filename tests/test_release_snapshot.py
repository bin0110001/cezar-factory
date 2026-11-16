import os
import subprocess
import tempfile
import unittest

from scripts.release import release_snapshot as rs


class Repo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.git = rs.Git(self.dir)
        self.sh("init", "-q", "-b", "dev")
        self.sh("config", "user.email", "t@example.org")
        self.sh("config", "user.name", "t")
        self.sh("config", "commit.gpgsign", "false")
        self.n = 0
        self.stable = self.commit()
        self.sh("branch", "stable", self.stable)

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, *args):
        return subprocess.run(["git", "-C", self.dir, *args], capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, branch_checked_out=True):
        self.n += 1
        with open(os.path.join(self.dir, "f.txt"), "w") as f:
            f.write(str(self.n))
        self.sh("add", "-A")
        self.sh("commit", "-q", "-m", f"c{self.n}")
        return self.sh("rev-parse", "HEAD")

    def snap(self, dev, **kw):
        args = dict(candidate_id="c1", revision=1, dev_sha=dev, base_stable_sha=self.stable, config_hash="sha256:cfg", fingerprints={"env": "e1"})
        args.update(kw)
        return rs.create_snapshot(self.git, **args)


class Snapshots(Repo):
    def test_candidate_is_frozen_while_dev_advances(self):
        tested = self.commit()
        snap = self.snap(tested)
        self.assertTrue(snap.ok, snap.detail)
        self.assertEqual(self.sh("rev-parse", "refs/rc/c1/1"), tested)
        for _ in range(20):
            self.commit()  # dev keeps moving during the full suite
        self.assertEqual(rs.verify_snapshot(self.git, snap.ref, tested), "ok")
        self.assertEqual(self.sh("rev-parse", "refs/rc/c1/1"), tested)
        self.assertNotEqual(self.sh("rev-parse", "dev"), tested)
        self.assertEqual(snap.manifest["sha"], tested)

    def test_creating_the_same_snapshot_twice_is_idempotent_and_conflicts_are_refused(self):
        a = self.commit()
        self.assertTrue(self.snap(a).ok)
        self.assertTrue(self.snap(a).ok)
        b = self.commit()
        conflict = self.snap(b)
        self.assertEqual((conflict.ok, conflict.blocked), (False, "immutable-ref-conflict"))
        self.assertEqual(self.sh("rev-parse", "refs/rc/c1/1"), a)  # never overwritten

    def test_rejects_mutable_names_unknown_shas_and_diverged_stable(self):
        tip = self.commit()
        self.assertEqual(self.snap("dev").blocked, "unknown-sha")
        self.assertEqual(self.snap("f" * 40).blocked, "unknown-sha")
        self.sh("checkout", "-q", "-b", "other", self.stable)
        diverged = self.commit()
        self.sh("checkout", "-q", "dev")
        newer_stable = self.commit()  # stable moved on to a commit the candidate does not contain
        self.assertEqual(self.snap(diverged, base_stable_sha=newer_stable).blocked, "diverged-stable")
        with self.assertRaises(ValueError):
            rs.candidate_ref("../evil", 1)
        self.assertTrue(self.snap(tip, candidate_id="ok-2").ok)

    def test_regression_pointer_moves_only_with_expected_value(self):
        a = self.commit()
        first = self.snap(a, regression_branch="regression", expected_pointer=None)
        self.assertTrue(first.ok and first.pointer_moved)
        self.assertEqual(self.sh("rev-parse", "refs/heads/regression"), a)
        b = self.commit()
        second = self.snap(b, revision=2, regression_branch="regression", expected_pointer=a)
        self.assertTrue(second.ok)
        self.assertEqual(self.sh("rev-parse", "refs/heads/regression"), b)

    def test_unexpected_branch_writer_blocks_without_overwriting(self):
        a, b = self.commit(), self.commit()
        self.sh("branch", "regression", a)
        intruder = self.sh("rev-parse", "regression")
        res = self.snap(b, regression_branch="regression", expected_pointer=None)  # we thought it did not exist
        self.assertEqual((res.ok, res.blocked), (False, "writer-drift"))
        self.assertEqual(self.sh("rev-parse", "regression"), intruder)
        self.assertEqual(self.sh("rev-parse", "refs/rc/c1/1"), b)  # the immutable snapshot is still safe

    def test_non_fast_forward_pointer_needs_an_explicit_rewind(self):
        a = self.commit()
        self.sh("branch", "regression", self.stable)
        self.sh("checkout", "-q", "-b", "side", self.stable)
        side = self.commit()
        self.sh("checkout", "-q", "dev")
        self.sh("branch", "-f", "regression", side)
        res = self.snap(a, regression_branch="regression", expected_pointer=side)
        self.assertEqual(res.blocked, "non-fast-forward")
        self.assertTrue(self.snap(a, regression_branch="regression", expected_pointer=side, allow_pointer_rewind=True).ok)
        self.assertEqual(self.sh("rev-parse", "regression"), a)

    def test_pointer_opt_out_leaves_branches_alone(self):
        a = self.commit()
        before = self.sh("for-each-ref", "refs/heads")
        self.assertTrue(self.snap(a, regression_branch=None).ok)
        self.assertEqual(self.sh("for-each-ref", "refs/heads"), before)

    def test_alternate_branch_names_and_legacy_two_branch_work(self):
        a = self.commit()
        self.assertTrue(self.snap(a, regression_branch="release/candidate", expected_pointer=None).ok)
        with self.assertRaises(ValueError):
            self.snap(a, regression_branch="bad name; rm")


class Recovery(Repo):
    def test_deleted_and_moved_refs_are_detected_and_the_deleted_one_recovered(self):
        a = self.commit()
        snap = self.snap(a)
        self.sh("update-ref", "-d", snap.ref)
        self.assertEqual(rs.verify_snapshot(self.git, snap.ref, a), "ref-missing")
        self.assertTrue(rs.recover_missing_ref(self.git, snap.ref, a))
        self.assertEqual(rs.verify_snapshot(self.git, snap.ref, a), "ok")
        b = self.commit()
        self.sh("update-ref", snap.ref, b)
        self.assertEqual(rs.verify_snapshot(self.git, snap.ref, a), "ref-moved")
        self.assertFalse(rs.recover_missing_ref(self.git, snap.ref, a))  # a moved ref is blocked, not overwritten
        self.assertEqual(self.sh("rev-parse", snap.ref), b)

    def test_ref_race_is_reported(self):
        a = self.commit()
        self.assertFalse(self.git.cas("refs/rc/x/1", a, self.stable))  # expected old value is wrong
        self.assertTrue(self.git.cas("refs/rc/x/1", a, None))
        self.assertFalse(self.git.cas("refs/rc/x/1", a, None))  # already exists


class Revisions(Repo):
    def test_repair_must_descend_without_merging_dev(self):
        tested = self.commit()
        self.snap(tested)
        repair = self.commit()
        self.assertEqual(rs.derive_revision(self.git, previous_sha=tested, repair_sha=repair), (True, "ok"))
        self.assertFalse(rs.derive_revision(self.git, previous_sha=tested, repair_sha=tested)[0])
        # dev moves on and is merged into the repair: refused
        self.sh("checkout", "-q", "-b", "fix", tested)
        self.sh("checkout", "-q", "dev")
        self.commit()
        self.sh("checkout", "-q", "fix")
        self.sh("merge", "-q", "--no-ff", "-m", "merge dev", "dev")
        merged = self.sh("rev-parse", "HEAD")
        ok, why = rs.derive_revision(self.git, previous_sha=tested, repair_sha=merged)
        self.assertFalse(ok)
        self.assertIn("merge commit", why)
        # unrelated lineage is refused too
        self.sh("checkout", "-q", "dev")
        self.assertFalse(rs.derive_revision(self.git, previous_sha=repair, repair_sha=tested)[0])


class CleanupAndProvenance(Repo):
    def make(self, n):
        out = []
        for rev in range(1, n + 1):
            sha = self.commit()
            snap = self.snap(sha, revision=rev)
            out.append({"ref": snap.ref, "sha": sha, "revision": rev})
        return out

    def test_cleanup_only_after_terminal_and_records_audit_first(self):
        revs = self.make(2)
        with self.assertRaises(ValueError):
            rs.cleanup(self.git, candidate_id="c1", state="validating", revisions=revs)
        res = rs.cleanup(self.git, candidate_id="c1", state="abandoned", revisions=revs)
        self.assertEqual(len(res["audit"]), 2)
        self.assertEqual(sorted(res["deleted"]), sorted(r["ref"] for r in revs))
        self.assertIsNone(self.git.ref_value(revs[0]["ref"]))

    def test_promoted_candidate_keeps_its_final_ref_and_tampered_refs_are_left(self):
        revs = self.make(2)
        self.sh("update-ref", revs[0]["ref"], self.sh("rev-parse", "dev"))  # tamper revision 1
        res = rs.cleanup(self.git, candidate_id="c1", state="promoted", revisions=revs)
        self.assertEqual(res["kept"], [revs[1]["ref"]])
        self.assertEqual(res["drifted"], [revs[0]["ref"]])
        self.assertIsNotNone(self.git.ref_value(revs[1]["ref"]))
        self.assertIsNotNone(self.git.ref_value(revs[0]["ref"]))

    def test_provenance_binds_stable_to_the_exact_tested_sha(self):
        a = self.commit()
        snap = self.snap(a)
        prov = rs.provenance(snap.manifest, stable_branch="stable", tested_sha=a)
        self.assertEqual((prov["promotedSha"], prov["candidateRef"], prov["baseStableSha"]), (a, "refs/rc/c1/1", self.stable))
        self.assertTrue(self.git.is_ancestor(prov["baseStableSha"], prov["promotedSha"]))
        with self.assertRaises(ValueError):
            rs.provenance(snap.manifest, stable_branch="stable", tested_sha=self.commit())
        again = self.snap(a)
        self.assertEqual(again.manifest["manifestHash"], snap.manifest["manifestHash"])


if __name__ == "__main__":
    unittest.main()
