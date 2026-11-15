import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).parents[1] / "scripts" / "session" / "capability_broker.py"
SPEC = importlib.util.spec_from_file_location("capability_broker", PATH)
cb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cb)

ID = dict(project="pA", run="r1", attempt="a1", session="s1", fence=3)


class Base(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.fences = {"s1": 3, "s2": 1}
        self.env = {cb.FLAG_ENV: "1"}
        self.b = cb.CapabilityBroker(secret=b"k" * 32, fence_lookup=lambda s: self.fences.get(s),
                                     clock=lambda: self.now, env=self.env)

    def denied(self, reason, fn, *a, **k):
        with self.assertRaises(cb.Denied) as c:
            fn(*a, **k)
        self.assertEqual(c.exception.reason, reason)

    def tok(self, cap="control", **over):
        return self.b.issue(**{**ID, "capability": cap, **over})

    def ok(self, t, action, **over):
        return self.b.authorize(t, action=action, project="pA", session="s1", **over)


class Tests(Base):
    def test_observe_allowed_control_denied(self):
        t = self.tok("observe")
        self.ok(t, "screenshot")
        self.denied("capability-insufficient", self.ok, t, "click")

    def test_control_allows_both(self):
        t = self.tok("control")
        self.ok(t, "click"); self.ok(t, "snapshot")

    def test_control_flag_off(self):
        self.env[cb.FLAG_ENV] = "0"
        self.denied("control-disabled", self.tok, "control")
        self.tok("observe")

    def test_flag_turned_off_denies_existing_control(self):
        t = self.tok("control"); self.env[cb.FLAG_ENV] = ""
        self.denied("control-disabled", self.ok, t, "type")

    def test_cross_project_session_sibling_host_controller(self):
        t = self.tok("control")
        self.denied("cross-project", self.b.authorize, t, action="click", project="pB", session="s1")
        self.denied("cross-session", self.b.authorize, t, action="click", project="pA", session="s2")
        for target in ("host-desktop", "controller", "sibling-job"):
            self.denied("target-out-of-scope", self.ok, t, "click", target=target)

    def test_stale_lease_and_restart_cannot_restore(self):
        t = self.tok("control"); self.fences["s1"] = 4
        self.denied("stale-fence", self.ok, t, "click")
        self.denied("stale-fence", self.tok, "control")  # old fence cannot mint either

    def test_expiry(self):
        t = self.tok("observe", ttl=10); self.now += 10
        self.denied("expired", self.ok, t, "screenshot")

    def test_ttl_capped(self):
        t = self.tok("observe", ttl=10**6); self.now += cb.MAX_TTL
        self.denied("expired", self.ok, t, "screenshot")

    def test_revoked(self):
        t = self.tok("control"); self.b.revoke(t)
        self.denied("revoked", self.ok, t, "click")

    def test_tampered_and_foreign_tokens(self):
        t = self.tok("observe")
        pre, body, sig = t.split(".")
        self.denied("invalid-token", self.ok, "%s.%s.%s" % (pre, body, sig[::-1]), "screenshot")
        other = cb.CapabilityBroker(secret=b"z" * 32, fence_lookup=lambda s: 3, clock=lambda: self.now, env=self.env)
        self.denied("invalid-token", self.ok, other.issue(**ID, capability="observe"), "screenshot")
        self.denied("invalid-token", self.ok, "garbage", "screenshot")

    def test_human_takeover_suspends_control_not_observe(self):
        t = self.tok("control"); self.b.suspend("s1")
        self.denied("human-takeover", self.ok, t, "click")
        self.ok(t, "screenshot")
        self.b.resume("s1")
        self.ok(t, "click")

    def test_gateway_outage_fails_closed(self):
        t = self.tok("observe")
        def boom(s): raise OSError("down")
        self.b._fence_lookup = boom
        self.denied("gateway-unavailable", self.ok, t, "screenshot")

    def test_unknown_action_and_capability(self):
        t = self.tok("control")
        self.denied("unknown-action", self.ok, t, "exec_shell")
        self.denied("unknown-capability", self.tok, "admin")

    def test_config_cannot_escalate(self):
        self.denied("config-escalation", cb.narrow_capabilities, ("observe",), {"capabilities": ["observe", "control"]})
        self.denied("config-unknown-scope", cb.narrow_capabilities, ("observe", "control"), {"capabilities": ["root"]})
        self.denied("config-unknown-key", cb.narrow_capabilities, ("observe",), {"grant": "control"})
        self.assertEqual(cb.narrow_capabilities(("observe", "control"), {"capabilities": ["observe"]}), ("observe",))
        self.denied("config-narrowed", self.tok, "control", project_config={"capabilities": ["observe"]})

    def test_redaction(self):
        t = self.tok("observe")
        self.assertNotIn(t, cb.redact("using %s now Authorization: Bearer abc" % t))
        self.assertNotIn(t, str(self.assertRaises(cb.Denied)))
        try:
            self.ok(t[:-2] + "xx", "screenshot")
        except cb.Denied as e:
            self.assertNotIn(t, str(e))

    def test_invalid_identity(self):
        self.denied("identity-invalid", self.tok, "observe", project="../x")
        self.denied("identity-invalid", self.tok, "observe", fence=True)


if __name__ == "__main__":
    unittest.main()
