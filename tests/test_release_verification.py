import unittest

from scripts.release import release_verification as rv

SHA = "a" * 40
NOW = 1_000_000.0


def manifest(**over):
    args = dict(candidate_id="c1", revision=1, sha=SHA, config_hash="cfg1", asset_hash="as1", env_hash="env1", advisory_refresh="adv1",
                suites=[{"id": "unit", "required": True, "adapterVersion": "1", "selection": "all"},
                        {"id": "e2e", "required": True, "adapterVersion": "1", "selection": "all", "mandatoryFull": True},
                        {"id": "sca", "required": True, "adapterVersion": "1", "selection": "lockfiles", "advisoryBound": True, "expiresAfterHours": 24},
                        {"id": "lint", "required": False, "adapterVersion": "1", "selection": "all"}])
    args.update(over)
    return rv.build_manifest(**args)


def evidence(m, ids=("unit", "e2e", "sca", "lint"), status="passed", at=NOW):
    return [rv.evidence_record(m, i, status=status, at=at) for i in ids]


class Manifest(unittest.TestCase):
    def test_requires_a_full_sha_and_unique_suites(self):
        with self.assertRaises(ValueError):
            manifest(sha="dev")
        with self.assertRaises(ValueError):
            manifest(suites=[{"id": "a", "adapterVersion": "1"}, {"id": "a", "adapterVersion": "1"}])

    def test_manifest_hash_is_stable_and_change_sensitive(self):
        self.assertEqual(manifest()["manifestHash"], manifest()["manifestHash"])
        self.assertNotEqual(manifest()["manifestHash"], manifest(env_hash="env2")["manifestHash"])


class EvidenceValidity(unittest.TestCase):
    def test_exact_manifest_evidence_satisfies_the_gate(self):
        m = manifest()
        g = rv.gate(m, evidence(m), now=NOW + 5)
        self.assertEqual((g["eligible"], g["blocking"]), (True, []))
        self.assertTrue(all(r["satisfied"] for r in g["suites"].values()))

    def test_other_revision_or_sha_cannot_satisfy_promotion(self):
        old = manifest()
        rev2 = manifest(revision=2, sha="b" * 40)
        g = rv.gate(rev2, evidence(old), now=NOW + 5)
        self.assertFalse(g["eligible"])
        self.assertEqual(sorted(g["blocking"]), ["e2e", "sca", "unit"])
        self.assertIn("sha-changed", g["suites"]["unit"]["reason"])
        self.assertIn("revision-changed", g["suites"]["unit"]["reason"])

    def test_policy_suite_environment_and_adapter_changes_invalidate_the_right_evidence(self):
        base = manifest()
        ev = evidence(base)
        for change, expect in (({"config_hash": "cfg2"}, "configHash-changed"), ({"asset_hash": "as2"}, "assetHash-changed"), ({"env_hash": "env2"}, "envHash-changed")):
            g = rv.gate(manifest(**change), ev, now=NOW + 5)
            self.assertFalse(g["eligible"], change)
            self.assertIn(expect, g["suites"]["unit"]["reason"])
        changed_adapter = manifest(suites=[{"id": "unit", "required": True, "adapterVersion": "2", "selection": "all"}])
        self.assertIn("adapterVersion-changed", rv.gate(changed_adapter, ev, now=NOW + 5)["suites"]["unit"]["reason"])
        changed_selection = manifest(suites=[{"id": "unit", "required": True, "adapterVersion": "1", "selection": "subset"}])
        self.assertIn("selectionHash-changed", rv.gate(changed_selection, ev, now=NOW + 5)["suites"]["unit"]["reason"])

    def test_advisory_refresh_invalidates_only_advisory_bound_suites_with_unchanged_sha(self):
        m1, m2 = manifest(), manifest(advisory_refresh="adv2")
        self.assertEqual(m1["sha"], m2["sha"])
        g = rv.gate(m2, evidence(m1), now=NOW + 5)
        self.assertEqual(g["blocking"], ["sca"])
        self.assertIn("advisory-refreshed", g["suites"]["sca"]["reason"])
        self.assertTrue(g["suites"]["unit"]["satisfied"])

    def test_expiry_and_missing_evidence_fail_closed(self):
        m = manifest()
        g = rv.gate(m, evidence(m), now=NOW + 25 * 3600)
        self.assertEqual(g["blocking"], ["sca"])
        self.assertIn("expired", g["suites"]["sca"]["reason"])
        none = rv.gate(m, [], now=NOW)
        self.assertEqual(sorted(none["blocking"]), ["e2e", "sca", "unit"])
        self.assertTrue(all(r["reason"] == "no evidence" for r in none["suites"].values()))

    def test_optional_suite_failure_does_not_block_but_required_unknown_does(self):
        m = manifest()
        ev = evidence(m, ids=("unit", "e2e", "sca"), status="passed") + [rv.evidence_record(m, "lint", status="failed", at=NOW)]
        self.assertTrue(rv.gate(m, ev, now=NOW + 1)["eligible"])
        unknown_scan = evidence(m, ids=("unit", "e2e"), status="passed") + [rv.evidence_record(m, "sca", status="unknown", at=NOW)]
        g = rv.gate(m, unknown_scan, now=NOW + 1)
        self.assertEqual(g["blocking"], ["sca"])  # a scanner outage is not a pass

    def test_newest_valid_evidence_wins_but_a_stale_pass_does_not_mask_a_new_failure(self):
        m = manifest()
        ev = evidence(m, ids=("unit",), at=NOW) + [rv.evidence_record(m, "unit", status="failed", at=NOW + 10)]
        self.assertFalse(rv.gate(m, ev + evidence(m, ids=("e2e", "sca")), now=NOW + 20)["suites"]["unit"]["satisfied"])


