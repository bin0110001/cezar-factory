import copy
import json
import unittest
from pathlib import Path

from scripts.release import verification_disposition as vd

ROOT = Path(__file__).resolve().parents[1]
POLICY = vd.load_policy(str(ROOT / "policies/verification.json"))


def run(stage="pr-dev", *outcomes, policy=POLICY):
    base = [{"check": "automation-catalog", "status": "pass"}]
    return vd.evaluate(policy, stage, base + list(outcomes))


def disp(result, check):
    return next(r for r in result["outcomes"] if r["check"] == check)


class Rules(unittest.TestCase):
    def test_accepted_existing_debt_continues(self):
        r = run("pr-dev", {"check": "lint", "status": "fail", "severity": "high", "accepted": True, "new": False})
        self.assertEqual((r["disposition"], disp(r, "lint")["reason"]), ("CONTINUE", "accepted-existing-debt"))

    def test_new_minor_finding_is_recorded(self):
        r = run("pr-dev", {"check": "lint", "status": "fail", "severity": "low", "new": True})
        self.assertEqual((r["disposition"], r["status"]), ("RECORD", "pass"))

    def test_new_focused_regression_blocks_while_debt_continues(self):
        r = run("pr-dev",
                {"check": "old", "status": "fail", "accepted": True, "new": False, "severity": "low"},
                {"check": "focused", "status": "fail", "regression": True, "new": True, "severity": "low"})
        self.assertEqual(disp(r, "old")["disposition"], "CONTINUE")
        self.assertEqual(disp(r, "focused")["disposition"], "BLOCK")
        self.assertEqual(r["disposition"], "BLOCK")

    def test_impacted_acceptance_regression_blocks_even_if_accepted(self):
        r = run("pr-dev", {"check": "ac", "status": "fail", "accepted": True, "new": False, "acceptanceImpacted": True})
        self.assertEqual(disp(r, "ac")["reason"], "acceptance-regression")
        self.assertEqual(r["disposition"], "BLOCK")

    def test_missing_coverage_is_unknown_not_pass(self):
        r = run("pr-dev", {"check": "cov", "status": "unknown"})
        self.assertEqual((r["disposition"], r["status"]), ("RECORD", "unknown"))

    def test_required_check_missing_or_unknown_blocks(self):
        self.assertEqual(vd.evaluate(POLICY, "stable", [])["disposition"], "BLOCK")
        r = vd.evaluate(POLICY, "stable", [{"check": "automation-catalog", "status": "unknown"}])
        self.assertEqual(r["disposition"], "BLOCK")

    def test_outage_retries_then_escalates(self):
        mx = POLICY["stageGates"]["pr-dev"]["maxOutageRetries"]
        for a in range(mx):
            r = run("pr-dev", {"check": "scan", "status": "outage", "attempt": a})
            self.assertEqual((r["disposition"], r["escalate"]), ("RETRY", False))
        r = run("pr-dev", {"check": "scan", "status": "outage", "attempt": mx})
        self.assertEqual((r["disposition"], r["escalate"]), ("BLOCK", True))

    def test_severity_threshold_is_per_stage(self):
        o = {"check": "sec", "status": "fail", "severity": "medium", "new": True}
        self.assertEqual(run("pr-dev", o)["disposition"], "RECORD")
        self.assertEqual(run("candidate", o)["disposition"], "BLOCK")

    def test_unrecognized_input_blocks(self):
        for o in ({"check": "x", "status": "weird"}, {"check": "x", "status": "fail", "severity": "huge"}):
            self.assertEqual(disp(run("pr-dev", o), "x")["reason"], "unrecognized-outcome")

    def test_unknown_stage_rejected(self):
        with self.assertRaises(vd.PolicyError):
            vd.evaluate(POLICY, "nope", [])

    def test_agent_summary_is_concise_and_ui_payload_counts(self):
        r = run("pr-dev", {"check": "lint", "status": "fail", "severity": "low", "new": True})
        s = vd.agent_summary(r)
        self.assertEqual(s.splitlines()[0], "pr-dev: RECORD (pass)")
        self.assertNotIn("automation-catalog", s)
        u = vd.ui_payload(r)
        self.assertEqual(u["counts"], {"CONTINUE": 1, "RECORD": 1, "RETRY": 0, "BLOCK": 0})
        json.dumps(u)


class Policy(unittest.TestCase):
    def test_shipped_policy_valid_and_matches_schema_shape(self):
        schema = json.loads((ROOT / "schemas/verification-policy.schema.json").read_text())
        for k in schema["required"]:
            self.assertIn(k, POLICY)
        self.assertEqual(set(POLICY["stageGates"]), set(vd.STAGES))

    def test_invalid_policies_rejected(self):
        for mut in (lambda p: p.pop("stageGates"), lambda p: p["stageGates"]["pr-dev"].update(blockAtOrAbove="x"),
                    lambda p: p["stageGates"]["pr-dev"].update(maxOutageRetries=99), lambda p: p.update(protectedPaths=[]),
                    lambda p: p["stageGates"]["pr-dev"].update(extra=1)):
            p = copy.deepcopy(POLICY)
            mut(p)
            self.assertTrue(vd.validate_policy(p))

    def test_policy_baseline_waiver_edits_rejected(self):
        for path in ("policies/verification.json", "baselines/lint.json", "waivers/a.json", "schemas/verification-policy.schema.json", "../x"):
            with self.assertRaises(vd.PolicyError, msg=path):
                vd.reject_implementation_change(POLICY, ["src/ok.py", path])
        vd.reject_implementation_change(POLICY, ["src/ok.py", "docs/a.md"])

    def test_baseline_promotion_policy_protects_verification_policy(self):
        bp = json.loads((ROOT / "policies/baseline-promotion.json").read_text())
        self.assertIn("policies/verification.json", bp["protectedPaths"])


if __name__ == "__main__":
    unittest.main()
