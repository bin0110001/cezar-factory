import json
import pathlib
import tempfile
import unittest

from scripts.release.factory_capability_delivery import CapabilityDelivery, DeliveryError

H1 = "sha256:" + "a" * 64
H2 = "sha256:" + "b" * 64
H3 = "sha256:" + "c" * 64


def policy(entries, profile="factory-default"):
    return {"schemaVersion": "factory-capability-policy/v1", "gateway": {"profile": profile},
            "catalog": [{"id": i, "ref": f"catalog/{i}", "sha256": h, "approved": True, **extra} for i, h, extra in entries]}


class Gateway:
    """Fake Obot: serves exactly what was last applied, can go down or serve extras."""

    def __init__(self):
        self.served = {}
        self.down = False

    def __call__(self, wanted):
        if self.down:
            raise ConnectionError("obot unreachable")
        return dict(self.served)

    def serve(self, pol):
        self.served = {e["id"]: e["sha256"] for e in pol["catalog"]}


class CapabilityDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.gw = Gateway()
        self.dev = CapabilityDelivery(self.root / "store", "dev", self.gw)

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, name, pol):
        directory = self.root / name / "policies"
        directory.mkdir(parents=True)
        (directory / "capability-policy.json").write_text(json.dumps(pol), encoding="utf-8")
        return self.root / name

    def activate(self, name, pol, delivery=None, **kwargs):
        self.gw.serve(pol)
        return (delivery or self.dev).activate(self.release(name, pol), "1" * 40, **kwargs)

    def test_activate_is_idempotent_and_records_evidence(self):
        first = self.activate("r1", policy([("godot", H1, {})]))
        again = self.dev.activate(self.root / "r1", "1" * 40)
        self.assertEqual(first["policyDigest"], again["policyDigest"])
        evidence = (self.dev.base / "evidence.jsonl").read_text()
        self.assertIn("activated", evidence)
        self.assertIn("unchanged", evidence)

    def test_failed_sync_never_enables_unapproved_capabilities(self):
        good = self.activate("r1", policy([("godot", H1, {})]))
        new = policy([("godot", H1, {}), ("extra", H2, {})])
        self.gw.serve(policy([("godot", H1, {})]))  # gateway sync only partly applied
        with self.assertRaises(DeliveryError):
            self.dev.activate(self.release("r2", new), "2" * 40)
        self.assertEqual(self.dev.pointer()["policyDigest"], good["policyDigest"])

    def test_unapproved_catalog_entry_and_secrets_are_rejected(self):
        bad = policy([("godot", H1, {})])
        bad["catalog"][0]["approved"] = False
        with self.assertRaises(DeliveryError):
            self.dev.activate(self.release("r1", bad), "1" * 40)
        leaky = policy([("godot", H1, {})])
        leaky["gateway"]["apiToken"] = "x"
        with self.assertRaises(DeliveryError):
            self.dev.activate(self.release("r2", leaky), "1" * 40)
        self.assertIsNone(self.dev.pointer())

    def test_gateway_extra_capability_blocks_activation(self):
        pol = policy([("godot", H1, {})])
        self.gw.served = {"godot": H1, "rogue": H3}
        with self.assertRaises(DeliveryError):
            self.dev.activate(self.release("r1", pol), "1" * 40)
        self.assertIsNone(self.dev.pointer())

    def test_obot_downtime_keeps_previous_policy(self):
        good = self.activate("r1", policy([("godot", H1, {})]))
        self.gw.down = True
        with self.assertRaises(DeliveryError):
            self.dev.activate(self.release("r2", policy([("godot", H2, {})])), "2" * 40)
        self.assertEqual(self.dev.pointer()["policyDigest"], good["policyDigest"])
        self.assertEqual(self.dev.drift()["status"], "drift")
        self.gw.down = False
        self.assertEqual(self.dev.drift()["status"], "in-sync")

    def test_rollback_returns_to_last_good(self):
        first = self.activate("r1", policy([("godot", H1, {})]))
        self.activate("r2", policy([("godot", H2, {})]))
        self.gw.serve(policy([("godot", H1, {})]))
        self.assertEqual(self.dev.rollback()["policyDigest"], first["policyDigest"])

    def test_interrupted_activation_recovers_to_verified_state(self):
        good = self.activate("r1", policy([("godot", H1, {})]))
        new = policy([("godot", H2, {})])
        # crash after the pointer swap, before the journal is cleared, gateway still on old policy
        self.gw.serve(new)
        self.dev.activate(self.release("r2", new), "2" * 40)
        (self.dev.base / "journal.json").write_text(json.dumps({"phase": "verifying"}))
        self.gw.serve(policy([("godot", H1, {})]))
        self.assertEqual(self.dev.recover(), "rolled-back")
        self.assertEqual(self.dev.pointer()["policyDigest"], good["policyDigest"])
        self.assertEqual(self.dev.recover(), "clean")

    def test_interrupted_stage_leaves_pointer_untouched(self):
        good = self.activate("r1", policy([("godot", H1, {})]))
        (self.dev.base / "journal.json").write_text(json.dumps({"phase": "verifying"}))
        self.assertEqual(self.dev.recover(), "recovered")
        self.assertEqual(self.dev.pointer()["policyDigest"], good["policyDigest"])

    def test_tasks_stay_pinned_across_promotion_and_retry(self):
        self.activate("r1", policy([("godot", H1, {})]))
        pinned = self.dev.resolve_for_task("task-1")
        self.activate("r2", policy([("godot", H2, {}), ("new", H3, {})]))
        self.assertEqual(self.dev.resolve_for_task("task-1"), pinned)  # retry
        fresh = self.dev.resolve_for_task("task-2")
        self.assertNotEqual(fresh["policyDigest"], pinned["policyDigest"])
        self.assertEqual([s["sha256"] for s in pinned["skills"]], [H1])

    def test_channels_are_independent_and_stable_needs_review(self):
        stable = CapabilityDelivery(self.root / "store", "stable", self.gw)
        pol = policy([("godot", H1, {})])
        self.activate("r1", pol)
        with self.assertRaises(DeliveryError):
            stable.activate(self.root / "r1", "1" * 40)
        stable.activate(self.root / "r1", "1" * 40, approved_by="reviewer")
        self.activate("r2", policy([("godot", H2, {})]))
        pin = stable.resolve_for_task("task-s")
        self.assertEqual(pin["skills"][0]["sha256"], H1)  # dev promotion did not reach stable
        self.assertEqual(self.dev.resolve_for_task("task-d")["skills"][0]["sha256"], H2)

    def test_project_overrides_follow_policy_precedence(self):
        self.activate("r1", policy([("godot", H1, {"required": True}), ("opt", H2, {"default": False})]))
        pin = self.dev.resolve_for_task("t", {"optIn": ["opt", "ghost"], "optOut": ["godot"]})
        self.assertEqual(sorted(s["id"] for s in pin["skills"]), ["godot", "opt"])
        self.assertEqual(len(pin["notes"]), 2)
        self.assertNotIn("token", json.dumps(pin).lower())


if __name__ == "__main__":
    unittest.main()
