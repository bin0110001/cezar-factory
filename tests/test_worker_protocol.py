import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts" / "worker"))
import worker_protocol as wp  # noqa: E402

CMD = {"adapter": "generic-command", "adapterVersion": "1", "args": ["run"]}


def setup(now=0.0, node="n1", caps=None):
    c = wp.Coordinator(heartbeat_ttl=30, lease_ttl=100)
    tok = c.enroll(node)
    s = c.connect(node, tok, [1], caps or {"adapter": "generic-command"}, now)
    return c, tok, s


def rcpt(c, s, node, aid, fence, nonce="a", outcome="passed", ev="ok", now=1.0, key=None):
    body = {"attempt": aid, "fence": fence, "nonce": nonce, "outcome": outcome, "evidence": ev}
    return c.receipt(node, s["sessionId"], aid, fence, nonce, outcome, ev, wp.sign(key or s["sessionKey"], body), now)


class T(unittest.TestCase):
    def test_happy_path_and_drain_revoke(self):
        c, tok, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, {"adapter": "generic-command"}, 1)
        c.started("A", "n1", s["sessionId"], l.fence, 2)
        self.assertEqual(rcpt(c, s, "n1", "A", l.fence), "passed")
        c.drain("n1")
        self.assertFalse(c.schedulable("n1", 3))
        c.revoke("n1")
        with self.assertRaises(wp.ProtocolError) as e:
            c.connect("n1", tok, [1], {}, 4)
        self.assertEqual(e.exception.outcome, "auth_failed")

    def test_auth_failures(self):
        c, tok, s = setup()
        for bad in ("wrong", ""):
            with self.assertRaises(wp.ProtocolError) as e:
                c.connect("n1", bad, [1], {}, 1)
            self.assertEqual(e.exception.outcome, "auth_failed")
        with self.assertRaises(wp.ProtocolError):
            c.connect("ghost", tok, [1], {}, 1)
        with self.assertRaises(wp.ProtocolError):
            c.heartbeat("n1", "badsession", None, 1)

    def test_unsupported_version_and_capability(self):
        c = wp.Coordinator()
        tok = c.enroll("n1")
        with self.assertRaises(wp.ProtocolError) as e:
            c.connect("n1", tok, [99], {}, 0)
        self.assertEqual(e.exception.outcome, "unsupported_capability")
        self.assertEqual(c.workers["n1"].state, "unsupported")
        c, tok, s = setup(caps={})
        with self.assertRaises(wp.ProtocolError) as e:
            c.claim("n1", s["sessionId"], "A", "k", CMD, {"gpu": True}, 1)
        self.assertEqual(e.exception.outcome, "unsupported_capability")

    def test_no_shell_strings(self):
        c, _, s = setup()
        for bad in ("rm -rf /", {"adapter": "x", "adapterVersion": "1", "shell": "id"},
                    {"adapter": "x", "adapterVersion": "1", "args": "a b"}, {"adapter": "x"}):
            with self.assertRaises(wp.ProtocolError):
                c.claim("n1", s["sessionId"], "A", "k", bad, None, 1)

    def test_duplicate_claim_and_idempotent_retry(self):
        c, tok, s = setup()
        l1 = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        self.assertIs(c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 2), l1)
        t2 = c.enroll("n2"); s2 = c.connect("n2", t2, [1], {}, 1)
        with self.assertRaises(wp.ProtocolError):
            c.claim("n2", s2["sessionId"], "A", "k2", CMD, None, 2)

    def test_split_brain_stale_fence_never_passes(self):
        c, _, s = setup()
        l1 = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        # worker 1 goes silent; lease expires; worker 2 reclaims with a higher fence
        c.heartbeat("n1", s["sessionId"], None, 1)
        t2 = c.enroll("n2"); s2 = c.connect("n2", t2, [1], {}, 150)
        l2 = c.claim("n2", s2["sessionId"], "A", "k2", CMD, None, 150)
        self.assertGreater(l2.fence, l1.fence)
        with self.assertRaises(wp.ProtocolError) as e:
            rcpt(c, s, "n1", "A", l1.fence, now=151)
        self.assertIn(e.exception.outcome, ("stale_fence", "auth_failed"))
        self.assertEqual(rcpt(c, s2, "n2", "A", l2.fence, now=151), "passed")

    def test_expired_lease_with_current_fence_not_accepted(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        with self.assertRaises(wp.ProtocolError) as e:
            rcpt(c, s, "n1", "A", l.fence, now=500)
        self.assertEqual(e.exception.outcome, "expired")
        c.sweep(500)
        self.assertEqual(c.leases["A"].outcome, "worker_disconnected")

    def test_started_but_lost(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        c.started("A", "n1", s["sessionId"], l.fence, 2)
        c.sweep(500)
        self.assertEqual(c.leases["A"].outcome, "started_but_lost")

    def test_replay_and_forged_receipts(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        with self.assertRaises(wp.ProtocolError) as e:
            rcpt(c, s, "n1", "A", l.fence, key="0" * 64)
        self.assertEqual(e.exception.outcome, "auth_failed")
        rcpt(c, s, "n1", "A", l.fence)
        with self.assertRaises(wp.ProtocolError) as e:
            rcpt(c, s, "n1", "A", l.fence)
        self.assertEqual(e.exception.outcome, "rejected_replay")
        self.assertEqual(c.leases["A"].outcome, "passed")

    def test_worker_cannot_report_non_terminal_outcomes_or_oversize(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        with self.assertRaises(wp.ProtocolError):
            rcpt(c, s, "n1", "A", l.fence, outcome="cancelled")
        with self.assertRaises(wp.ProtocolError):
            rcpt(c, s, "n1", "A", l.fence, nonce="b", ev="x" * (wp.MAX_EVIDENCE_BYTES + 1))
        self.assertEqual(c.leases["A"].state, "leased")

    def test_clock_skew_uses_coordinator_time(self):
        c, _, s = setup()
        # worker cannot extend freshness by claiming a time: heartbeat takes only coordinator now
        c.sweep(31)
        self.assertEqual(c.workers["n1"].state, "offline")
        self.assertFalse(c.schedulable("n1", 31))
        c.heartbeat("n1", s["sessionId"], None, 32)
        self.assertTrue(c.schedulable("n1", 33))

    def test_revoked_credentials_cancel_work(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        c.revoke("n1")
        with self.assertRaises(wp.ProtocolError):
            rcpt(c, s, "n1", "A", l.fence)
        self.assertEqual(c.leases["A"].outcome, "auth_failed")

    def test_rotation_kills_old_session(self):
        c, tok, s = setup()
        new = c.rotate("n1")
        with self.assertRaises(wp.ProtocolError):
            c.heartbeat("n1", s["sessionId"], None, 1)
        with self.assertRaises(wp.ProtocolError):
            c.connect("n1", tok, [1], {}, 1)
        c.connect("n1", new, [1], {}, 2)

    def test_cancel_ack(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        c.cancel("A")
        with self.assertRaises(wp.ProtocolError):
            rcpt(c, s, "n1", "A", l.fence)
        c.ack_cancel("A", "n1", s["sessionId"], l.fence)
        self.assertEqual(c.leases["A"].outcome, "cancelled")

    def test_dead_coordinator_restore_keeps_fences(self):
        c, _, s = setup()
        l = c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        snap = json.loads(json.dumps(c.snapshot()))
        c2 = wp.Coordinator.restore(snap)
        self.assertEqual(c2.leases["A"].outcome, "worker_disconnected")
        self.assertEqual(c2.fences["A"], l.fence)
        # the old worker has no session on the new coordinator
        with self.assertRaises(wp.ProtocolError):
            rcpt(c2, s, "n1", "A", l.fence)
        # a reclaim must exceed the old fence
        t = c2.enroll("n1"); s2 = c2.connect("n1", t, [1], {}, 10)
        l2 = c2.claim("n1", s2["sessionId"], "A", "k9", CMD, None, 10)
        self.assertGreater(l2.fence, l.fence)
        with self.assertRaises(wp.ProtocolError):
            wp.Coordinator.restore({"schemaVersion": 7, "fences": {}, "claims": {}, "leases": {}})

    def test_offline_worker_never_blocks_other_workers(self):
        c, _, s = setup()
        t2 = c.enroll("n2"); s2 = c.connect("n2", t2, [1], {}, 0)
        c.sweep(100)
        c.heartbeat("n2", s2["sessionId"], None, 101)
        c.claim("n2", s2["sessionId"], "B", "kb", CMD, None, 101)
        with self.assertRaises(wp.ProtocolError) as e:
            c.heartbeat("n1", s["sessionId"], None, 101) and None
            c.claim("n1", s["sessionId"], "C", "kc", CMD, None, 200)
        self.assertEqual(e.exception.outcome, "worker_disconnected")

    def test_spool_bounded_and_resume(self):
        sp = wp.Spool(limit=2)
        for i in range(3):
            sp.put({"i": i})
        self.assertEqual([e["i"] for e in sp.entries], [1, 2])
        calls = []

        def send(e):
            calls.append(e["i"])
            if e["i"] == 1:
                raise wp.ProtocolError("stale_fence")
            raise ConnectionError()
        res = sp.flush(send)
        self.assertEqual(res[0][1], "stale_fence")
        self.assertEqual(len(sp.entries), 1)  # transport failure keeps entry for next reconnect

    def test_snapshot_matches_schema_shape(self):
        schema = json.loads((pathlib.Path(__file__).resolve().parents[1] / "schemas" / "worker-protocol.schema.json").read_text())
        c, _, s = setup()
        c.claim("n1", s["sessionId"], "A", "k1", CMD, None, 1)
        snap = c.snapshot()
        self.assertEqual(set(snap), set(schema["required"]))
        states = schema["properties"]["leases"]["additionalProperties"]["properties"]["state"]["enum"]
        self.assertIn(snap["leases"]["A"]["state"], states)


if __name__ == "__main__":
    unittest.main()
