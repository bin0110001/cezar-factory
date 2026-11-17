import copy
import json
import pathlib
import unittest

from scripts.release import release_pipeline_config as rp

ROOT = pathlib.Path(__file__).resolve().parents[1]
WEEKLY = {"preset": "weekly-calendar", "triggers": {"schedule": {"dayOfWeek": "thursday", "hour": 3}},
          "tests": {"suites": ["unit"], "required": ["unit"]}}


def doc(**projects):
    return {"schemaVersion": rp.SCHEMA_VERSION, "defaults": {}, "projects": projects}


class Defaults(unittest.TestCase):
    def test_empty_project_keeps_legacy_two_stage_behaviour(self):
        spec = rp.effective_config(doc(legacy={}), "legacy")
        self.assertEqual(spec["mode"], "two-branch")
        self.assertEqual([s["branch"] for s in spec["stages"]], ["dev", "stable"])
        self.assertEqual((spec["promotion"]["review"], spec["promotion"]["stable"]), ("approval", "approval"))

    def test_presets_do_not_assume_hour_or_day(self):
        bare = doc(t={"preset": "weekly-calendar", "tests": {"suites": ["u"], "required": ["u"]}})
        errors = rp.validate_document(bare)
        self.assertTrue(any("schedule.hour: required" in e for e in errors), errors)
        self.assertTrue(any("dayOfWeek" in e for e in errors), errors)

    def test_both_presets_resolve_by_config_only(self):
        d = doc(tableflux=WEEKLY, factory={"preset": "daily-calendar", "triggers": {"schedule": {"hour": 4}},
                                           "tests": {"suites": ["full"], "required": ["full"]}})
        weekly, daily = rp.effective_config(d, "tableflux"), rp.effective_config(d, "factory")
        self.assertEqual(weekly["triggers"]["schedule"]["timezone"], "America/Detroit")
        self.assertEqual(weekly["triggers"]["schedule"]["frequency"], "weekly")
        self.assertEqual(daily["triggers"]["schedule"]["frequency"], "daily")
        self.assertEqual(weekly["mode"], daily["mode"])

    def test_committed_example_is_valid(self):
        example = json.loads((ROOT / "config" / "release-pipeline.example.json").read_text(encoding="utf8"))
        self.assertEqual(rp.validate_document(example), [])
        self.assertEqual(rp.effective_config(example, "legacy-project")["mode"], "two-branch")


class Validation(unittest.TestCase):
    def errors(self, **project):
        return rp.validate_document(doc(p=project))

    def test_unknown_fields_name_their_path_and_extensions_are_allowed(self):
        errs = self.errors(promotion={"stable": "approval", "bogus": 1})
        self.assertTrue(any(e.startswith("projects.p.promotion.bogus: unknown field") for e in errs), errs)
        self.assertEqual(self.errors(**{"x-note": "kept"}), [])

    def test_future_schema_version_is_refused(self):
        errs = rp.validate_document({"schemaVersion": "release-pipeline/v2", "projects": {}})
        self.assertTrue(errs and "newer than this reader" in errs[0])
        self.assertTrue(rp.validate_document({"schemaVersion": "nope"}))

    def test_branch_ref_collision_and_unsafe_names(self):
        stages = [{"id": "dev", "branch": "main", "kind": "integration"}, {"id": "stable", "branch": "main", "kind": "stable"}]
        self.assertTrue(any("collision" in e for e in self.errors(stages=stages)))
        bad = [{"id": "dev", "branch": "../x", "kind": "integration"}, {"id": "stable", "branch": "stable", "kind": "stable"}]
        self.assertTrue(any("safe branch" in e for e in self.errors(stages=bad)))

    def test_mode_must_match_stage_graph(self):
        self.assertTrue(any("three-branch requires" in e for e in self.errors(mode="three-branch")))

    def test_missing_and_undeclared_suites(self):
        errs = self.errors(tests={"suites": ["a"], "required": ["b"]})
        self.assertTrue(any("not declared" in e for e in errs), errs)
        errs3 = rp.validate_document(doc(p={"preset": "weekly-calendar", "triggers": {"schedule": {"dayOfWeek": "monday", "hour": 1}}}))
        self.assertTrue(any("required suite" in e for e in errs3), errs3)

    def test_unsafe_auto_promotion(self):
        self.assertTrue(any("unsafe auto-promotion" in e for e in self.errors(promotion={"review": "self-review", "stable": "auto"})))
        ok = self.errors(promotion={"review": "self-review", "stable": "auto"}, tests={"suites": ["s"], "required": ["s"]})
        self.assertEqual(ok, [])

    def test_schedule_problems(self):
        base = copy.deepcopy(WEEKLY)
        for change, needle in (
            ({"hour": 25}, "hour: must be 0-23"), ({"timezone": "Mars/Base"}, "unknown timezone"),
            ({"frequency": "hourly"}, "frequency"),
        ):
            d = copy.deepcopy(base)
            d["triggers"]["schedule"].update(change)
            d["triggers"]["schedule"].setdefault("timezone", "America/Detroit")
            errs = rp.validate_document(doc(p=d))
            self.assertTrue(any(needle in e for e in errs), (change, errs))
        daily = {"preset": "daily-calendar", "triggers": {"schedule": {"hour": 1, "dayOfWeek": "monday"}}, "tests": {"suites": ["s"], "required": ["s"]}}
        self.assertTrue(any("contradicts a daily" in e for e in rp.validate_document(doc(p=daily))))

    def test_contradictory_policy(self):
        self.assertTrue(any("maxActiveCandidates" in e for e in self.errors(admission={"maxActiveCandidates": 2})))
        self.assertTrue(any("afterChanges" in e for e in self.errors(triggers={"afterChanges": {"enabled": True}})))
        self.assertTrue(any("must be an integer" in e for e in self.errors(candidateLifetimeHours="soon")))

    def test_extended_trigger_fields_validate(self):
        good = {"afterChanges": {"enabled": True, "minCommits": 5, "paths": ["src/**"], "combinator": "all", "quietHours": {"start": 22, "end": 6}}, "missedRun": "skip", "priority": ["change", "schedule"]}
        self.assertEqual(self.errors(triggers=good), [])
        for bad, needle in (({"missedRun": "later"}, "missedRun"), ({"afterChanges": {"enabled": True, "minCommits": 1, "combinator": "some"}}, "combinator"),
                            ({"afterChanges": {"enabled": True, "minCommits": 1, "quietHours": {"start": 25, "end": 6}}}, "quietHours"),
                            ({"priority": ["change", "change"]}, "priority")):
            self.assertTrue(any(needle in e for e in self.errors(triggers=bad)), bad)

    def test_bad_preset_is_explained(self):
        errs = rp.validate_document(doc(p={"preset": "monthly"}))
        self.assertTrue(any("unknown preset" in e for e in errs), errs)


