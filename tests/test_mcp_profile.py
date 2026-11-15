import importlib.util
import json
import os
import stat
import tempfile
import unittest
import urllib.error
from pathlib import Path

PATH = Path(__file__).parents[1] / "scripts" / "mcp" / "profile.py"
SPEC = importlib.util.spec_from_file_location("mcp_profile", PATH)
mp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mp)

BASE = {"schemaVersion": 1, "revision": "r1", "servers": {
    "hindsight": {"endpoint": "https://gw.example/mcp/h", "identity": "per-run", "tools": ["recall", "retain"],
                  "runners": ["claude", "codex"], "projects": ["*"], "required": True},
    "admin": {"endpoint": "https://gw.example/mcp/a", "identity": "per-run", "tools": ["wipe"],
              "runners": ["claude"], "projects": ["secure-*"], "required": False}}}


class Broker:
    def __init__(self, fail_revoke=False):
        self.issued, self.revoked, self.fail = [], [], fail_revoke

    def issue(self, run, server, tools):
        self.issued.append(server)
        return f"id-{server}-{run}", f"secret-{server}"

    def revoke(self, ident):
        if self.fail:
            raise RuntimeError("down")
        self.revoked.append(ident)


def lister_ok(s, tok):
    return {"result": {"tools": [{"name": t} for t in s["tools"]]}}


class ResolveTests(unittest.TestCase):
    def test_deterministic_and_project_scoped(self):
        a = mp.resolve(BASE, {}, "claude", "demo")
        b = mp.resolve(json.loads(json.dumps(BASE)), {}, "claude", "demo")
        self.assertEqual(a, b)
        self.assertEqual(list(a["servers"]), ["hindsight"])  # admin not authorized for demo
        self.assertIn("admin", mp.resolve(BASE, {}, "claude", "secure-x")["servers"])
        self.assertNotIn("admin", mp.resolve(BASE, {}, "codex", "secure-x")["servers"])

    def test_overlays_narrow_in_order(self):
        o = {"project": {"hindsight": {"tools": ["recall", "retain"]}}, "task": {"hindsight": {"tools": ["recall"]}}}
        self.assertEqual(mp.resolve(BASE, o, "claude", "demo")["servers"]["hindsight"]["tools"], ["recall"])

    def test_widening_rejected(self):
        for o in ({"task": {"hindsight": {"tools": ["recall", "delete"]}}},
                  {"project": {"hindsight": {"projects": ["*"], "endpoint": "https://evil/"}}},
                  {"task": {"newsrv": {"tools": ["x"]}}},
                  {"task": {"hindsight": {"required": False}}},
                  {"task": {"hindsight": {"remove": True}}},
                  {"project": {"admin": {"runners": ["codex"]}}}):
            with self.assertRaises(mp.ProfileError):
                mp.resolve(BASE, o, "claude", "secure-x")

    def test_required_server_unauthorized_fails(self):
        base = json.loads(json.dumps(BASE))
        base["servers"]["admin"]["required"] = True
        with self.assertRaises(mp.ProfileError):
            mp.resolve(base, {}, "claude", "demo")

    def test_rejects_embedded_credentials_and_plain_http(self):
        for ep in ("https://u:p@gw/x", "http://gw.example/x"):
            base = json.loads(json.dumps(BASE))
            base["servers"]["hindsight"]["endpoint"] = ep
            with self.assertRaises(mp.ProfileError):
                mp.resolve(base, {}, "claude", "demo")

    def test_shipped_config_is_valid(self):
        base = json.loads((Path(__file__).parents[1] / "config" / "mcp-profiles.json").read_text())
        for runner in mp.RUNNERS:
            mp.resolve(base, {}, runner, "any")


