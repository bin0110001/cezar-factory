import copy
import json
import pathlib
import unittest

from scripts.release import quality_gate_policy as qg

ROOT = pathlib.Path(__file__).resolve().parents[1]


def shipped():
    return json.loads((ROOT / "policies" / "quality-gates.json").read_text(encoding="utf8"))


class Shipped(unittest.TestCase):
    def test_default_policy_is_valid_and_matches_the_documented_matrix(self):
        doc = shipped()
        self.assertEqual(qg.validate(doc), [])
        eff = qg.effective(doc, project=None, repo_type=None)
        pr = qg.stage_matrix(eff, "pr-dev")
        self.assertEqual({c for c, s in pr.items() if s["level"] == "required"}, {"format", "lint", "type", "test", "secrets"})
        self.assertEqual(qg.stage_matrix(eff, "stable")["sca"], {"level": "required", "onUnavailable": "fail-closed"})
        self.assertEqual([qg.cadence_of(eff, c) for c in ("sca", "sast", "license")], ["daily", "weekly", "monthly"])
        self.assertNotIn("ai-audit", qg.stage_matrix(eff, "pr-dev"))  # opt-in only

    def test_schema_file_is_valid_json_and_pins_version(self):
        schema = json.loads((ROOT / "schemas" / "quality-gate-policy.schema.json").read_text(encoding="utf8"))
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], qg.SCHEMA_VERSION)
        self.assertEqual(schema["$defs"]["layer"]["properties"]["waivers"]["properties"]["grantedBy"]["items"]["enum"], list(qg.GRANTORS))

    def test_policy_file_is_a_protected_asset(self):
        assets = json.loads((ROOT / "policies" / "protected-assets.json").read_text(encoding="utf8"))
        globs = [g for a in assets["assets"] if a["category"] == "policy" for g in a["globs"]]
        self.assertIn("policies/**", globs)


class Rejects(unittest.TestCase):
    def errors(self, mutate):
        doc = shipped()
        mutate(doc)
        return qg.validate(doc)

    def test_bad_structure_and_values_are_rejected_with_paths(self):
        cases = [
            (lambda d: d.update(schemaVersion="quality-gates/v9"), "schemaVersion"),
            (lambda d: d.pop("defaults"), "defaults: required"),
            (lambda d: d.update(bogus=1), "bogus: unknown top-level"),
            (lambda d: d["defaults"]["checks"].update(trivy={"pr-dev": "required"}), "unknown category"),
            (lambda d: d["defaults"]["checks"]["lint"].update(nightly="required"), "unknown stage"),
            (lambda d: d["defaults"]["checks"]["lint"].update({"pr-dev": "mandatory"}), "lint.pr-dev.level"),
            (lambda d: d["defaults"]["cadence"].update(sca="hourly"), "cadence.sca"),
            (lambda d: d["defaults"]["riskPatterns"].append({"id": "x", "globs": []}), "riskPatterns[2]"),
            (lambda d: d["defaults"]["tolerances"]["maxNewFindings"].update(severe=1), "maxNewFindings.severe"),
            (lambda d: d["defaults"]["tolerances"]["maxNewFindings"].update(high=-1), "maxNewFindings.high"),
            (lambda d: d["defaults"]["budgets"].update({"pr-dev": {"maxMinutes": 0}}), "budgets.pr-dev"),
            (lambda d: d["defaults"].update(surprise=1), "defaults.surprise: unknown field"),
        ]
        for mutate, needle in cases:
            errs = self.errors(mutate)
            self.assertTrue(any(needle in e for e in errs), (needle, errs))

    def test_agents_can_never_grant_waivers_and_waivers_expire(self):
        self.assertTrue(any("never grant" in e for e in self.errors(lambda d: d["defaults"]["waivers"].update(grantedBy=["human", "agent"]))))
        self.assertTrue(any("never grant" in e for e in self.errors(lambda d: d["defaults"]["waivers"].update(grantedBy=[]))))
        self.assertTrue(any("waivers.maxDays" in e for e in self.errors(lambda d: d["defaults"]["waivers"].update(maxDays=0))))

    def test_required_security_checks_cannot_fail_open_at_promotion(self):
        errs = self.errors(lambda d: d["defaults"]["checks"]["sca"].update(stable={"level": "required", "onUnavailable": "fail-open"}))
        self.assertTrue(any("must fail closed" in e for e in errs), errs)
        errs = self.errors(lambda d: d.update(projects={"p": {"checks": {"secrets": {"candidate": {"level": "required", "onUnavailable": "fail-open"}}}}}))
        self.assertTrue(any("must fail closed" in e for e in errs), errs)
        # advisory or non-promotion stages may fail open
        self.assertEqual(self.errors(lambda d: d["defaults"]["checks"]["sast"].update(stable={"level": "advisory", "onUnavailable": "fail-open"})), [])