class RoundTripAndBinding(unittest.TestCase):
    def test_migrate_round_trips_and_upgrades_legacy(self):
        v1 = doc(p=WEEKLY)
        self.assertEqual(rp.migrate(v1), v1)
        legacy = rp.default_spec()
        migrated = rp.migrate(legacy)
        self.assertEqual(migrated["schemaVersion"], rp.SCHEMA_VERSION)
        self.assertEqual(rp.effective_config(migrated, None), legacy)
        with self.assertRaises(rp.ConfigError):
            rp.migrate({"schemaVersion": "release-pipeline/v9"})

    def test_hash_is_stable_and_change_sensitive(self):
        spec = rp.effective_config(doc(p=WEEKLY), "p")
        self.assertEqual(rp.config_hash(spec), rp.config_hash(copy.deepcopy(spec)))
        other = copy.deepcopy(spec)
        other["candidateLifetimeHours"] += 1
        self.assertNotEqual(rp.config_hash(spec), rp.config_hash(other))

    def test_policy_change_applies_only_to_future_revisions(self):
        old = rp.effective_config(doc(p=WEEKLY), "p")
        candidate = rp.bind_candidate({"id": "c1"}, old)
        new = copy.deepcopy(old)
        new["candidateLifetimeHours"] = 1
        self.assertEqual(rp.spec_for_candidate(candidate, new), old)
        self.assertEqual(rp.bind_candidate(candidate, new)["configHash"], rp.config_hash(old))
        self.assertEqual(rp.spec_for_candidate({"id": "c2"}, new), new)


class SecurityPolicy(unittest.TestCase):
    def setUp(self):
        self.strict = rp.effective_config(doc(p={**WEEKLY, "promotion": {"review": "approval", "stable": "approval", "soakMinutes": 60}}), "p")

    def test_agent_cannot_weaken_approval_or_security_policy(self):
        weak = copy.deepcopy(self.strict)
        weak["promotion"] = {"review": "self-review", "stable": "auto", "soakMinutes": 0}
        weak["tests"]["required"] = []
        weak["admission"]["maxActiveCandidates"] = 3
        reasons = rp.authorize_change(self.strict, weak, "agent")
        for field in ("promotion.stable", "promotion.review", "promotion.soakMinutes", "tests.required", "admission.maxActiveCandidates"):
            self.assertTrue(any(r.startswith(field) for r in reasons), (field, reasons))
        self.assertEqual(rp.authorize_change(self.strict, weak, "operator"), [])

    def test_agent_may_strengthen_or_change_non_security_fields(self):
        other = copy.deepcopy(self.strict)
        other["promotion"]["soakMinutes"] = 120
        other["candidateLifetimeHours"] = 24
        self.assertEqual(rp.authorize_change(self.strict, other, "agent"), [])

    def test_operator_controlled_config_is_a_protected_asset(self):
        assets = json.loads((ROOT / "policies" / "protected-assets.json").read_text(encoding="utf8"))
        globs = [g for a in assets["assets"] if a["category"] == "policy" for g in a["globs"]]
        self.assertIn("config/release-pipeline*.json", globs)

    def test_schema_file_is_valid_json_and_pins_version(self):
        schema = json.loads((ROOT / "schemas" / "release-pipeline.schema.json").read_text(encoding="utf8"))
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], rp.SCHEMA_VERSION)
        self.assertEqual(schema["properties"]["defaults"]["properties"]["admission"]["properties"]["maxActiveCandidates"]["const"], 1)


class SharedFixtureParity(unittest.TestCase):
    """The TypeScript preview port is checked against the same fixture (cezar/packages/cezar/src/release-candidates/pipeline-policy.test.ts)."""

    def test_python_authority_still_matches_the_committed_fixture(self):
        fixture = json.loads((ROOT / "tests" / "fixtures" / "release-pipeline-cases.json").read_text(encoding="utf8"))
        for case in fixture["cases"]:
            errors = rp.validate_document(case["doc"])
            self.assertEqual(errors, case["errors"], case["name"])
            if not errors:
                spec = rp.effective_config(case["doc"], case["project"])
                self.assertEqual(spec, case["effective"], case["name"])
                self.assertEqual(rp.config_hash(spec), case["hash"], case["name"])


if __name__ == "__main__":
    unittest.main()
