import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone

from scripts.release import release_inbox_step as step
from scripts.release.release_candidate_store import CandidateStore

ROOT = pathlib.Path(__file__).resolve().parents[1]
NOW = 1_800_000_000.0


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def jl(path, *rows):
    with open(path, "a", encoding="utf8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def rows(path):
    return [json.loads(x) for x in pathlib.Path(path).read_text(encoding="utf8").splitlines() if x.strip()]


class Step(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.rel, self.store, self.repo = t / "release", t / "store" / "c.db", t / "repo"
        self.rel.mkdir()
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "one")
        for ref in ("dev", "stable"):  # stand-ins for the already-fetched remote refs
            git(self.repo, "update-ref", f"refs/remotes/origin/{ref}", "HEAD")
        self.policy = ROOT / "policies" / "quality-gates.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_step(self):
        return step.run(self.rel, self.store, self.repo, self.policy, now=NOW)

    def waiver(self, i, **over):
        r = {"id": i, "at": iso(NOW - 60), "actor": "local-operator", "reviewerKind": "operator", "projectId": "tableflux", "candidateId": None,
             "fingerprint": "a" * 64, "advisoryId": None, "stages": ["stable"], "pathGlob": None, "reason": "Upstream fix lands next week", "expiresAt": iso(NOW + 7 * 86400)}
        r.update(over)
        return r

    def action(self, i, action, **over):
        r = {"id": i, "at": iso(NOW - 30), "actor": "local-operator", "action": action, "projectId": "tableflux", "candidateId": None, "reason": "operator asked", "confirmed": False}
        r.update(over)
        return r

    def test_nothing_to_do_writes_an_empty_hold_snapshot_and_no_decisions(self):
        out = self.run_step()
        self.assertEqual(out["paused"], [])
        self.assertFalse((self.rel / "waiver-decisions.jsonl").exists())
        self.assertEqual(json.loads((self.rel / "holds.json").read_text())["paused"], [])

    def test_waivers_are_decided_against_the_policy_and_a_rerun_decides_nothing_again(self):
        jl(self.rel / "waivers.jsonl", self.waiver("w1"), self.waiver("w2", reviewerKind="agent"), self.waiver("w3", expiresAt=iso(NOW + 90 * 86400)))
        out = self.run_step()
        self.assertEqual(out["waivers"], {"granted": 1, "rejected": 2})
        self.assertEqual([d["outcome"] for d in rows(self.rel / "waiver-decisions.jsonl")], ["granted", "rejected", "rejected"])
        self.assertEqual(self.run_step()["waivers"], {"granted": 0, "rejected": 0})
        self.assertEqual(len(rows(self.rel / "waiver-decisions.jsonl")), 3)

    def test_an_unreadable_policy_leaves_waivers_undecided_for_the_next_run(self):
        jl(self.rel / "waivers.jsonl", self.waiver("w1"))
        self.policy = pathlib.Path(self.tmp.name) / "missing.json"
        out = self.run_step()
        self.assertIn("error", out["waivers"])
        self.assertFalse((self.rel / "waiver-decisions.jsonl").exists())
        self.policy = ROOT / "policies" / "quality-gates.json"
        self.assertEqual(self.run_step()["waivers"]["granted"], 1)

    def test_create_opens_a_candidate_bound_to_the_remote_refs_and_pause_shows_in_the_hold_snapshot(self):
        jl(self.rel / "actions.jsonl", self.action("a1", "create"))
        out = self.run_step()
        self.assertEqual(out["actions"]["applied"], 1)
        active = CandidateStore(str(self.store)).active("tableflux")
        head = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertEqual((active["dev_sha"], active["base_stable_sha"]), (head, head))
        self.assertTrue(active["config_hash"].startswith("sha256:"))
        jl(self.rel / "actions.jsonl", self.action("a2", "pause", candidateId=active["id"]))
        self.assertEqual(self.run_step()["paused"], ["tableflux"])
        jl(self.rel / "actions.jsonl", self.action("a3", "resume", candidateId=active["id"], at=iso(NOW + 5)))
        self.assertEqual(self.run_step()["paused"], [])

    def test_confirmed_cancel_ends_the_candidate_and_unconfirmed_does_not(self):
        jl(self.rel / "actions.jsonl", self.action("a1", "create"))
        self.run_step()
        cid = CandidateStore(str(self.store)).active("tableflux")["id"]
        jl(self.rel / "actions.jsonl", self.action("a2", "cancel", candidateId=cid))
        self.assertEqual(self.run_step()["actions"]["rejected"], 1)
        self.assertIsNotNone(CandidateStore(str(self.store)).active("tableflux"))
        jl(self.rel / "actions.jsonl", self.action("a3", "cancel", candidateId=cid, confirmed=True))
        self.assertEqual(self.run_step()["actions"]["applied"], 1)
        self.assertIsNone(CandidateStore(str(self.store)).active("tableflux"))

    def test_missing_remote_refs_reject_create_instead_of_guessing(self):
        git(self.repo, "update-ref", "-d", "refs/remotes/origin/stable")
        jl(self.rel / "actions.jsonl", self.action("a1", "create"))
        self.assertEqual(self.run_step()["actions"]["rejected"], 1)
        self.assertFalse(CandidateStore(str(self.store)).active("tableflux"))


if __name__ == "__main__":
    unittest.main()