class Overrides(unittest.TestCase):
    def doc(self):
        d = shipped()
        d["repoTypes"] = {"game": {"checks": {"sast": {"candidate": "required"}}, "cadence": {"sast": "daily"}}}
        d["projects"] = {"tableflux": {"cadence": {"sca": "weekly"}, "budgets": {"candidate": {"maxMinutes": 240}}}}
        return d

    def test_defaults_are_configurable_per_repo_type_and_project(self):
        d = self.doc()
        self.assertEqual(qg.validate(d), [])
        base = qg.effective(d, project=None, repo_type=None)
        game = qg.effective(d, project=None, repo_type="game")
        flux = qg.effective(d, project="tableflux", repo_type="game")
        self.assertEqual(qg.stage_matrix(base, "candidate")["sast"]["level"], "advisory")
        self.assertEqual(qg.stage_matrix(game, "candidate")["sast"]["level"], "required")
        self.assertEqual((qg.cadence_of(base, "sca"), qg.cadence_of(flux, "sca"), qg.cadence_of(flux, "sast")), ("daily", "weekly", "daily"))
        self.assertEqual(flux["budgets"]["candidate"]["maxMinutes"], 240)
        self.assertEqual(flux["budgets"]["pr-dev"]["maxMinutes"], 10)

    def test_effective_policy_cannot_become_unsafe_through_an_override(self):
        d = self.doc()
        d["projects"]["tableflux"]["checks"] = {"sca": {"stable": {"level": "required", "onUnavailable": "fail-open"}}}
        self.assertTrue(qg.validate(d))
        with self.assertRaises(qg.PolicyError):
            qg.load(d)


class SharedFixtureParity(unittest.TestCase):
    """The TypeScript dry run (cezar/packages/cezar/src/release-candidates/quality-actions.ts) is checked against the same fixture."""

    def test_python_authority_still_matches_the_committed_fixture(self):
        fixture = json.loads((ROOT / "tests" / "fixtures" / "quality-gate-cases.json").read_text(encoding="utf8"))
        statuses = ["pass", "fail", "warn", "unknown", "error", "not-applicable"]
        checked = 0
        for name, d in fixture["documents"].items():
            eff = qg.effective(d["doc"], project=d["project"], repo_type=d["repoType"])
            for row in d["rows"]:
                spec = qg._spec(eff, row["category"], row["stage"])
                self.assertEqual((spec["level"], spec["onUnavailable"]), (row["level"], row["onUnavailable"]), f"{name} {row['category']}@{row['stage']}")
                for s in statuses:
                    self.assertEqual(qg.is_blocking(eff, row["category"], row["stage"], s), row["blocks"][s], f"{name} {row['category']}@{row['stage']} {s}")
                    checked += 1
        self.assertGreater(checked, 800)


class Decisions(unittest.TestCase):
    def setUp(self):
        self.eff = qg.effective(shipped(), project=None, repo_type=None)

    def test_blocking_follows_level_status_and_fail_mode(self):
        b = lambda cat, stage, status: qg.is_blocking(self.eff, cat, stage, status)  # noqa: E731
        self.assertTrue(b("sca", "stable", "fail"))
        self.assertTrue(b("sca", "stable", "unknown"))  # mandatory security check fails closed
        self.assertTrue(b("sca", "stable", "error"))
        self.assertFalse(b("sca", "stable", "pass"))
        self.assertFalse(b("sca", "stable", "not-applicable"))  # no ecosystem or tool: explicit and non-blocking, unlike unknown
        self.assertFalse(b("sca", "pr-dev", "fail"))  # advisory at PR time
        self.assertFalse(b("sca", "periodic", "unknown"))  # explicitly fail-open on the periodic refresh
        self.assertFalse(b("sast", "candidate", "fail"))
        self.assertFalse(b("license", "stable", "fail"))  # off at stable

    def test_risk_patterns_pull_checks_forward(self):
        plain = qg.escalated_stage_matrix(self.eff, "pr-dev", ["src/a.py"])
        self.assertNotIn("sca", {c for c, s in plain.items() if s["level"] == "required"})
        deps = qg.escalated_stage_matrix(self.eff, "pr-dev", ["web/package-lock.json"])
        self.assertEqual(deps["sca"]["level"], "required")
        self.assertIn("risk pattern dependency-manifests", deps["sca"]["reason"])
        infra = qg.escalated_stage_matrix(self.eff, "pr-dev", ["deploy/Dockerfile"])
        self.assertEqual({"container", "iac"} <= set(infra), True)

    def test_validate_is_pure(self):
        doc = shipped()
        before = copy.deepcopy(doc)
        qg.validate(doc)
        qg.effective(doc, project=None, repo_type=None)
        self.assertEqual(doc, before)


if __name__ == "__main__":
    unittest.main()
