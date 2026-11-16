"""Adversarial negative tests for coding-agent trust boundaries (#133).

Reuses the existing controls (#104 governance guard, #113 isolation, #101 review, session
capability broker); see docs/trust-boundaries.md. Runs locally and fails closed.
"""
import importlib.util
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cb = load("tb_capability_broker", "scripts/session/capability_broker.py")
hc = load("tb_hindsight_client", "scripts/hindsight/client.py")

SECRETS = [
    "ghp_abcdefghijklmnopqrstuv",
    "github_pat_ABCDEFGHIJKLMNOP1234",
    "sk-abcdefghijklmnop1234",
    "Authorization: Bearer s3cr3tvalue",
    "api_key=s3cr3tvalue",
    "password: s3cr3tvalue",
    "x-access-token:ghs_abcdefghijklmnop1234",
]
LEAKS = ("abcdefghijklmnop", "s3cr3tvalue")


class RedactionAtCollectionBoundary(unittest.TestCase):
    def test_python_redactors_remove_secrets_embedded_in_tool_output(self):
        for secret in SECRETS:
            blob = "tool output\n%s\ntrailing" % secret
            for fn in (cb.redact, hc.scrub):
                out = fn(blob)
                for leak in LEAKS:
                    self.assertNotIn(leak, out, (fn.__module__, secret))

    @unittest.skipUnless(shutil.which("pwsh"), "pwsh required")
    def test_powershell_failure_text_redacts_the_same_secrets(self):
        lib = ROOT / "scripts" / "failure-summary-lib.ps1"
        for secret in SECRETS:
            proc = subprocess.run(
                ["pwsh", "-NoProfile", "-Command", ". '%s'; Protect-FailureText $env:TB_TEXT" % lib],
                env={**__import__("os").environ, "TB_TEXT": "log " + secret},
                capture_output=True, text=True, timeout=60)
            for leak in LEAKS:
                self.assertNotIn(leak, proc.stdout, secret)


class PolicyBypassAndPermissionWidening(unittest.TestCase):
    def test_project_config_cannot_widen_capabilities(self):
        for config, reason in (
            ({"capabilities": ["control"]}, "config-escalation"),
            ({"capabilities": ["admin"]}, "config-unknown-scope"),
            ({"capabilities": ["observe"], "allowNetwork": True}, "config-unknown-key"),
        ):
            with self.assertRaises(cb.Denied) as c:
                cb.narrow_capabilities(("observe",), config)
            self.assertEqual(c.exception.reason, reason)

    def test_forged_token_and_host_target_denied(self):
        b = cb.CapabilityBroker(secret=b"k" * 32, fence_lookup=lambda s: 1,
                                env={cb.FLAG_ENV: "1"})
        tok = b.issue(project="p", run="r", attempt="a", session="s", fence=1)
        forged = tok[:-3] + ("AAA" if not tok.endswith("AAA") else "BBB")
        with self.assertRaises(cb.Denied):
            b.authorize(forged, action="screenshot", project="p", session="s")
        with self.assertRaises(cb.Denied) as c:
            b.authorize(tok, action="screenshot", project="p", session="s", target="host")
        self.assertEqual(c.exception.reason, "target-out-of-scope")

    def test_malicious_issue_text_cannot_issue_control_without_flag(self):
        # An issue body that instructs the agent to "enable control" has no channel to the flag.
        b = cb.CapabilityBroker(secret=b"k" * 32, fence_lookup=lambda s: 1, env={})
        with self.assertRaises(cb.Denied) as c:
            b.issue(project="p", run="r", attempt="a", session="s", fence=1, capability="control")
        self.assertEqual(c.exception.reason, "control-disabled")


class ProtectedEvidenceManifest(unittest.TestCase):
    """The agent-visible guard must keep evidence, policy, baselines and checks protected."""

    def setUp(self):
        self.manifest = json.loads((ROOT / "policies" / "protected-assets.json").read_text())
        self.assets = {a["category"]: a for a in self.manifest["assets"]}

    def test_required_categories_present(self):
        for cat in ("policy", "baseline", "check-selection", "ledger-evidence", "guard"):
            self.assertIn(cat, self.assets)

    def test_audit_evidence_is_append_only(self):
        self.assertTrue(self.assets["ledger-evidence"].get("appendOnly"))

    def test_guard_protects_itself_and_its_workflows(self):
        globs = self.assets["guard"]["globs"]
        for path in ("scripts/factory/protect-governance.ps1", "workflows/implement.yaml",
                     "workflows/fix-review.yaml"):
            self.assertIn(path, globs)

    def test_guard_runs_in_both_agent_workflows(self):
        for wf in ("implement", "fix-review"):
            text = (ROOT / "workflows" / (wf + ".yaml")).read_text()
            self.assertIn("protect-governance", text, wf)

    def test_trust_boundary_doc_names_every_owner(self):
        text = (ROOT / "docs" / "trust-boundaries.md").read_text()
        for needle in ("#104", "#113", "#101", "#166", "Residual risks", "Inputs and attacker capabilities", "Negative-test scenarios"):
            self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
