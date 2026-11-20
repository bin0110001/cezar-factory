import copy
import random
import unittest

from scripts.release import progress_evaluator as pe

CHECKS = ["c1", "c2"]


def f(fp, sev="high", crit="ac1", check="c1"):
    return {"fingerprint": fp, "severity": sev, "criterionId": crit, "checkId": check}


def ob(i, findings, h="h0", verified=True, executed=None, expected=None):
    return {"id": f"o{i}", "verified": verified, "artifact": {"hash": h}, "findings": findings,
            "coverage": {"expected": CHECKS if expected is None else expected, "executed": CHECKS if executed is None else executed}}


class Table(unittest.TestCase):
    def cls(self, hist, **kw):
        return pe.evaluate(hist, **kw)

    def test_table(self):
        A, B, C = [f("a")], [f("b", crit="ac2")], [f("c", crit="ac3")]
        rows = [
            ("stagnation_same_set_same_hash", [ob(1, A), ob(2, A)], "stagnation", "artifact_unchanged"),
            ("stale_artifact", [ob(1, A, "h1"), ob(2, A, "h1")], "stagnation", "artifact_unchanged"),
            ("changed_artifact_no_improvement", [ob(1, A, "h1"), ob(2, A, "h2")], "stagnation", "artifact_changed"),
            ("new_fp_replaces_equal_severity", [ob(1, A), ob(2, [f("a2")])], "stagnation", "new_fingerprint_not_progress"),
            ("severity_regression", [ob(1, [f("a", "low")]), ob(2, [f("a", "critical")])], "regression", "severity_increase"),
            ("net_progress", [ob(1, A + B), ob(2, A)], "net_progress", "findings_resolved"),
            ("mixed_progress", [ob(1, [f("a"), f("b", crit="ac2")]), ob(2, [f("n", "low", "ac4")])], "mixed_progress", "new_findings_introduced"),
            ("partial_progress_severity", [ob(1, [f("a", "critical")]), ob(2, [f("a", "low")])], "partial_progress", "severity_decreased"),
            ("resolved", [ob(1, A), ob(2, [])], "resolved", "no_blocking_findings"),
            ("oscillation_ABA", [ob(1, A), ob(2, B), ob(3, A)], "oscillation", "cycle_length_2"),
            ("oscillation_ABCA", [ob(1, A), ob(2, B), ob(3, C), ob(4, A)], "oscillation", "cycle_length_3"),
            ("masked_finding", [ob(1, A), ob(2, [], executed=["c2"])], "inconclusive", "coverage_reduced"),
            ("missing_expected", [ob(1, A), ob(2, [], executed=["c2"], expected=CHECKS)], "inconclusive", "expected_checks_not_executed"),
            ("unverified", [ob(1, A), ob(2, [], verified=False)], "inconclusive", "not_verified"),
            ("first_observation_with_findings", [ob(1, A)], "inconclusive", "no_previous_observation"),
            ("first_observation_clean", [ob(1, [])], "resolved", "no_blocking_findings"),
            ("reopened", [ob(1, [f("a"), f("b", "medium", "ac2")]), ob(2, A), ob(3, [f("b", "medium", "ac2")])], "regression", "finding_reopened"),
            ("criterion_regressed", [ob(1, A), ob(2, B), ob(3, [f("z", "high", "ac1")])], "regression", "acceptance_criterion_regressed"),
        ]
        for name, hist, cls, reason in rows:
            with self.subTest(name):
                r = self.cls(hist)
                self.assertEqual(r["classification"], cls, r)
                self.assertIn(reason, r["reasonCodes"])
                self.assertTrue(r["evidenceRefs"])
                self.assertIn(cls, pe.CLASSIFICATIONS)

    def test_coverage_reduction_never_progress(self):
        r = self.cls([ob(1, [f("a"), f("b")]), ob(2, [], executed=["c1"])])
        self.assertEqual(r["classification"], "inconclusive")
        self.assertNotIn(r["classification"], ("resolved", "net_progress", "mixed_progress", "partial_progress"))

    def test_best_only_verified(self):
        hist = [ob(1, [f("a")]), ob(2, [], verified=False, executed=[]), ob(3, [f("a")])]
        r = self.cls(hist)
        self.assertEqual(r["bestObservation"], "o1")
        self.assertEqual(r["bestComparison"], "equal")

    def test_worse_than_best_reported(self):
        r = self.cls([ob(1, [f("a", "low")]), ob(2, [f("a"), f("b", crit="ac2")]), ob(3, [f("z", crit="ac9")])])
        self.assertEqual(r["bestComparison"], "worse")
        self.assertIn("worse_than_best_verified", r["reasonCodes"])

    def test_accepted_visible_not_blocking(self):
        r = self.cls([ob(1, [f("a"), f("k")]), ob(2, [f("k")])], accepted_fingerprints=["k"])
        self.assertEqual(r["classification"], "resolved")
        self.assertEqual(r["acceptedVisible"], ["k"])

    def test_no_progress_counter(self):
        h = [ob(1, [f("a"), f("b")]), ob(2, [f("a")]), ob(3, [f("a")], "h1"), ob(4, [f("a")], "h2")]
        r = self.cls(h)
        self.assertEqual(r["consecutiveNoProgress"], 2)
        self.assertTrue(r["persistenceAllowed"])

    def test_empty_history_rejected(self):
        with self.assertRaises(ValueError):
            pe.evaluate([])


class Property(unittest.TestCase):
    def rand_hist(self, rng):
        pool = [f(f"fp{i}", rng.choice(list(pe.SEVERITY_WEIGHT)), f"ac{i % 3}") for i in range(6)]
        n = rng.randint(1, 6)
        hist = []
        for i in range(n):
            fs = rng.sample(pool, rng.randint(0, 4))
            ex = CHECKS if rng.random() < 0.8 else ["c1"]
            hist.append(ob(i, fs, rng.choice(["h0", "h1"]), rng.random() < 0.9, ex))
        return hist

    def test_deterministic_and_pure(self):
        rng = random.Random(739)
        for _ in range(200):
            h = self.rand_hist(rng)
            snap = copy.deepcopy(h)
            self.assertEqual(pe.evaluate(h), pe.evaluate(h))
            self.assertEqual(h, snap)

    def test_order_independent_findings(self):
        rng = random.Random(7)
        for _ in range(200):
            h = self.rand_hist(rng)
            h2 = copy.deepcopy(h)
            for o in h2:
                rng.shuffle(o["findings"])
                o["coverage"]["executed"] = list(reversed(o["coverage"]["executed"]))
            self.assertEqual(pe.evaluate(h), pe.evaluate(h2))

    def test_incomplete_coverage_never_progress(self):
        rng = random.Random(11)
        for _ in range(300):
            h = self.rand_hist(rng)
            r = pe.evaluate(h)
            cur = h[-1]
            if not cur["verified"] or set(cur["coverage"]["executed"]) < set(cur["coverage"]["expected"]):
                self.assertEqual(r["classification"], "inconclusive")

    def test_resolved_only_when_no_blocking(self):
        rng = random.Random(3)
        for _ in range(300):
            h = self.rand_hist(rng)
            r = pe.evaluate(h)
            if r["classification"] == "resolved":
                self.assertEqual(r["blockingCount"], 0)


if __name__ == "__main__":
    unittest.main()
