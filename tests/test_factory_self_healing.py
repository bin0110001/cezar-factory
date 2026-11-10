import json
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from scripts.release.factory_self_healing import diagnose, open_fix_pr, reconcile, rolling_escalation


class SelfHealingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.db = self.root / "ledger.sqlite"
        db = sqlite3.connect(self.db)
        with db:
            db.execute("CREATE TABLE incidents(failure_class TEXT,fingerprint TEXT,summary TEXT,first_seen REAL,last_seen REAL,attempt_count INTEGER,escalated INTEGER,causal_evidence TEXT)")
            for n in range(65):
                db.execute("INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?)", ("release", f"{n:064x}", f"failure {n}", 1, n, 4, int(n < 2), json.dumps({"source": f"receipt-{n}"})))
            db.execute("UPDATE incidents SET causal_evidence=? WHERE fingerprint=?", (json.dumps({"source": "e" * 50000}), f"{0:064x}"))
        db.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_diagnosis_is_read_only_bounded_and_deterministic(self):
        before = self.db.stat().st_mtime_ns
        a, b = diagnose(self.db), diagnose(self.db)
        self.assertEqual(a, b)
        self.assertEqual(a["count"], 50)
        self.assertTrue(a["hasMore"])
        self.assertTrue(a["truncated"])
        self.assertLessEqual(len(json.dumps(a, sort_keys=True, separators=(",", ":"))), 24000)
        self.assertTrue(a["incidents"][0]["escalated"])
        self.assertEqual(before, self.db.stat().st_mtime_ns)

    def test_repeated_escalation_updates_marker_and_offline_records_pending(self):
        fp = "a" * 64
        gh = Mock()
        gh.side_effect = [SimpleNamespace(stdout="[[]]"), SimpleNamespace(stdout=""),
                          SimpleNamespace(stdout=json.dumps([[{"id": 12, "body": f"<!-- factory-incident:{fp} -->"}]])), SimpleNamespace(stdout="")]
        state = self.root / "escalations.json"
        first = rolling_escalation("owner/repo", 7, fp, "first", gh="gh", state_path=state, runner=gh)
        second = rolling_escalation("owner/repo", 7, fp, "second", gh="gh", state_path=state, runner=gh)
        self.assertEqual((first["status"], second["status"]), ("created", "updated"))
        self.assertEqual(gh.call_count, 4)
        offline = rolling_escalation("owner/repo", 7, "b" * 64, "offline", gh="gh", state_path=state, runner=Mock(side_effect=OSError("offline")))
        self.assertEqual(offline["status"], "pending")
        self.assertIn("b" * 64, json.loads(state.read_text())["incidents"])

    def test_reconcile_escalates_without_cezar_and_report_is_bounded(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append(argv)
            if argv[1:2] == ["api"] and "comments" in argv[2]:
                return SimpleNamespace(stdout="[[]]")
            return SimpleNamespace(stdout="created")
        outcome = reconcile(self.db, "owner/repo", 8, self.root / "state.json", runner=runner)
        self.assertEqual(len(outcome["escalations"]), 2)
        self.assertEqual(outcome["diagnosis"]["count"], 50)
        self.assertTrue(all("cezar" not in arg.lower() for call in calls for arg in call))

    def test_fix_pr_is_dev_only_and_never_auto_merges(self):
        repo = self.root / "repo"; repo.mkdir()
        subprocess.run(["git", "init", "-b", "codex/fix-1", str(repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        (repo / "fix.py").write_text("fixed\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "fix.py"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-m", "fix"], check=True, capture_output=True)
        sha = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        body = self.root / "body.md"; body.write_text("Closes #7\n", encoding="utf-8")
        receipt = self.root / "receipt.json"
        receipt.write_text(json.dumps({"schemaVersion": 1, "repository": "owner/repo", "headSha": sha, "status": "passed", "exitCode": 0, "worktreeClean": True}), encoding="utf-8")
        gh = Mock(return_value=SimpleNamespace(stdout="https://github.com/owner/repo/pull/3\n"))
        git_calls = []
        def local_git(argv, **kwargs):
            git_calls.append(argv)
            if "remote" in argv:
                return subprocess.CompletedProcess(argv, 0, stdout="https://github.com/owner/repo.git", stderr="")
            if "push" in argv:
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
            return subprocess.run(argv, **kwargs)
        result = open_fix_pr(repo, "owner/repo", "Fix release", body, receipt, runner=gh, git_runner=local_git)
        self.assertEqual(result["base"], "dev")
        self.assertFalse(result["autoMerge"])
        self.assertIn("--base", gh.call_args.args[0]); self.assertIn("dev", gh.call_args.args[0])
        self.assertNotIn("merge", " ".join(gh.call_args.args[0]))
        self.assertTrue(any("push" in call for call in git_calls))


if __name__ == "__main__":
    unittest.main()
