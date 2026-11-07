import importlib.util
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("capacity_telemetry", ROOT / "scripts" / "capacity" / "capacity_telemetry.py")
ct = importlib.util.module_from_spec(SPEC)
import sys
sys.modules["capacity_telemetry"] = ct
SPEC.loader.exec_module(ct)

FIX = ROOT / "tests" / "fixtures" / "capacity"
NOW = datetime(2026, 11, 7, 10, 30, tzinfo=timezone.utc)


def manual(name):
    return ct.ManualOverrideAdapter("claude", ct.load_json(FIX / name))


class CapacityTests(unittest.TestCase):
    def test_unsupported_is_unknown(self):
        s = ct.UnsupportedNativeAdapter("codex").snapshot("5h", NOW)
        d = s.to_dict(now=NOW)
        self.assertEqual((d["source"], d["confidence"], d["remaining"], d["freshness"]), ("unsupported", "unknown", None, "unknown"))
        self.assertIsNone(d["percentRemaining"])
        self.assertIsNone(d["effectiveRemaining"])

    def test_manual_windows_separate_and_never_exact(self):
        a = manual("manual-valid.json")
        five, week = a.snapshot("5h", NOW), a.snapshot("weekly", NOW)
        self.assertEqual((five.source, five.confidence, five.remaining, five.unit), ("manual", "estimated", 40.0, "messages"))
        self.assertEqual(five.percent_remaining(), 40.0)
        self.assertEqual(week.remaining, 300.0)
        self.assertIsNone(week.percent_remaining())  # no limit known

    def test_reserve_subtracts(self):
        s = manual("manual-valid.json").snapshot("5h", NOW)
        self.assertEqual(s.effective_remaining(15, NOW), 25.0)
        self.assertEqual(s.effective_remaining(500, NOW), 0.0)

    def test_stale_and_expired(self):
        s = manual("manual-valid.json").snapshot("5h", NOW)
        self.assertEqual(s.freshness(NOW + timedelta(hours=2)), "stale")
        self.assertIsNone(s.effective_remaining(0, NOW + timedelta(hours=2)))
        self.assertEqual(s.freshness(NOW + timedelta(hours=6)), "expired")
        self.assertFalse(s.is_authoritative(NOW + timedelta(hours=6)))

    def test_malformed_and_missing(self):
        for name in ("manual-malformed.json", "manual-missing-windows.json"):
            s = manual(name).snapshot("5h", NOW)
            self.assertEqual(s.confidence, "unknown")
            self.assertIsNotNone(s.error)
        self.assertEqual(ct.ManualOverrideAdapter("x", None).snapshot("weekly", NOW).confidence, "unknown")
        self.assertIsNotNone(ct.ManualOverrideAdapter("x", {"windows": {}}).snapshot("5h", NOW).error)

    def test_backoff_honors_retry_after(self):
        t = ct.ObservedCooldownTracker("codex", base_backoff=10)
        self.assertEqual(t.record_rate_limit("5h", None, NOW), 10)
        self.assertEqual(t.record_rate_limit("5h", 120, NOW), 120)
        self.assertEqual(t.backoff_seconds(None), 40)
        s = t.snapshot("5h", NOW)
        self.assertEqual((s.source, s.remaining, s.error), ("observed", 0.0, "rate limited"))
        self.assertEqual(t.snapshot("weekly", NOW).confidence, "unknown")
        t.record_success()
        self.assertEqual(t.backoff_seconds(None), 10)

    def test_resolve_prefers_active_cooldown(self):
        t = ct.ObservedCooldownTracker("claude")
        t.record_rate_limit("5h", 600, NOW)
        s = ct.resolve_snapshot([manual("manual-valid.json"), t], "5h", NOW + timedelta(seconds=10))
        self.assertEqual(s.source, "observed")
        s = ct.resolve_snapshot([manual("manual-valid.json"), t], "5h", NOW + timedelta(hours=1))
        self.assertEqual(s.source, "manual")

    def test_adapter_exception_is_contained(self):
        class Bad(ct.CapacityAdapter):
            def snapshot(self, window, now=None):
                raise RuntimeError("boom")
        s = ct.resolve_snapshot([Bad()], "5h", NOW)
        self.assertEqual(s.confidence, "unknown")
        self.assertIn("boom", s.error)

    def test_dict_matches_schema_required_keys(self):
        schema = json.loads((ROOT / "schemas" / "capacity-snapshot.schema.json").read_text())
        d = manual("manual-valid.json").snapshot("5h", NOW).to_dict(now=NOW)
        self.assertTrue(set(schema["required"]) <= set(d))
        self.assertIn(d["freshness"], schema["properties"]["freshness"]["enum"])


if __name__ == "__main__":
    unittest.main()
