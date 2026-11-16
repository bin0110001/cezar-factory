"""Untrusted-input scenarios (#581): poisoned memory recall, permission widening, approval negatives.

Reuses the Hindsight client (#134 provenance) and the capability broker (#346); offline, fixtures are inert.
Each scenario asserts the denial/neutralisation AND an audit event."""
import importlib.util
import json
import os
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
FX = ROOT / "tests" / "fixtures" / "untrusted-input"


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = load("uip_hindsight_client", "scripts/hindsight/client.py")
cb = load("uip_capability_broker", "scripts/session/capability_broker.py")


class PoisonedMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def args(self, **over):
        values = {
            "project": "cezar-factory", "bank": "b", "project_bank": "b", "factory_bank": "", "objective": "x",
            "task_class": "investigation", "keywords": [], "failure_signature": "a" * 64, "timeout": 1,
            "candidate": str(self.root / "candidate.json"), "approved": True, "workflow": "w", "issue": "581",
            "worker": "w", "model": "m", "output": str(self.root / "o.json"),
            "deterministic_index": str(self.root / "d.json"), "provenance_index": str(self.root / "p.jsonl"),
        }
        values.update(over)
        return Namespace(**values)

    def test_poisoned_recall_is_scrubbed_unvalidated_and_audited(self):
        poisoned = json.loads((FX / "poisoned-memory.json").read_text())
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(client, "mcp_call", return_value=poisoned):
            result = client.recall(self.args())
        item = result["selected"][0]
        self.assertNotIn("sk-live-abcdef0123456789", item["excerpt"])
        self.assertNotIn("abc.def.ghi", item["excerpt"])
        # The remote memory claims "validated"; only the local provenance index may grant that.
        self.assertEqual(item["validationStatus"], "unvalidated")
        # Audit event: the read is captured with id and content hash.
        captured = result["retrievalCapture"]["memories"][0]
        self.assertEqual((captured["id"], captured["validationStatus"]), ("poisoned-1", "unvalidated"))
        self.assertRegex(captured["contentHash"], r"^[a-f0-9]{64}$")

    def test_poisoned_candidate_is_rejected_with_receipt_and_never_sent(self):
        Path(self.args().candidate).write_text((FX / "poisoned-candidate.json").read_text())
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(client, "mcp_call") as call:
            receipt = client.retain(self.args())
        call.assert_not_called()
        self.assertEqual((receipt["status"], receipt["reason"]), ("rejected", "sensitive-or-transient"))
        self.assertRegex(receipt["candidateHash"], r"^[a-f0-9]{64}$")

    def test_retention_without_approval_is_denied_with_receipt(self):
        good = {"topic": "Startup", "lesson": "Bound readiness by a deadline.", "kind": "successful-fix",
                "evidence": "Suite passed.", "scope": "repo", "claimType": "fact",
                "evidenceLinks": [{"kind": "run", "ref": "run:1"}]}
        Path(self.args().candidate).write_text(json.dumps(good))
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(client, "mcp_call") as call:
            receipt = client.retain(self.args(approved=False))
        call.assert_not_called()
        self.assertEqual((receipt["status"], receipt["reason"]), ("rejected", "approval-required"))


class PermissionWideningTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.broker = cb.CapabilityBroker(secret=b"k" * 32, fence_lookup=lambda s: 3, clock=lambda: 1000.0,
                                          env={cb.FLAG_ENV: "1"}, audit=self.events.append)
        self.ident = dict(project="pA", run="r1", attempt="a1", session="s1", fence=3)

    def denied(self, reason, fn, *a, **k):
        with self.assertRaises(cb.Denied) as c:
            fn(*a, **k)
        self.assertEqual(c.exception.reason, reason)
        self.assertEqual(self.events[-1]["reason"], reason)
        self.assertEqual(self.events[-1]["event"], "capability-denied")

    def test_project_config_cannot_widen_scope(self):
        widening = json.loads((FX / "permission-widening.json").read_text())
        self.denied("config-unknown-scope", self.broker.issue, **self.ident, project_config=widening)
        self.denied("config-unknown-key", self.broker.issue, **self.ident, project_config={"capabilities": ["observe"], "network": "any"})

    def test_observe_token_cannot_be_used_for_control(self):
        token = self.broker.issue(**self.ident, capability="observe")
        self.denied("capability-insufficient", self.broker.authorize, token, action="click", project="pA", session="s1")

    def test_cross_project_session_and_host_targets_are_denied(self):
        token = self.broker.issue(**self.ident, capability="control")
        self.denied("cross-project", self.broker.authorize, token, action="click", project="pB", session="s1")
        self.denied("cross-session", self.broker.authorize, token, action="click", project="pA", session="s2")
        self.denied("target-out-of-scope", self.broker.authorize, token, action="click", project="pA", session="s1", target="host-desktop")

    def test_control_denied_when_feature_flag_is_off(self):
        off = cb.CapabilityBroker(secret=b"k" * 32, fence_lookup=lambda s: 3, env={}, audit=self.events.append)
        self.denied("control-disabled", off.issue, **self.ident, capability="control")

    def test_audit_events_carry_no_credential_material(self):
        token = self.broker.issue(**self.ident, capability="observe")
        with self.assertRaises(cb.Denied):
            self.broker.authorize(token, action="click", project="pA", session="s1")
        self.assertNotIn(token, json.dumps(self.events))


if __name__ == "__main__":
    unittest.main()
