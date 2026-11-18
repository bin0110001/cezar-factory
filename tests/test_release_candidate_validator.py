import json
import os
import pathlib
import tempfile
import unittest

from scripts.release import release_candidate_validator as val
from scripts.release.release_candidate_store import CandidateStore, StoreError

ROOT = pathlib.Path(__file__).resolve().parents[1]
NOW = 1_800_000_000.0
GOOD = {"lint": {"status": "pass"}, "type": {"status": "pass"}, "test": {"status": "pass"}, "sca": {"status": "pass"}, "secrets": {"status": "pass"}}  # what the policy requires at the candidate stage
FINDING = {"fingerprint": "a" * 64, "category": "sca", "severity": "critical", "advisoryId": "CVE-2021-0001", "path": "package-lock.json", "fixAvailable": True}


class Validator(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rel = pathlib.Path(self.tmp.name) / "release"
        self.rel.mkdir()
        self.store = CandidateStore(os.path.join(self.tmp.name, "c.db"))
        self.doc = json.loads((ROOT / "policies" / "quality-gates.json").read_text(encoding="utf8"))
        self.cid = self.validating_candidate()

    def tearDown(self):
        self.tmp.cleanup()

    def validating_candidate(self, project="tableflux"):
        cid = self.store.request(project, trigger="manual", reason="x", dev_sha="a" * 40, base_stable_sha="b" * 40, config_hash="sha256:" + "c" * 64, now=NOW)["candidateId"]
        fencing = self.store.acquire(cid, "worker-1", now=NOW, ttl=600)
        for to in ("admitted", "snapshotting", "validating"):
            self.store.transition(cid, to, fencing=fencing, version=self.store.get(cid)["version"], now=NOW, actor="worker-1")
        return cid

    def validate(self, **over):
        args = dict(owner="worker-1", ttl=600, now=NOW + 1, release_dir=self.rel, policy_doc=self.doc, test_status="passed", checks=GOOD, findings=[], baseline=[])
        args.update(over)
        return val.validate_candidate(self.store, self.cid, **args)

    def test_green_tests_and_an_allowing_gate_make_the_candidate_ready_with_one_passed_result(self):
        r = self.validate()
        self.assertEqual((r["status"], r["state"], r["blockers"]), ("ready", "ready", []))
        self.assertEqual(self.store.get(self.cid)["state"], "ready")

    def test_a_failed_test_run_sends_the_candidate_to_repair_never_ready(self):
        for status in ("failed", "no-tests", "unknown", "infrastructure-error"):
            tmp_cid = self.validating_candidate(project=f"p-{status}")
            r = val.validate_candidate(self.store, tmp_cid, owner="worker-1", ttl=600, now=NOW + 1, release_dir=self.rel, policy_doc=self.doc,
                                       test_status=status, checks=GOOD, findings=[], baseline=[])
            self.assertEqual(r["status"], "repair-required", status)
            self.assertIn(f"tests: {status}", r["blockers"])

    def test_a_blocking_gate_result_sends_it_to_repair_even_when_tests_pass(self):
        r = self.validate(checks={**GOOD, "sca": {"status": "fail"}})
        self.assertEqual(r["status"], "repair-required")
        self.assertTrue(any(x.startswith("sca: fail") for x in r["blockers"]), r["blockers"])
        self.assertEqual(self.store.get(self.cid)["state"], "repair-required")

    def test_a_required_check_with_no_result_never_passes_the_candidate(self):
        checks = {k: v for k, v in GOOD.items() if k != "sca"}
        r = self.validate(checks=checks)
        self.assertEqual(r["status"], "repair-required")
        self.assertIn("sca: unknown", r["blockers"][0])

    def test_an_operator_waiver_never_excuses_a_failed_required_check_at_the_candidate_gate(self):
        bad = {**GOOD, "sca": {"status": "fail"}}
        self.assertEqual(self.validate(checks=bad, findings=[FINDING])["status"], "repair-required")
        cid2 = self.validating_candidate(project="waived")
        sup = {"fingerprint": FINDING["fingerprint"], "grantedByKind": "operator", "grantedBy": "local-operator", "grantedAt": NOW - 60, "expiresAt": NOW + 86400,
               "reason": "vendor patch pending", "receiptId": "exc-1", "scope": {"project": "waived", "stages": ["candidate"]}}
        (self.rel / "waiver-decisions.jsonl").write_text(json.dumps({"requestId": "w1", "projectId": "waived", "outcome": "granted", "suppression": sup}) + "\n", encoding="utf8")
        # the waiver excuses the finding but a failed required check still blocks, so the candidate does not go ready on a waiver alone
        r = val.validate_candidate(self.store, cid2, owner="worker-1", ttl=600, now=NOW + 1, release_dir=self.rel, policy_doc=self.doc, test_status="passed",
                                   checks=bad, findings=[FINDING], baseline=[])
        self.assertEqual(r["status"], "repair-required")

    def test_a_paused_project_is_held_with_no_lease_result_or_state_change(self):
        (self.rel / "holds.json").write_text(json.dumps({"schemaVersion": 1, "paused": ["tableflux"]}), encoding="utf8")
        before = self.store.get(self.cid)
        r = self.validate()
        self.assertEqual(r["status"], "held")
        after = self.store.get(self.cid)
        self.assertEqual((after["state"], after["version"], after["fencing"]), (before["state"], before["version"], before["fencing"]))

    def test_only_a_validating_candidate_can_be_validated_and_a_replay_is_refused(self):
        self.validate()
        with self.assertRaises(StoreError):
            self.validate(now=NOW + 2)  # already ready
        with self.assertRaises(StoreError):
            self.validate(test_status="bogus")

    def test_a_stale_owner_is_refused_while_another_holds_the_lease(self):
        self.store.acquire(self.cid, "worker-1", now=NOW, ttl=600)
        with self.assertRaises(StoreError):
            self.validate(owner="worker-2", now=NOW + 5)
        self.assertEqual(self.store.get(self.cid)["state"], "validating")

    def test_the_evidence_is_the_redacted_gate_receipt(self):
        self.validate(checks={**GOOD, "secrets": {"status": "pass"}})
        db_rows = [r for r in self.store.audit_log("tableflux") if r["event"] == "result"]
        self.assertEqual(len(db_rows), 1)
        self.assertEqual(json.loads(db_rows[0]["detail"])["status"], "passed")


if __name__ == "__main__":
    unittest.main()
