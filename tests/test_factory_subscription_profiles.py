import copy
import importlib.util
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("subscription_profiles", ROOT / "scripts" / "capacity" / "subscription_profiles.py")
sp = importlib.util.module_from_spec(SPEC)
sys.modules["subscription_profiles"] = sp
SPEC.loader.exec_module(sp)

NOW = datetime(2026, 11, 18, 12, 5, tzinfo=timezone.utc)
EXAMPLE = ROOT / "config" / "subscription-profiles.json.example"


def example():
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def win(**kw):
    w = {"name": "5h", "kind": "rolling", "durationSeconds": 18000, "resetAt": "2026-11-18T15:00:00Z", "unit": "messages",
         "limit": 100, "remaining": 50, "confidence": "estimated", "source": "manual",
         "observedAt": "2026-11-18T12:00:00Z", "stalenessSeconds": 900}
    w.update(kw)
    return w


def prof(*windows, **kw):
    p = {"id": "a", "provider": "claude", "accountLabel": "A", "adapters": ["x"], "enabled": True, "maxConcurrency": 1,
         "allowedModelIds": ["m"], "credentialRef": "credstore:a", "windows": list(windows)}
    p.update(kw)
    return p


class SubscriptionProfileTests(unittest.TestCase):
    def test_example_loads_and_accounts_are_independent(self):
        store = sp.load_store(example())
        a, b = store["profiles"]
        self.assertEqual(a["provider"], b["provider"])
        self.assertNotEqual(a["allowedModelIds"], b["allowedModelIds"])
        self.assertNotEqual(a["maxConcurrency"], b["maxConcurrency"])
        self.assertNotEqual([w["name"] for w in a["windows"]], [w["name"] for w in b["windows"]])
        states = sp.evaluate_store(store, NOW)
        self.assertEqual(states, {"claude-personal": "available", "claude-work": "constrained"})
        self.assertTrue(sp.allows_model(a, "claude-opus-5-5"))
        self.assertFalse(sp.allows_model(b, "claude-opus-5-5"))

    def test_isolation_changing_one_account_leaves_other(self):
        store = sp.load_store(example())
        before = sp.evaluate_state(store["profiles"][0], NOW)
        store["profiles"][1]["windows"][0]["remaining"] = 0
        self.assertEqual(sp.evaluate_state(store["profiles"][1], NOW), "exhausted")
        self.assertEqual(sp.evaluate_state(store["profiles"][0], NOW), before)

    def test_overlapping_windows_most_constrained_wins(self):
        p = prof(win(remaining=90), win(name="weekly", remaining=0))
        self.assertEqual(sp.evaluate_state(p, NOW), "exhausted")
        p = prof(win(remaining=90), win(name="weekly", remaining=10))
        self.assertEqual(sp.evaluate_state(p, NOW), "constrained")

    def test_reset_makes_exhausted_window_available(self):
        w = win(remaining=0, resetAt="2026-11-18T12:00:00Z", observedAt="2026-11-18T11:00:00Z")
        self.assertEqual(sp.evaluate_state(prof(w), NOW), "available")

    def test_clock_drift_within_tolerance_does_not_flip(self):
        reset = NOW + timedelta(seconds=-30)  # reset passed by 30s, inside tolerance
        w = win(remaining=0, resetAt=sp._iso(reset))
        self.assertEqual(sp.evaluate_state(prof(w), NOW), "exhausted")
        w = win(remaining=50, observedAt=sp._iso(NOW - timedelta(seconds=900 + 60)))
        self.assertEqual(sp.evaluate_state(prof(w), NOW), "available")
        w = win(remaining=50, observedAt=sp._iso(NOW - timedelta(seconds=900 + 600)))
        self.assertEqual(sp.evaluate_state(prof(w), NOW), "stale")

    def test_unknown_disabled_and_injectable_clock(self):
        self.assertEqual(sp.evaluate_state(prof(), NOW), "unknown")
        self.assertEqual(sp.evaluate_state(prof(win(), enabled=False), NOW), "disabled")
        self.assertEqual(sp.evaluate_state(prof(win(remaining=None)), NOW), "unknown")
        self.assertEqual(sp.evaluate_state(prof(win()), clock=lambda: NOW), "available")

    def test_state_is_always_one_of_the_set(self):
        for rem in (None, 0, 5, 80):
            self.assertIn(sp.evaluate_state(prof(win(remaining=rem)), NOW), sp.STATES)

    def test_serializer_never_leaks_secret(self):
        p = prof(win())
        p["apiToken"] = "sk-SECRET"
        out = json.dumps(sp.serialize_profile(p, NOW))
        self.assertNotIn("credstore:a", out)
        self.assertNotIn("sk-SECRET", out)
        self.assertNotIn("credentialRef", out)
        self.assertIn("state", out)

    def test_validation_rejects_secret_field_and_bad_data(self):
        p = prof(win())
        p["apiToken"] = "x"
        self.assertTrue(any("secret" in e for e in sp.validate_profile(p)))
        self.assertTrue(sp.validate_profile(prof(win(kind="sliding"))))
        self.assertTrue(sp.validate_profile(prof(win(), maxConcurrency=0)))
        with self.assertRaises(sp.ProfileError):
            sp.load_store({"schemaVersion": 2, "profiles": [prof(win()), prof(win())]})

    def test_api_billing_is_separate_type(self):
        d = sp.ApiBillingUsage("claude", 3.5).to_dict()
        self.assertEqual(d["type"], "apiBilling")
        self.assertNotIn("remaining", d)
        self.assertFalse(hasattr(sp.ApiBillingUsage("claude", 1), "windows"))

    def test_migration_v1_to_v2_and_future_rejected(self):
        v1 = {"schemaVersion": 1, "accounts": [{"id": "x", "provider": "claude", "label": "X", "adapters": ["a"],
              "concurrency": 2, "models": ["m"], "credentialRef": "credstore:x",
              "fiveHour": {"limit": 10, "remaining": 5, "unit": "messages", "observedAt": "2026-11-18T12:00:00Z"}}]}
        store = sp.load_store(v1)
        self.assertEqual(store["schemaVersion"], sp.SCHEMA_VERSION)
        self.assertEqual(store["profiles"][0]["maxConcurrency"], 2)
        self.assertEqual(store["profiles"][0]["windows"][0]["name"], "5h")
        with self.assertRaises(sp.ProfileError):
            sp.migrate({"schemaVersion": sp.SCHEMA_VERSION + 1, "profiles": []})
        with self.assertRaises(sp.ProfileError):
            sp.migrate({"profiles": []})

    def test_schema_file_is_valid_json_and_lists_states(self):
        schema = json.loads((ROOT / "schemas" / "subscription-profile.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(tuple(schema["definitions"]["state"]["enum"]), sp.STATES)


if __name__ == "__main__":
    unittest.main()