class Classification(unittest.TestCase):
    def test_outcomes(self):
        ok = {"status": "passed"}
        fail = {"status": "failed", "failures": ["t1"]}
        self.assertEqual(rv.classify([ok])["classification"], "passed")
        self.assertEqual(rv.classify([fail, ok])["classification"], "flaky")
        self.assertEqual(rv.classify([fail], known_debt=frozenset({"t1"}))["classification"], "known-debt")
        r = rv.classify([fail])
        self.assertEqual((r["classification"], r["rerun"]), ("regression", True))
        self.assertEqual(rv.classify([fail, fail, fail])["rerun"], False)  # bounded
        infra = {"status": "failed", "failures": [], "log": "worker lost: connection reset"}
        self.assertEqual(rv.classify([infra])["classification"], "infra-failure")
        self.assertTrue(rv.classify([infra])["rerun"])
        spent = rv.classify([infra, infra, infra])
        self.assertEqual((spent["classification"], spent["rerun"]), ("unknown", False))  # never a pass
        self.assertEqual(rv.classify([])["classification"], "unknown")

    def test_known_debt_only_counts_when_policy_accepts_it(self):
        m = manifest()
        ev = evidence(m, ids=("e2e", "sca"))
        debt = rv.evidence_record(m, "unit", status="failed", at=NOW, classification="known-debt")
        self.assertFalse(rv.gate(m, ev + [debt], now=NOW + 1)["eligible"])
        self.assertTrue(rv.gate(m, ev + [debt], now=NOW + 1, accept_known_debt=True)["eligible"])


class Incremental(unittest.TestCase):
    IMPACT = {"unit": ["src/**"], "lint": ["src/**", "docs/**"], "sca": ["package-lock.json"], "e2e": ["src/**"]}

    def plan(self, new, changed, impact=None, prior=None, prev=None):
        prev = prev or manifest()
        return rv.plan_revalidation(prev, new, changed_paths=changed, impact=impact or self.IMPACT, prior_evidence=prior if prior is not None else evidence(prev), now=NOW + 1)

    def test_provably_unaffected_suites_are_reused_and_mandatory_full_never_skipped(self):
        new = manifest(revision=2, sha="b" * 40)
        plan = self.plan(new, ["docs/readme.md"])
        self.assertEqual(plan["unit"]["action"], "reuse")
        self.assertEqual(plan["sca"]["action"], "reuse")
        self.assertEqual(plan["lint"]["action"], "run")  # docs impact lint
        self.assertEqual(plan["e2e"], {"action": "run", "reason": "mandatory full regression is never skipped"})

    def test_unmapped_paths_policy_changes_and_missing_prior_results_force_a_full_run(self):
        new = manifest(revision=2, sha="b" * 40)
        self.assertEqual(self.plan(new, ["scripts/new.sh"])["unit"]["action"], "run")
        self.assertIn("not covered", self.plan(new, ["scripts/new.sh"])["unit"]["reason"])
        self.assertEqual(self.plan(manifest(revision=2, sha="b" * 40, env_hash="env2"), ["docs/a.md"])["unit"]["action"], "run")
        self.assertEqual(self.plan(new, ["docs/a.md"], prior=[])["unit"]["reason"], "no valid passing prior result")
        refreshed = manifest(revision=2, sha="b" * 40, advisory_refresh="adv2")
        self.assertEqual(self.plan(refreshed, ["docs/a.md"])["sca"]["reason"], "advisory data refreshed")


class ShardsAndNodes(unittest.TestCase):
    def test_resume_runs_only_missing_failed_or_invalid_shards(self):
        m = manifest()
        other = manifest(env_hash="env2")
        done = {"s1": rv.evidence_record(m, "unit", status="passed", at=NOW), "s2": rv.evidence_record(m, "unit", status="failed", at=NOW),
                "s4": rv.evidence_record(other, "unit", status="passed", at=NOW)}
        self.assertEqual(rv.resume_plan(["s1", "s2", "s3", "s4"], done, m, NOW + 1), ["s2", "s3", "s4"])

    def test_mixed_nodes_must_share_sha_and_resources_and_not_use_mutable_refs(self):
        good = [{"node": "a", "sha": SHA, "revision": 1, "resourceDigest": "r", "assetHash": "x", "envHash": "e", "checkout": SHA},
                {"node": "b", "sha": SHA, "revision": 1, "resourceDigest": "r", "assetHash": "x", "envHash": "e", "checkout": SHA}]
        self.assertEqual(rv.assert_uniform(good), [])
        drift = [good[0], {**good[1], "sha": "c" * 40, "resourceDigest": "r2", "checkout": "dev"}]
        problems = rv.assert_uniform(drift)
        self.assertTrue(any(p.startswith("sha differs") for p in problems))
        self.assertTrue(any("resourceDigest differs" in p for p in problems))
        self.assertTrue(any("mutable ref" in p for p in problems))

    def test_cache_hits_only_on_the_identical_key_and_expires(self):
        m = manifest()
        cache = rv.EvidenceCache()
        cache.put(rv.evidence_record(m, "unit", status="passed", at=NOW), ttl_seconds=100, now=NOW)
        self.assertIsNotNone(cache.get(m, "unit", now=NOW + 50))
        self.assertIsNone(cache.get(m, "unit", now=NOW + 150))
        self.assertIsNone(cache.get(manifest(env_hash="env2"), "unit", now=NOW + 50))
        self.assertIsNone(cache.get(manifest(sha="b" * 40), "unit", now=NOW + 50))


if __name__ == "__main__":
    unittest.main()
