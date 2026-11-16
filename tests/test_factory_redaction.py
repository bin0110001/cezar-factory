import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(rel, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


red = load("scripts/security/redaction.py", "t_redaction")
broker = load("scripts/session/capability_broker.py", "t_broker")
ledger = load("scripts/release/factory_incident_ledger.py", "t_ledger")
incident = load("scripts/hindsight/incident.py", "t_incident")
client = incident.client

GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0"
SK = "sk-" + "synthetic0123456789abcdef"
AWS = "AKIA" + "ABCDEFGHIJKLMNOP"
PAT = "github_pat_" + "11ABCDEFG0123456789xyz"
ENVSECRET = "envvalue-Zq9x8w7v6u5t"
SAMPLES = [
    f"Authorization: Bearer {GH}\nnext line",
    f"Proxy-Authorization: Basic dXNlcjpodW50ZXIy",
    f"token={GH} key {SK} {AWS} {PAT}",
    "GH_TOKEN=plainsecret99 and db_password: hunter2hunter2",
    "clone https://user:s3cretpass@example.com/repo.git",
    f"leaked {ENVSECRET} from env",
]
LEAKS = [GH, SK, AWS, PAT, "dXNlcjpodW50ZXIy", "plainsecret99", "hunter2hunter2", "s3cretpass", ENVSECRET]
ENV = {"SERVICE_API_KEY": ENVSECRET, "PATH": "/usr/bin", "SHORT_TOKEN": "abc"}


def clean(text):
    for leak in LEAKS:
        assert leak not in text, leak
    return True


class RedactionTests(unittest.TestCase):
    def test_all_patterns_masked(self):
        for sample in SAMPLES:
            out = red.redact(sample, env=ENV)
            self.assertTrue(clean(out), out)
            self.assertIn("[REDACTED]", out)

    def test_no_over_redaction_of_identifiers_and_shas(self):
        text = "commit 0123456789abcdef0123456789abcdef01234567 in scripts/foo.py issue #579"
        self.assertEqual(red.redact(text, env={}), text)

    def test_strict_mode_masks_long_opaque_strings(self):
        blob = "A" * 44
        self.assertIn(blob, red.redact(blob, env={}))
        self.assertNotIn(blob, red.redact(blob, env={}, strict=True))

    def test_collection_points_do_not_leak(self):
        import os
        issue_body = "\n".join(SAMPLES)
        os.environ["SERVICE_API_KEY"] = ENVSECRET
        try:
            event = {"event": "resolved", "findingId": "F-1", "runId": "r", "commit": "abc1234",
                     "evidenceIds": ["ok-1"], "verified": True, "summary": issue_body, "fix": issue_body}
            outputs = [
                broker.redact(issue_body),
                ledger.normalize_failure(issue_body),
                client.scrub(issue_body),
                incident.redact(issue_body, 5000),
                incident.render(incident.build_entry("p", "bank", event)),
            ]
        finally:
            del os.environ["SERVICE_API_KEY"]
        for out in outputs:
            self.assertTrue(clean(out), out)

    def test_powershell_parity(self):
        pwsh = "pwsh"
        script = (
            f". '{ROOT / 'scripts/security/redaction.ps1'}'; "
            "$t = [Console]::In.ReadToEnd(); "
            "(Invoke-FactoryRedact -Text $t -Env @{SERVICE_API_KEY='" + ENVSECRET + "'}) | ConvertTo-Json -Compress"
        )
        try:
            proc = subprocess.run([pwsh, "-NoProfile", "-Command", script], input="\n".join(SAMPLES),
                                  capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            self.skipTest("pwsh unavailable")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        ps_out = json.loads(proc.stdout)
        py_out = red.redact("\n".join(SAMPLES), env={"SERVICE_API_KEY": ENVSECRET})
        self.assertEqual(ps_out.replace("\r\n", "\n"), py_out)


if __name__ == "__main__":
    unittest.main()
