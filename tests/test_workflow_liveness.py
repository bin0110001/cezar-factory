import copy
import json
import unittest
from unittest import mock

from scripts.release import workflow_liveness as wl

CHECKS = ["c1"]


def f(fp, sev="high", crit="ac1"):
    return {"fingerprint": fp, "severity": sev, "criterionId": crit, "checkId": "c1"}


def ob(i, findings, h="h0"):
    return {"id": f"o{i}", "verified": True, "artifact": {"hash": h}, "findings": findings,
            "coverage": {"expected": CHECKS, "executed": CHECKS}}


def tr(a, b, o=None):
    t = {"from": a, "to": b}
    if o is not None:
        t["observation"] = o
    return t


def doc(**kw):
    d = {"schemaVersion": 1, "now": 1000, "state": "work"}
    d.update(kw)
    return d


class Liveness(unittest.TestCase):
    def test_new_issue_after_fixing_old_is_progress(self):
        d = doc(transitions=[tr("work", "verify", ob(1, [f("a"), f("b", crit="ac2")], "h1")),
                             tr("verify", "work", ob(2, [f("c", "low", "ac3")], "h2"))])
        r = wl.evaluate(d)
        self.assertEqual(r["status"], "progress")
        self.assertEqual(r["classes"], [])

    def test_unchanged_findings_stop_at_cap(self):
        hist = [tr("work", "verify", ob(i, [f("a")])) for i in range(1, 5)]
        r = wl.evaluate(doc(transitions=hist, policy={"maxUnchangedRounds": 3, "maxRepeatedEdge": 99}))
        self.assertEqual(r["status"], "stalled")
        self.assertIn("unchanged_findings", r["classes"])
        self.assertIn("LIVENESS_UNCHANGED_FINDINGS", r["reasonCodes"])
        r2 = wl.evaluate(doc(transitions=hist[:2], policy={"maxUnchangedRounds": 3}))
        self.assertNotIn("unchanged_findings", r2["classes"])

    def test_oscillation(self):
        A, B = [f("a")], [f("b", crit="ac2")]
        r = wl.evaluate(doc(transitions=[tr("w", "v", ob(1, A, "h1")), tr("v", "w", ob(2, B, "h2")), tr("w", "v", ob(3, A, "h3"))]))
        self.assertIn("oscillation", r["classes"])
        self.assertEqual(r["nextAction"], "escalate")
        self.assertEqual(r["witness"]["stalls"]["oscillation"]["cycleLength"], 2)

    def test_repeated_edge_cap_with_identical_state(self):
        hist = [tr("a", "b") for _ in range(3)]
        r = wl.evaluate(doc(transitions=hist, policy={"maxRepeatedEdge": 3}))
        self.assertIn("repeated_edge", r["classes"])
        self.assertEqual(r["witness"]["stalls"]["repeated_edge"]["edge"], ["a", "b"])

    def test_healthy_human_wait_not_escalated(self):
        r = wl.evaluate(doc(waits=[{"id": "w1", "kind": "human", "deadline": 2000}]))
        self.assertEqual(r["status"], "waiting")
        self.assertEqual(r["nextAction"], "none")
        self.assertEqual(r["classes"], [])

    def test_overdue_waits(self):
        r = wl.evaluate(doc(waits=[{"id": "h", "kind": "human", "deadline": 10, "owner": "bob"},
                                   {"id": "e", "kind": "external", "deadline": 10, "waitsFor": "webhook"}]))
        self.assertEqual(r["classes"], ["missing_external_event", "overdue_human_wait"])
        self.assertEqual(r["witness"]["stalls"]["missing_external_event"]["waitsFor"], "webhook")

    def test_wait_for_deadlock_and_join(self):
        r = wl.evaluate(doc(waits=[{"id": "parent", "kind": "child", "waitsFor": "child"},
                                   {"id": "child", "kind": "parent", "waitsFor": "parent"}],
                            joins=[{"id": "j", "requires": ["x", "y"], "satisfied": ["x"], "producers": {"y": False}}]))
        self.assertEqual(r["witness"]["stalls"]["wait_for_cycle"]["cycle"], ["child", "parent", "child"])
        self.assertEqual(r["witness"]["stalls"]["unsatisfiable_join"]["blockedOn"], ["y"])

    def test_starvation_lease_admission_dead_end(self):
        r = wl.evaluate(doc(capacity={"queued": 3, "running": 2, "slots": 2, "waitingSeconds": 2000},
                            lease={"id": "l", "held": True, "expiresAt": 500},
                            work=[{"id": "i1", "runnable": True, "admitted": False, "since": 0}],
                            graph={"states": {"work": {"outgoing": []}}}))
        self.assertEqual(r["classes"], ["capacity_starvation", "dead_end", "lost_lease"])
        # queue present means the unadmitted work is starvation, not a missing admission
        r2 = wl.evaluate(doc(work=[{"id": "i1", "runnable": True, "admitted": False, "since": 0}]))
        self.assertEqual(r2["witness"]["stalls"]["missing_admission"]["work"], ["i1"])

    def test_unknown_never_success(self):
        r = wl.evaluate(doc(execution={"sha": "b", "verifiedSha": "a"}, review={"expected": 3, "covered": 1}, verification={"present": False}))
        self.assertEqual(r["status"], "unknown")
        self.assertEqual(r["unknown"], ["LIVENESS_MISSING_VERIFICATION", "LIVENESS_PARTIAL_REVIEW_COVERAGE", "LIVENESS_STALE_SHA"])

    def test_child_reset_cannot_bypass_parent_budget(self):
        hist = [tr("a", "b", ob(i, [f(f"x{i}")], f"h{i}")) for i in range(1, 3)]
        r = wl.evaluate(doc(transitions=hist, policy={"maxRounds": 4}, children=[{"id": "c", "rounds": 1, "resets": 2}]))
        self.assertIn("budget_exhausted", r["classes"])
        self.assertEqual(r["budget"]["childRounds"], 3)
        r2 = wl.evaluate(doc(transitions=hist, policy={"maxRounds": 9}, children=[{"id": "c", "rounds": 1, "resets": 2, "budgetRounds": 2}]))
        self.assertEqual(r2["witness"]["stalls"]["budget_exhausted"]["childBudget"], [{"child": "c", "cap": 2}])

    def test_redaction_and_no_model_and_override(self):
        r = wl.evaluate(doc(waits=[{"id": "token=ghp_abcdefgh12345", "kind": "external", "deadline": 1, "waitsFor": "Bearer abcdefghijk123"}]))
        text = json.dumps(r)
        self.assertNotIn("ghp_abcdefgh12345", text)
        self.assertNotIn("abcdefghijk123", text)
        self.assertEqual(wl.authorize_action("none", r), r["nextAction"])  # model cannot waive the policy action
        self.assertEqual(wl.authorize_action("escalate", r), r["nextAction"])

    def test_deterministic_pure_and_versioned(self):
        d = doc(transitions=[tr("a", "b", ob(1, [f("a")])), tr("b", "a", ob(2, [f("a")]))])
        before = copy.deepcopy(d)
        with mock.patch("socket.socket", side_effect=AssertionError("network")):
            self.assertEqual(wl.evaluate(d), wl.evaluate(d))
        self.assertEqual(d, before)
        with self.assertRaises(ValueError):
            wl.evaluate({"schemaVersion": 2})


if __name__ == "__main__":
    unittest.main()
