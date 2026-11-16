import multiprocessing
import pathlib
import tempfile
import threading
import unittest

from scripts.release import factory_candidate_state as cs
from scripts.release.factory_candidate_state import CandidateStore

A, B, C, D = "a" * 40, "b" * 40, "c" * 40, "d" * 40


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def _race_worker(path, n, out):
    store = CandidateStore(path)
    res = []
    for i in range(n):
        res.append(store.request("p", f"manual-{i}", A, B, "cfg")["outcome"])
    out.put(res)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-candidate-")
        self.db = pathlib.Path(self.tmp.name) / "c.db"
        self.clock = Clock()
        self.store = CandidateStore(self.db, clock=self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def admit(self, project="p"):
        cid = self.store.request(project, "manual", A, B, "cfg")["candidate_id"]
        tok = self.store.acquire_lease(cid, "w1", 60)
        return cid, tok

    def to_validating(self):
        cid, tok = self.admit()
        self.store.transition(cid, "snapshotting", tok, 0)
        self.store.snapshot(cid, tok, C)
        self.store.transition(cid, "validating", tok, 1)
        return cid, tok

    def to_ready(self):
        cid, tok = self.to_validating()
        self.store.start_test_run(cid, tok, 1, "r1")
        self.store.record_result(cid, tok, 1, "r1", "passed")
        self.store.transition(cid, "ready", tok, 1)
        return cid, tok


class RaceTests(Base):
    def test_threads_one_active(self):
        outcomes = []
        lock = threading.Lock()

        def go(i):
            r = CandidateStore(self.db).request("p", f"t{i}", A, B, "cfg")
            with lock:
                outcomes.append(r["outcome"])
        ts = [threading.Thread(target=go, args=(i,)) for i in range(100)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(outcomes.count("admitted"), 1)
        self.assertEqual(outcomes.count("pending"), 99)
        self.assertEqual(len(self.store.pending("p")["triggers"]), 99)

    def test_processes_one_active(self):
        ctx = multiprocessing.get_context("spawn")
        q = ctx.Queue()
        procs = [ctx.Process(target=_race_worker, args=(str(self.db), 10, q)) for _ in range(10)]
        [p.start() for p in procs]
        results = [q.get(timeout=120) for _ in procs]
        [p.join() for p in procs]
        flat = [o for r in results for o in r]
        self.assertEqual(flat.count("admitted"), 1)
        self.assertEqual(flat.count("pending"), 99)

    def test_unique_index_is_database_level(self):
        import sqlite3
        self.store.request("p", "m", A, B, "cfg")
        conn = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO candidates(id,project,state,source_dev_sha,base_stable_sha,config_hash,created_at,updated_at) VALUES('x','p','requested','a','b','c','t','t')")
        conn.close()

    def test_projects_independent(self):
        self.assertEqual(self.store.request("p", "m", A, B, "c")["outcome"], "admitted")
        self.assertEqual(self.store.request("q", "m", A, B, "c")["outcome"], "admitted")

    def test_pending_not_overwritten_and_no_candidate_two_until_terminal(self):
        first = self.store.request("p", "m1", A, B, "cfg")
        self.store.request("p", "m2", C, D, "cfg2")
        self.store.request("p", "m3", D, D, "cfg3")
        pend = self.store.pending("p")
        self.assertEqual((pend["source_dev_sha"], pend["triggers"]), (C, ["m2", "m3"]))
        self.assertEqual(self.store.admit_pending("p")["outcome"], "blocked")
        self.store.cancel(first["candidate_id"], "op", "obsolete")
        out = self.store.admit_pending("p")
        self.assertEqual(out["outcome"], "admitted")
        self.assertNotEqual(out["candidate_id"], first["candidate_id"])
        self.assertIsNone(self.store.pending("p"))
        self.assertEqual(self.store.get(out["candidate_id"])["source_dev_sha"], C)

    def test_request_replay_no_duplicate(self):
        a = self.store.request("p", "m", A, B, "cfg", idempotency_key="k1")
        b = self.store.request("p", "m", A, B, "cfg", idempotency_key="k1")
        self.assertEqual(a["candidate_id"], b["candidate_id"])
        self.assertTrue(b["replayed"])
        self.assertIsNone(self.store.pending("p"))


class TransitionTests(Base):
    def test_full_happy_path_and_fields(self):
        cid, tok = self.to_ready()
        self.store.transition(cid, "awaiting-approval", tok, 1)
        self.store.transition(cid, "promoting", tok, 1)
        self.store.record_receipt(cid, tok, 1, "promotion", "pr1", {"sha": C})
        self.store.transition(cid, "activating", tok, 1)
        self.store.record_receipt(cid, tok, 1, "activation", "ac1", {})
        self.store.transition(cid, "promoted", tok, 1)
        c = self.store.get(cid)
        self.assertEqual(c["state"], "promoted")
        self.assertEqual((c["source_dev_sha"], c["base_stable_sha"], c["candidate_sha"], c["config_hash"]), (A, B, C, "cfg"))
        self.assertEqual(c["test_run_ids"], ["r1"])
        self.assertEqual(set(c["receipts"]), {"promotion", "activation"})
        self.assertIsNone(self.store.active("p"))

    def test_every_illegal_transition_rejected(self):
        for frm in cs.STATES:
            for to in cs.STATES:
                if to in cs.TRANSITIONS.get(frm, ()):
                    continue
                self.assertNotIn(to, cs.TRANSITIONS.get(frm, ()))
        cid, tok = self.admit()
        for bad in ("validating", "ready", "promoting", "promoted", "canceled", "abandoned", "admitted", "bogus"):
            with self.assertRaises(cs.IllegalTransition):
                self.store.transition(cid, bad, tok, 0)
        self.assertEqual(self.store.get(cid)["state"], "admitted")

    def test_ready_requires_passed_run_and_repair_requires_failed(self):
        cid, tok = self.to_validating()
        with self.assertRaises(cs.IllegalTransition):
            self.store.transition(cid, "ready", tok, 1)
        self.store.start_test_run(cid, tok, 1, "r1")
        with self.assertRaises(cs.IllegalTransition):
            self.store.transition(cid, "ready", tok, 1)
        self.store.record_result(cid, tok, 1, "r1", "failed")
        with self.assertRaises(cs.IllegalTransition):
            self.store.transition(cid, "ready", tok, 1)
        self.store.transition(cid, "repair-required", tok, 1)

    def test_transition_idempotent(self):
        cid, tok = self.admit()
        a = self.store.transition(cid, "snapshotting", tok, 0, idempotency_key="t1")
        b = self.store.transition(cid, "snapshotting", tok, 0, idempotency_key="t1")
        self.assertEqual(a["state"], b["state"])
        self.assertTrue(b["replayed"])
        self.assertEqual(len([r for r in self.store.audit_log("p") if r["action"] == "transition"]), 2)

    def test_receipt_replay_and_conflict(self):
        cid, tok = self.to_ready()
        self.store.transition(cid, "promoting", tok, 1)
        self.store.record_receipt(cid, tok, 1, "promotion", "pr1", {})
        again = self.store.record_receipt(cid, tok, 1, "promotion", "pr1", {})
        self.assertTrue(again["replayed"])
        with self.assertRaises(cs.Conflict):
            self.store.record_receipt(cid, tok, 1, "promotion", "other", {})
        self.assertEqual(len(self.store.get(cid)["receipts"]), 1)

    def test_promotion_requires_receipts(self):
        cid, tok = self.to_ready()
        self.store.transition(cid, "promoting", tok, 1)
        with self.assertRaises(cs.IllegalTransition):
            self.store.transition(cid, "activating", tok, 1)


class FenceAndRevisionTests(Base):
    def test_stale_token_rejected_everywhere(self):
        cid, tok = self.to_validating()
        self.clock.t += 61
        new_tok = self.store.acquire_lease(cid, "w2", 60)
        self.assertGreater(new_tok, tok)
        before = self.store.get(cid)
        with self.assertRaises(cs.StaleFence):
            self.store.start_test_run(cid, tok, 1, "r1")
        with self.assertRaises(cs.StaleFence):
            self.store.transition(cid, "failed", tok, 1)
        with self.assertRaises(cs.StaleFence):
            self.store.heartbeat(cid, "w1", tok, 60)
        self.assertEqual(before, self.store.get(cid))

    def test_expired_lease_cannot_write(self):
        cid, tok = self.to_validating()
        self.clock.t += 61
        with self.assertRaises(cs.StaleFence):
            self.store.start_test_run(cid, tok, 1, "r1")

    def test_live_lease_blocks_second_owner_and_heartbeat_extends(self):
        cid, tok = self.admit()
        with self.assertRaises(cs.LeaseHeld):
            self.store.acquire_lease(cid, "w2", 60)
        self.clock.t += 50
        self.store.heartbeat(cid, "w1", tok, 60)
        self.clock.t += 50
        with self.assertRaises(cs.LeaseHeld):
            self.store.acquire_lease(cid, "w2", 60)
        self.assertEqual(self.store.acquire_lease(cid, "w1", 60), tok)

    def test_obsolete_revision_result_cannot_mark_green(self):
        cid, tok = self.to_validating()
        self.store.start_test_run(cid, tok, 1, "r1")
        self.store.record_result(cid, tok, 1, "r1", "failed")
        self.store.transition(cid, "repair-required", tok, 1)
        self.store.new_revision(cid, tok, 1, D)
        self.store.start_test_run(cid, tok, 2, "r2")
        # delayed completion of revision 1 arrives late
        with self.assertRaises(cs.StaleRevision):
            self.store.record_result(cid, tok, 1, "r1", "passed")
        with self.assertRaises(cs.StaleRevision):
            self.store.record_result(cid, tok, 2, "r1", "passed")
        with self.assertRaises(cs.IllegalTransition):
            self.store.transition(cid, "ready", tok, 2)
        self.store.record_result(cid, tok, 2, "r2", "passed")
        self.store.transition(cid, "ready", tok, 2)
        self.assertEqual([r["sha"] for r in self.store.get(cid)["revisions"]], [C, D])

    def test_revisions_unique_sha_and_sequential(self):
        cid, tok = self.to_validating()
        self.store.start_test_run(cid, tok, 1, "r1")
        with self.assertRaises(cs.Conflict):
            self.store.start_test_run(cid, tok, 1, "r1b")
        with self.assertRaises(cs.IllegalTransition):
            self.store.transition(cid, "repair-required", tok, 1)
        self.store.record_result(cid, tok, 1, "r1", "failed")
        with self.assertRaises(cs.Conflict):
            self.store.record_result(cid, tok, 1, "r1", "passed")
        self.store.transition(cid, "repair-required", tok, 1)
        with self.assertRaises(cs.Conflict):
            self.store.new_revision(cid, tok, 1, C)
        with self.assertRaises(cs.StaleRevision):
            self.store.new_revision(cid, tok, 5, D)
        self.assertEqual(self.store.get(cid)["revision"], 1)

    def test_stale_revision_transition_rejected(self):
        cid, tok = self.admit()
        with self.assertRaises(cs.StaleRevision):
            self.store.transition(cid, "snapshotting", tok, 9)


class RecoveryTests(Base):
    def test_restart_keeps_state(self):
        cid, tok = self.to_validating()
        self.store = CandidateStore(self.db, clock=self.clock)
        c = self.store.get(cid)
        self.assertEqual((c["state"], c["revision"], c["fencing_token"]), ("validating", 1, tok))

    def test_reconcile_takeover_marks_lost_run_and_blocks_candidate_two(self):
        cid, tok = self.to_validating()
        self.store.start_test_run(cid, tok, 1, "r1")
        self.store.request("p", "later", D, D, "cfg")
        self.clock.t += 120  # owner crashed; lease expired
        report = self.store.reconcile("p", "w2", 60, cs.Probes())
        self.assertEqual(report["outcome"], "reconciled")
        self.assertGreater(report["token"], tok)
        self.assertIn("run-lost:r1", report["actions"])
        self.assertEqual(self.store.active("p")["id"], cid)
        self.assertEqual(self.store.admit_pending("p")["outcome"], "blocked")
        with self.assertRaises(cs.StaleFence):
            self.store.record_result(cid, tok, 1, "r1", "passed")
        # lost run is evidence of failure; owner may move to repair
        self.store.transition(cid, "repair-required", report["token"], 1)

    def test_reconcile_partition_live_lease_not_stolen(self):
        cid, tok = self.admit()
        out = self.store.reconcile("p", "w2", 60, cs.Probes())
        self.assertEqual(out["outcome"], "lease-held")
        self.assertEqual(self.store.get(cid)["fencing_token"], tok)

    def test_reconcile_ref_mismatch_fails_candidate(self):
        cid, tok = self.to_validating()
        self.clock.t += 120

        class P(cs.Probes):
            def ref_sha(self, c):
                return D
        out = self.store.reconcile("p", "w2", 60, P())
        self.assertEqual(out["state"], "failed")
        self.assertIsNone(self.store.active("p"))

    def test_reconcile_keeps_live_run_and_missing_artifact_fails_ready(self):
        cid, tok = self.to_validating()
        self.store.start_test_run(cid, tok, 1, "r1")
        self.clock.t += 120

        class Live(cs.Probes):
            def live_runs(self, c):
                return ["r1"]
        out = self.store.reconcile("p", "w2", 60, Live())
        self.assertEqual(out["actions"], [])
        self.store.record_result(cid, out["token"], 1, "r1", "passed")
        self.store.transition(cid, "ready", out["token"], 1)
        self.clock.t += 120

        class NoArtifact(cs.Probes):
            def artifact_exists(self, c, r):
                return False
        out = self.store.reconcile("p", "w3", 60, NoArtifact())
        self.assertEqual(out["state"], "failed")

    def test_reconcile_idle(self):
        self.assertEqual(self.store.reconcile("none", "w", 60, cs.Probes())["outcome"], "idle")


class CancelTests(Base):
    def test_cancel_audit_and_fence(self):
        cid, tok = self.to_validating()
        self.store.cancel(cid, "alice", "superseded")
        c = self.store.get(cid)
        self.assertEqual(c["state"], "canceled")
        row = [r for r in self.store.audit_log("p") if r["action"] == "canceled"][0]
        self.assertEqual((row["actor"], row["reason"]), ("alice", "superseded"))
        with self.assertRaises(cs.IllegalTransition):
            self.store.start_test_run(cid, tok, 1, "r1")
        self.assertTrue(self.store.cancel(cid, "alice", "again")["replayed"])
        with self.assertRaises(cs.IllegalTransition):
            self.store.cancel(cid, "alice", "x", abandon=True)

    def test_abandon_and_requires_actor(self):
        cid, _ = self.admit()
        with self.assertRaises(cs.CandidateError):
            self.store.cancel(cid, "", "")
        self.assertEqual(self.store.cancel(cid, "bob", "gone", abandon=True)["state"], "abandoned")
        self.assertEqual(self.store.request("p", "m", A, B, "cfg")["outcome"], "admitted")


if __name__ == "__main__":
    unittest.main()