class AdapterTests(unittest.TestCase):
    def test_adapters_reference_env_never_secrets(self):
        for runner, name in (("claude", ".mcp.json"), ("codex", "config.toml")):
            eff = mp.resolve(BASE, {}, runner, "demo")
            fname, text, allowed = mp.adapt(eff)
            self.assertEqual(fname, name)
            self.assertIn("CEZ_MCP_TOKEN_HINDSIGHT", text)
            self.assertNotIn("secret-", text)
            self.assertTrue(allowed)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.rt = Path(self.tmp.name) / "run"

    def test_prepare_writes_private_config_and_cleanup_revokes(self):
        br = Broker()
        out = mp.prepare(BASE, {}, "claude", "demo", "run1", self.rt, br, lister_ok)
        cfg = Path(out["config"])
        if os.name != "nt":  # POSIX mode bits are not represented by Windows' stat result.
            self.assertEqual(stat.S_IMODE(cfg.stat().st_mode), 0o600)
        self.assertNotIn("secret-hindsight", cfg.read_text())
        self.assertEqual(out["env"], {"CEZ_MCP_TOKEN_HINDSIGHT": "secret-hindsight"})
        mp.cleanup(self.rt, br)
        self.assertEqual(br.revoked, ["id-hindsight-run1"])
        self.assertFalse(cfg.exists())

    def test_retry_keeps_identity_and_revision(self):
        br = Broker()
        mp.prepare(BASE, {}, "claude", "demo", "run1", self.rt, br, lister_ok)
        os.environ["CEZ_MCP_TOKEN_HINDSIGHT"] = "secret-hindsight"
        self.addCleanup(os.environ.pop, "CEZ_MCP_TOKEN_HINDSIGHT", None)
        mp.prepare(BASE, {}, "claude", "demo", "run1", self.rt, br, lister_ok)
        self.assertEqual(br.issued, ["hindsight"])  # not re-issued
        changed = json.loads(json.dumps(BASE))
        changed["servers"]["hindsight"]["tools"] = ["recall"]
        with self.assertRaises(mp.ProfileError):
            mp.prepare(changed, {}, "claude", "demo", "run1", self.rt, br, lister_ok)

    def test_preflight_failure_revokes_and_cleans_before_agent(self):
        br = Broker()
        def down(s, tok):
            raise urllib.error.URLError("refused")
        with self.assertRaises(mp.PreflightError) as c:
            mp.prepare(BASE, {}, "claude", "demo", "run2", self.rt, br, down)
        self.assertEqual(c.exception.kind, "setup")
        self.assertEqual(br.revoked, ["id-hindsight-run2"])
        self.assertFalse((self.rt / "mcp-state.json").exists())

    def test_missing_required_tool_and_identity_errors(self):
        eff = mp.resolve(BASE, {}, "claude", "demo")
        with self.assertRaises(mp.PreflightError) as c:
            mp.preflight(eff, {"hindsight": "t"}, lambda s, t: {"result": {"tools": [{"name": "recall"}]}})
        self.assertEqual(c.exception.kind, "required-tool")
        def denied(s, t):
            raise urllib.error.HTTPError("u", 403, "no", {}, None)
        with self.assertRaises(mp.PreflightError) as c:
            mp.preflight(eff, {"hindsight": "t"}, denied)
        self.assertEqual(c.exception.kind, "identity")

    def test_optional_server_degrades_with_warning(self):
        base = json.loads(json.dumps(BASE))
        base["servers"]["hindsight"]["required"] = False
        eff = mp.resolve(base, {}, "claude", "demo")
        def down(s, t):
            raise OSError("offline")
        warnings = mp.preflight(eff, {"hindsight": "t"}, down)
        self.assertEqual(len(warnings), 1)

    def test_failed_revocation_keeps_state_for_retry(self):
        mp.prepare(BASE, {}, "claude", "demo", "run3", self.rt, Broker(), lister_ok)
        with self.assertRaises(mp.ProfileError):
            mp.cleanup(self.rt, Broker(fail_revoke=True))
        self.assertTrue((self.rt / "mcp-state.json").exists())
        good = Broker()
        mp.cleanup(self.rt, good)
        self.assertEqual(good.revoked, ["id-hindsight-run3"])


if __name__ == "__main__":
    unittest.main()
