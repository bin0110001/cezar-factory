import copy
import json
import pathlib
import unittest

from scripts.release import verification_progression as vp

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOC = json.loads((ROOT / "policies" / "verification-coverage.json").read_text(encoding="utf8"))
BLOCKED = "blocked"


def run(counts, stage, **kw):
    kw.setdefault("coverage", 100)
    return vp.evaluate(DOC, stage, counts, **kw)


class Policy(unittest.TestCase):
    def test_shipped_policy_valid_and_maps_to_existing_stages(self):
        self.assertEqual(vp.validate(DOC), [])
        self.assertEqual(DOC["stageMap"], {"iteration": "pr-dev", "merge": "candidate", "release": "stable"})
        vdoc = json.loads((ROOT / "policies" / "verification.json").read_text(encoding="utf8"))
        self.assertTrue(set(DOC["stageMap"].values()) <= set(vdoc["dispositionRules"]["stages"]))

    def test_ordering_and_bounds_rejected(self):
        bad = copy.deepcopy(DOC)
        bad["stages"]["merge"]["minCoverage"] = 40
        self.assertTrue(any("merge.minCoverage" in e for e in vp.validate(bad)))
        bad = copy.deepcopy(DOC)
        bad["stages"]["release"]["blockKnownDebt"] = False
        bad["stages"]["merge"]["blockKnownDebt"] = True
        self.assertTrue(any("release.blockKnownDebt" in e for e in vp.validate(bad)))
        bad = copy.deepcopy(DOC)
        bad["stages"]["iteration"]["minCoverage"] = 101
        self.assertTrue(vp.validate(bad))
        self.assertEqual(vp.evaluate(bad, "iteration", {}, coverage=100)["decision"], BLOCKED)


class Matrix(unittest.TestCase):
    def test_known_debt_continues_iteration_and_merge_but_blocks_release(self):
        c = {"known": 3}
        self.assertEqual(run(c, "iteration")["decision"], "continue")
        self.assertEqual(run(c, "merge")["decision"], "merge-ok")
        self.assertEqual(run(c, "release")["decision"], BLOCKED)
        self.assertFalse(run(c, "iteration")["green"])

    def test_clean_result_is_green_everywhere(self):
        for s in vp.STAGES:
            r = run({"resolved": 2}, s)
            self.assertEqual((r["decision"], r["green"]), (vp.OK_DECISION[s], True))

    def test_impacted_regression_stops_every_stage(self):
        for d in vp.REGRESSIONS:
            for s in vp.STAGES:
                self.assertEqual(run({d: 1}, s, impacted_regressions=1)["decision"], BLOCKED, (d, s))

    def test_non_impacted_regression_only_stops_stricter_stages(self):
        self.assertEqual(run({"new": 1}, "iteration")["decision"], "continue")
        self.assertEqual(run({"new": 1}, "merge")["decision"], BLOCKED)
        self.assertEqual(run({"new": 1}, "release")["decision"], BLOCKED)
        self.assertFalse(run({"new": 1}, "iteration")["green"])

    def test_untested_unknown_infra_never_green(self):
        for d in vp.NEVER_GREEN:
            for s in vp.STAGES:
                r = run({d: 1}, s)
                self.assertEqual((r["decision"], r["green"]), (BLOCKED, False), (d, s))

    def test_unrecognised_disposition_and_unknown_coverage_never_green(self):
        for s in vp.STAGES:
            self.assertEqual(run({"mystery": 1}, s)["decision"], BLOCKED)
            self.assertEqual(run({}, s, coverage=None)["decision"], BLOCKED)

    def test_strictness_never_loosens(self):
        for counts, imp in ({"known": 1}, 0), ({"new": 1}, 0), ({"new": 1}, 1), ({"untested": 1}, 0), ({}, 0):
            r = vp.evaluate_all(DOC, counts, impacted_regressions=imp, coverage=100)
            blocked = [r[s]["decision"] == BLOCKED for s in vp.STAGES]
            self.assertEqual(blocked, sorted(blocked), counts)  # once blocked, stays blocked


class Thresholds(unittest.TestCase):
    def test_boundaries_per_stage(self):
        for s in vp.STAGES:
            t = DOC["stages"][s]["minCoverage"]
            self.assertEqual(run({}, s, coverage=t - 0.01)["decision"], BLOCKED, s)
            self.assertEqual(run({}, s, coverage=t)["decision"], vp.OK_DECISION[s], s)
            self.assertEqual(run({}, s, coverage=t + 0.01)["decision"], vp.OK_DECISION[s], s)

    def test_same_coverage_differs_by_stage(self):
        r = vp.evaluate_all(DOC, {}, coverage=75)
        self.assertEqual([r[s]["decision"] for s in vp.STAGES], ["continue", "merge-ok", BLOCKED])


if __name__ == "__main__":
    unittest.main()
