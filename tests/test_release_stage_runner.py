import json
import pathlib
import tempfile
import unittest
from datetime import datetime, timezone

from scripts.release import release_stage_runner as runner

ROOT = pathlib.Path(__file__).resolve().parents[1]
NOW = 1_800_000_000.0
GOOD = {"test": {"status": "pass"}, "secrets": {"status": "pass"}, "sca": {"status": "pass"}}
FINDING = {"fingerprint": "a" * 64, "category": "sca", "severity": "critical", "advisoryId": "CVE-2021-0001", "path": "package-lock.json", "fixAvailable": True}


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def granted(project="tableflux", expires=NOW + 7 * 86400):
    sup = {"fingerprint": "a" * 64, "grantedByKind": "operator", "grantedBy": "local-operator", "grantedAt": NOW - 60, "expiresAt": expires,
           "reason": "Upstream fix lands next week", "receiptId": "exc-w1", "scope": {"project": project, "stages": ["stable"]}}
    return {"schemaVersion": "waiver-decision/v1", "requestId": "w1", "projectId": project, "outcome": "granted", "problems": [], "suppression": sup}


class Runner(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rel = pathlib.Path(self.tmp.name)
        self.doc = json.loads((ROOT / "policies" / "quality-gates.json").read_text(encoding="utf8"))

    def tearDown(self):
        self.tmp.cleanup()

    def stage(self, now=NOW, project="tableflux"):
        return runner.run_stage(self.rel, doc=self.doc, project=project, repo_type=None, stage="stable", changed_paths=[], checks=GOOD, findings=[FINDING], baseline=[], now=now)

    def test_without_a_waiver_the_new_critical_finding_blocks_stable(self):
        r = self.stage()
        self.assertEqual((r["status"], r["allowed"], r["appliedWaivers"]), ("evaluated", False, 0))

    def test_an_operator_waiver_allows_it_until_it_expires(self):
        (self.rel / "waiver-decisions.jsonl").write_text(json.dumps(granted()) + "\n", encoding="utf8")
        ok = self.stage()
        self.assertEqual((ok["allowed"], ok["appliedWaivers"]), (True, 1))
        self.assertFalse(self.stage(now=NOW + 8 * 86400)["allowed"])

    def test_a_waiver_for_another_project_does_not_apply(self):
        (self.rel / "waiver-decisions.jsonl").write_text(json.dumps(granted(project="other")) + "\n", encoding="utf8")
        self.assertFalse(self.stage()["allowed"])

    def test_a_paused_project_is_held_not_evaluated_and_never_reports_a_pass(self):
        (self.rel / "waiver-decisions.jsonl").write_text(json.dumps(granted()) + "\n", encoding="utf8")
        (self.rel / "holds.json").write_text(json.dumps({"schemaVersion": 1, "paused": ["tableflux"]}), encoding="utf8")
        r = self.stage()
        self.assertEqual((r["status"], r["allowed"]), ("held", False))
        self.assertNotIn("blockers", r)
        self.assertTrue(self.stage(project="other")["status"] == "evaluated")  # only the paused project is held

    def test_a_damaged_holds_file_pauses_nothing_and_a_damaged_waiver_log_grants_nothing(self):
        (self.rel / "holds.json").write_text("{nope", encoding="utf8")
        (self.rel / "waiver-decisions.jsonl").write_text("{broken\n", encoding="utf8")
        r = self.stage()
        self.assertEqual((r["status"], r["allowed"], r["appliedWaivers"]), ("evaluated", False, 0))

    def test_the_gate_decides_so_a_waiver_cannot_excuse_a_failed_required_check(self):
        (self.rel / "waiver-decisions.jsonl").write_text(json.dumps(granted()) + "\n", encoding="utf8")
        bad = {**GOOD, "test": {"status": "fail"}}
        r = runner.run_stage(self.rel, doc=self.doc, project="tableflux", repo_type=None, stage="stable", changed_paths=[], checks=bad, findings=[FINDING], baseline=[], now=NOW)
        self.assertFalse(r["allowed"])
        self.assertTrue(any(b["category"] == "test" for b in r["blockers"]))


if __name__ == "__main__":
    unittest.main()
