import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("repair_receipts", ROOT / "scripts" / "repair" / "repair_receipts.py")
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)
CANARY = "ghp_" + "a" * 30


def rec(attempt=1, outcome="fixed", **kw):
    r = {"sessionRef": "x", "attempt": attempt, "inputRevision": "a", "outputRevision": "b",
         "findings": {"fixed": ["r1"], "new": [], "persistent": []}, "strategy": "targeted", "actor": "coordinator",
         "policy": {"maxRounds": 5}, "evidenceRefs": ["e1"], "outcome": outcome, "stopReason": "done"}
    r.update(kw)
    return r


class RepairReceiptTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.root = self.d.name

    def tearDown(self):
        self.d.cleanup()

    def test_crash_replay_does_not_resend_or_spend(self):
        first = rr.reserve_attempt(self.root, "run1", 1, "sess-secret", "coord", now=100)
        self.assertEqual((first["status"], first["sendTurn"]), ("reserved", True))
        again = rr.reserve_attempt(self.root, "run1", 1, "sess-secret", "coord", now=101)
        self.assertEqual((again["status"], again["sendTurn"], again["spendBudget"]), ("in-progress", False, False))
        rr.complete_attempt(self.root, "run1", first, rec(), now=102)
        replay = rr.reserve_attempt(self.root, "run1", 1, "sess-secret", "coord", now=500)
        self.assertEqual((replay["status"], replay["sendTurn"], replay["spendBudget"]), ("replay", False, False))
        self.assertEqual(len(rr.read_receipts(self.root, "run1", now=103)), 1)

    def test_unsupported_resume_blocks_without_replacement(self):
        r = rr.reserve_attempt(self.root, "run2", 1, "s", "coord", now=1, resume_supported=False)
        self.assertEqual((r["status"], r["reason"], r["sendTurn"]), ("blocked", "resume-unsupported", False))
        self.assertEqual(r["receipt"]["outcome"], "blocked")

    def test_expired_lease_marks_stale_not_resend(self):
        rr.reserve_attempt(self.root, "run3", 1, "s", "coord", now=0, lease_seconds=10)
        r = rr.reserve_attempt(self.root, "run3", 1, "s", "coord", now=60)
        self.assertEqual((r["status"], r["sendTurn"], r["receipt"]["outcome"]), ("blocked", False, "stale-timeout"))

    def test_receipt_append_only_redacted_opaque(self):
        r = rr.append_receipt(self.root, "run4", rec(evidenceRefs=["token=" + CANARY]), now=1)
        self.assertNotIn(CANARY, str(r))
        self.assertTrue(rr.opaque_session_ref("sess-secret").startswith("sess_"))
        dup = rr.append_receipt(self.root, "run4", rec(strategy="other"), now=2)
        self.assertEqual(dup["strategy"], "targeted")
        with self.assertRaises(rr.RepairError):
            rr.append_receipt(self.root, "run4", {"attempt": 1})

    def test_read_model_classification(self):
        for outcome, state in (("validator-error", "validator-error"), ("implementation-failed", "unsuccessful-implementation"),
                               ("governance-stop", "governance-stop"), ("running", "running")):
            rid = "c-" + outcome
            rr.append_receipt(self.root, rid, rec(outcome=outcome, stopReason="why"), now=100)
            self.assertEqual(rr.read_model(self.root, rid, now=110)["state"], state)
        self.assertEqual(rr.read_model(self.root, "c-running", now=5000)["state"], "stale-timeout")
        m = rr.read_model(self.root, "c-governance-stop", now=110)
        self.assertEqual((m["roundsLabel"], m["stopReason"]), ("1/5", "why"))

    def test_history_collapsed_and_retention(self):
        rr.append_receipt(self.root, "h", rec(1, "no-progress"), now=0)
        rr.append_receipt(self.root, "h", rec(2, "fixed"), now=100)
        m = rr.read_model(self.root, "h", now=200)
        self.assertTrue(m["history"]["collapsed"])
        self.assertEqual(m["history"]["count"], 1)
        old = rr.read_model(self.root, "h", now=200 + 91 * 86400)
        self.assertEqual(old["state"], "none")

    def test_counters(self):
        rr.append_receipt(self.root, "k", rec(1, "no-progress", findings={"fixed": [], "new": [], "persistent": ["ruleA"]},
                                              metrics={"durationSeconds": 2, "tokens": 10, "cacheReadTokens": 4}), now=1)
        rr.append_receipt(self.root, "k", rec(2, "fixed", metrics={"durationSeconds": 3, "tokens": 5}), now=2)
        c = rr.counters(self.root, ["k", "missing"], now=3)
        self.assertEqual((c["repairRuns"], c["repairSuccess"], c["noProgress"], c["tokens"], c["cacheReadTokens"]), (1, 1, 1, 15, 4))
        self.assertEqual(c["perRuleRecurrence"], {"ruleA": 1})

    def test_operator_action_authorized_and_audited(self):
        deny = rr.operator_action(self.root, "o", "recover", "bob", {"authenticated": True, "roles": ["viewer"]}, "x")
        self.assertEqual(deny["reason"], "not-authorized")
        gov = rr.operator_action(self.root, "o", "replan", "bob", {"authenticated": True, "roles": ["operator"]}, "x", policy_allows=False)
        self.assertEqual(gov["reason"], "governance-stop")
        ok = rr.operator_action(self.root, "o", "recover", "bob", {"authenticated": True, "roles": ["operator"]}, "token=" + CANARY)
        self.assertEqual(ok["status"], "accepted")
        self.assertFalse(ok["startsReplacementAgent"])
        self.assertNotIn(CANARY, str(ok))


if __name__ == "__main__":
    unittest.main()
