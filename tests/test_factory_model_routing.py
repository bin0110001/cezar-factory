import copy
import importlib.util
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parents[1]
CAP = ROOT / "scripts" / "capacity"
for name in ("subscription_profiles", "model_routing"):
    spec = importlib.util.spec_from_file_location(name, CAP / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
mr = sys.modules["model_routing"]

NOW = datetime(2026, 11, 18, 12, 5, tzinfo=timezone.utc)
EXAMPLE = ROOT / "config" / "model-routing.json.example"


def win(remaining=50):
    return {"name": "5h", "kind": "rolling", "durationSeconds": 18000, "resetAt": "2026-11-18T15:00:00Z", "unit": "messages",
            "limit": 100, "remaining": remaining, "confidence": "estimated", "source": "manual",
            "observedAt": "2026-11-18T12:00:00Z", "stalenessSeconds": 900}


def prof(pid, provider, models, remaining=50, enabled=True, conc=2):
    return {"id": pid, "provider": provider, "accountLabel": pid, "adapters": [], "enabled": enabled,
            "maxConcurrency": conc, "allowedModelIds": models, "windows": [win(remaining)]}


def cfg():
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def profiles(**kw):
    return [prof("claude-work", "claude", ["claude-haiku-5-5", "claude-sonnet-5-5"]),
            prof("gpt-main", "openai", ["gpt-luna"])]


def route(task, c=None, p=None, **kw):
    return mr.route(task, c or cfg(), p or profiles(), NOW, **kw)


class ConfigTests(unittest.TestCase):
    def test_example_valid(self):
        self.assertEqual(mr.validate_config(cfg(), profiles()), [])

    def test_no_tiers_is_valid(self):
        self.assertEqual(mr.validate_config({"schemaVersion": 1, "models": {}}), [])

    def test_dangling_alias(self):
        c = cfg(); c["tiers"]["fast"]["candidates"].append("ghost")
        self.assertTrue(any("ghost" in e for e in mr.validate_config(c)))

    def test_bad_provider_policy(self):
        c = cfg(); c["tiers"]["fast"]["providerAllow"] = ["claude"]; c["tiers"]["fast"]["providerDeny"] = ["claude"]
        self.assertTrue(any("both allowed and denied" in e for e in mr.validate_config(c)))

    def test_unsatisfiable_min_quality(self):
        c = cfg(); c["tiers"]["strong"]["minQuality"] = 10
        self.assertTrue(any("unsatisfiable" in e for e in mr.validate_config(c)))

    def test_bad_fallback_and_affinity(self):
        c = cfg(); c["tiers"]["fast"]["fallback"] = "sometimes"; c["tiers"]["fast"]["accountAffinity"] = ["nope"]
        errs = mr.validate_config(c, profiles())
        self.assertTrue(any("fallback" in e for e in errs) and any("nope" in e for e in errs))

    def test_load_config_rejects_invalid(self):
        c = cfg(); c["schemaVersion"] = 9
        self.assertTrue(mr.validate_config(c))


class TierTests(unittest.TestCase):
    def test_first_preference_wins(self):
        d = route({"tier": "fast"})
        self.assertEqual((d["status"], d["selected"]["model"], d["fallback"]), (mr.ROUTED, "luna", False))

    def test_deterministic(self):
        self.assertEqual(route({"tier": "fast"}), route({"tier": "fast"}))

    def test_deny_list(self):
        c = cfg(); c["tiers"]["fast"]["providerDeny"] = ["openai"]
        d = route({"tier": "fast"}, c)
        self.assertEqual(d["selected"]["model"], "haiku")
        self.assertIn("provider-denied", d["rejections"][0]["reasons"])

    def test_account_affinity_between_accounts(self):
        p = profiles() + [prof("claude-personal", "claude", ["claude-haiku-5-5"])]
        c = cfg(); c["tiers"]["fast"]["candidates"] = ["haiku"]
        self.assertEqual(route({"tier": "fast"}, c, p)["selected"]["account"], "claude-work")
        self.assertEqual(route({"tier": "fast", "accountAffinity": ["claude-personal"]}, c, p)["selected"]["account"], "claude-personal")

    def test_capacity_exhaustion_falls_back_with_reason(self):
        p = [prof("claude-work", "claude", ["claude-haiku-5-5"]), prof("gpt-main", "openai", ["gpt-luna"], remaining=0)]
        d = route({"tier": "fast"}, p=p)
        self.assertEqual((d["selected"]["model"], d["fallback"]), ("haiku", True))
        self.assertIn("capacity-exhausted", d["rejections"][0]["reasons"])

    def test_concurrency_limit(self):
        d = route({"tier": "fast"}, active={"gpt-main": 2})
        self.assertEqual(d["selected"]["model"], "haiku")

    def test_fallback_none_blocks_lower_preference(self):
        c = cfg(); c["tiers"]["fast"]["fallback"] = "none"
        p = [prof("claude-work", "claude", ["claude-haiku-5-5"]), prof("gpt-main", "openai", ["gpt-luna"], remaining=0)]
        d = route({"tier": "fast"}, c, p)
        self.assertEqual(d["status"], mr.DEFERRED)
        self.assertIsNone(d["selected"])
        self.assertTrue(any("fallback-disabled" in r["reasons"] for r in d["rejections"]))

    def test_all_capacity_exhausted_defers(self):
        p = [prof("claude-work", "claude", ["claude-haiku-5-5"], remaining=0), prof("gpt-main", "openai", ["gpt-luna"], enabled=False)]
        self.assertEqual(route({"tier": "fast"}, p=p)["status"], mr.DEFERRED)

    def test_feature_requirement_fails_not_defers(self):
        d = route({"tier": "fast", "require": {"locality": "local"}})
        self.assertEqual(d["status"], mr.FAILED)
        self.assertIn("locality-mismatch", d["rejections"][0]["reasons"])

    def test_unknown_tier(self):
        self.assertEqual(route({"tier": "zzz"})["status"], mr.FAILED)

    def test_input_not_mutated(self):
        c, p = cfg(), profiles()
        before = copy.deepcopy((c, p))
        mr.route({"tier": "fast"}, c, p, NOW)
        self.assertEqual((c, p), before)


class PinnedTests(unittest.TestCase):
    def test_pinned_exact(self):
        d = route({"pinned": {"model": "haiku", "account": "claude-work"}})
        self.assertEqual((d["status"], d["pinned"], d["selected"]["account"]), (mr.ROUTED, True, "claude-work"))

    def test_pinned_never_switches_model(self):
        p = [prof("claude-work", "claude", ["claude-haiku-5-5"], remaining=0), prof("gpt-main", "openai", ["gpt-luna"])]
        d = route({"pinned": {"model": "haiku", "account": "claude-work"}}, p=p)
        self.assertEqual(d["status"], mr.DEFERRED)
        self.assertIsNone(d["selected"])

    def test_pinned_never_switches_account(self):
        p = [prof("claude-work", "claude", ["claude-haiku-5-5"], remaining=0), prof("claude-personal", "claude", ["claude-haiku-5-5"])]
        d = route({"pinned": {"model": "haiku", "account": "claude-work"}}, p=p)
        self.assertIsNone(d["selected"])
        d2 = route({"pinned": {"model": "haiku"}}, p=p)
        self.assertEqual(d2["selected"]["account"], "claude-personal")

    def test_pinned_unknown_model_and_account(self):
        self.assertEqual(route({"pinned": {"model": "ghost"}})["status"], mr.FAILED)
        self.assertEqual(route({"pinned": {"model": "haiku", "account": "ghost"}})["status"], mr.FAILED)

    def test_pinned_model_not_allowed_on_account(self):
        d = route({"pinned": {"model": "sonnet", "account": "gpt-main"}})
        self.assertEqual(d["status"], mr.FAILED)


if __name__ == "__main__":
    unittest.main()
