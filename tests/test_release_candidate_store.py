import json
import os
import pathlib
import sqlite3
import tempfile
import threading
import unittest

from scripts.release.release_candidate_store import CandidateStore, StoreError

SHA = lambda c: c * 40  # noqa: E731


def scalar(path, sql):
    db = sqlite3.connect(path)
    try:
        return db.execute(sql).fetchone()[0]
    finally:
        db.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "candidates.db")
        self.store = CandidateStore(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def req(self, project="p", key=None, trigger="manual", now=1.0, store=None):
        return (store or self.store).request(project, trigger=trigger, reason="test", dev_sha=SHA("a"), base_stable_sha=SHA("b"), config_hash="sha256:x", now=now, idempotency_key=key)

    def walk_to_validating(self, cid, owner="w1", now=10.0):
        f = self.store.acquire(cid, owner, now=now, ttl=100)
        v = 0
        for to in ("admitted", "snapshotting"):
            v = self.store.transition(cid, to, fencing=f, version=v, now=now)["version"]
        self.store.new_revision(cid, fencing=f, version=v, dev_sha=SHA("a"), candidate_sha=SHA("c"), now=now)
        v += 1
        v = self.store.transition(cid, "validating", fencing=f, version=v, now=now)["version"]
        return f, v


class SingleActive(Base):
    def test_hundred_concurrent_requests_admit_exactly_one(self):
        results, errors = [], []

        def worker(i):
            try:
                results.append(self.req(trigger=("schedule", "change", "manual")[i % 3], now=float(i), store=CandidateStore(self.path)))
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(100)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(sum(r["result"] == "admitted" for r in results), 1)
        self.assertEqual(sum(r["result"] == "pending" for r in results), 99)
        self.assertEqual(scalar(self.path, "SELECT COUNT(*) FROM candidates"), 1)
        pending = self.store.pending_request("p")
        self.assertEqual(len(pending["history"]), 99)  # one durable request carrying every reason

    def test_database_itself_refuses_a_second_active_candidate(self):
        self.req()
        db = sqlite3.connect(self.path)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO candidates(id,project_id,state,version,revision,dev_sha,base_stable_sha,config_hash,created_at,updated_at) VALUES('x','p','requested',0,0,'a','b','c',1,1)")
        finally:
            db.close()

    def test_projects_are_independent_and_pending_is_not_auto_started(self):
        a, b = self.req("p1"), self.req("p2")
        self.assertEqual((a["result"], b["result"]), ("admitted", "admitted"))
        self.req("p1", trigger="change")
        self.assertIsNone(self.store.take_pending("p1"))  # active candidate still running
        self.store.end(a["candidateId"], "canceled", actor="op", reason="test", now=2.0)
        self.assertEqual(self.store.take_pending("p1")["history"][0]["trigger"], "change")
        self.assertIsNone(self.store.active("p1"))
        self.assertEqual(self.req("p1", now=3.0)["result"], "admitted")  # only now can the next one start

    def test_replayed_event_creates_no_duplicate(self):
        first = self.req(key="evt-1")
        again = self.req(key="evt-1")
        self.assertTrue(again["replayed"])
        self.assertEqual(first["candidateId"], again["candidateId"])
        restarted = CandidateStore(self.path)
        self.assertTrue(self.req(key="evt-1", store=restarted)["replayed"])
        self.assertEqual(scalar(self.path, "SELECT COUNT(*) FROM candidates"), 1)


class Transitions(Base):
    def test_legal_path_to_promoted_with_idempotent_receipt(self):
        cid = self.req()["candidateId"]
        f, v = self.walk_to_validating(cid)
        self.store.record_result(cid, revision=1, run_id="r1", status="passed", evidence={"n": 1}, fencing=f, now=11)
        v = self.store.transition(cid, "ready", fencing=f, version=v, now=11)["version"]
        for to in ("promoting", "activating"):
            v = self.store.transition(cid, to, fencing=f, version=v, now=12)["version"]
        first = self.store.record_promotion(cid, receipt_id="rcpt-1", body={"sha": SHA("c")}, fencing=f, now=13)
        replay = self.store.record_promotion(cid, receipt_id="rcpt-1", body={"sha": SHA("c")}, fencing=f, now=14)
        self.assertEqual((first["replayed"], replay["replayed"]), (False, True))
        self.store.transition(cid, "promoted", fencing=f, version=v, now=15)
        self.assertEqual(self.store.get(cid)["state"], "promoted")
        self.assertEqual(self.req(now=16)["result"], "admitted")

    def test_illegal_transitions_and_green_requirement(self):
        cid = self.req()["candidateId"]
        f = self.store.acquire(cid, "w1", now=1, ttl=100)
        with self.assertRaises(StoreError):
            self.store.transition(cid, "validating", fencing=f, version=0, now=1)  # skips states
        f, v = self.walk_to_validating(self.req("q")["candidateId"], "w2")
        cid2 = self.store.active("q")["id"]
        with self.assertRaises(StoreError):
            self.store.transition(cid2, "ready", fencing=f, version=v, now=11)  # no passing evidence yet
        self.store.record_result(cid2, revision=1, run_id="rf", status="failed", evidence={}, fencing=f, now=11)
        with self.assertRaises(StoreError):
            self.store.transition(cid2, "ready", fencing=f, version=v, now=11)  # a failing result blocks green

    def test_stale_version_is_refused(self):
        cid = self.req()["candidateId"]
        f = self.store.acquire(cid, "w1", now=1, ttl=100)
        self.store.transition(cid, "admitted", fencing=f, version=0, now=1)
        with self.assertRaises(StoreError):
            self.store.transition(cid, "snapshotting", fencing=f, version=0, now=1)


class Fencing(Base):
    def test_stale_owner_cannot_write_after_lease_takeover(self):
        cid = self.req()["candidateId"]
        a = self.store.acquire(cid, "A", now=1, ttl=10)
        with self.assertRaises(StoreError):
            self.store.acquire(cid, "B", now=5, ttl=10)  # A still holds the lease
        b = self.store.acquire(cid, "B", now=20, ttl=10)  # A's lease lapsed (partition/crash)
        self.assertGreater(b, a)
        with self.assertRaises(StoreError):
            self.store.transition(cid, "admitted", fencing=a, version=0, now=21)
        self.store.transition(cid, "admitted", fencing=b, version=0, now=21)

    def test_renew_keeps_token_and_expired_lease_cannot_mutate(self):
        cid = self.req()["candidateId"]
        f = self.store.acquire(cid, "A", now=1, ttl=10)
        self.assertEqual(self.store.acquire(cid, "A", now=5, ttl=10), f)
        with self.assertRaises(StoreError):
            self.store.transition(cid, "admitted", fencing=f, version=0, now=100)

    def test_survives_restart_and_reports_stale_work_for_reconciliation(self):
        cid = self.req()["candidateId"]
        self.store.acquire(cid, "A", now=1, ttl=10)
        restarted = CandidateStore(self.path)
        self.assertEqual([c["id"] for c in restarted.stale_candidates(now=5)], [])
        self.assertEqual([c["id"] for c in restarted.stale_candidates(now=50)], [cid])
        self.assertEqual(restarted.request("p", trigger="schedule", reason="x", dev_sha=SHA("d"), base_stable_sha=SHA("b"), config_hash="h", now=60)["result"], "pending")

    def test_operator_end_fences_out_the_holder_and_is_audited(self):
        cid = self.req()["candidateId"]
        f = self.store.acquire(cid, "A", now=1, ttl=100)
        self.store.end(cid, "abandoned", actor="operator", reason="stuck", now=2)
        with self.assertRaises(StoreError):
            self.store.transition(cid, "admitted", fencing=f, version=0, now=3)
        events = [e["event"] for e in self.store.audit_log("p")]
        self.assertIn("end", events)
        self.assertEqual(json.loads([e for e in self.store.audit_log("p") if e["event"] == "end"][0]["detail"])["reason"], "stuck")


class Revisions(Base):
    def test_repair_creates_sequential_revision_and_late_result_is_rejected(self):
        cid = self.req()["candidateId"]
        f, v = self.walk_to_validating(cid)
        v = self.store.transition(cid, "repair-required", fencing=f, version=v, now=12)["version"]
        rev = self.store.new_revision(cid, fencing=f, version=v, dev_sha=SHA("a"), candidate_sha=SHA("e"), now=13)
        self.assertEqual(rev, 2)
        with self.assertRaises(StoreError):
            self.store.record_result(cid, revision=1, run_id="late", status="passed", evidence={}, fencing=f, now=14)
        v += 1
        v = self.store.transition(cid, "revalidating", fencing=f, version=v, now=14)["version"]
        with self.assertRaises(StoreError):
            self.store.transition(cid, "ready", fencing=f, version=v, now=15)  # revision 1's old pass does not count
        self.store.record_result(cid, revision=2, run_id="ok2", status="passed", evidence={}, fencing=f, now=15)
        self.store.transition(cid, "ready", fencing=f, version=v, now=16)

    def test_revision_sha_unique_and_evidence_immutable(self):
        cid = self.req()["candidateId"]
        f, v = self.walk_to_validating(cid)
        self.store.record_result(cid, revision=1, run_id="r1", status="passed", evidence={}, fencing=f, now=11)
        with self.assertRaises(StoreError):
            self.store.record_result(cid, revision=1, run_id="r1", status="failed", evidence={}, fencing=f, now=12)
        v = self.store.transition(cid, "repair-required", fencing=f, version=v, now=13)["version"]
        with self.assertRaises(StoreError):
            self.store.new_revision(cid, fencing=f, version=v, dev_sha=SHA("a"), candidate_sha=SHA("c"), now=14)  # same SHA as revision 1


if __name__ == "__main__":
    unittest.main()
