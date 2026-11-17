import json
import os
import tempfile
import unittest

from scripts.release import release_action_inbox as inbox
from scripts.release.release_candidate_store import CandidateStore

CTX = {"devSha": "a" * 40, "baseStableSha": "b" * 40, "configHash": "sha256:" + "c" * 64}
NOW = 1_800_000_000.0
context = lambda project: CTX  # noqa: E731


def req(i, action, project="tableflux", **over):
    r = {"id": i, "at": f"2026-11-17T12:00:{int(i[-1]) if i[-1].isdigit() else 0:02d}Z", "actor": "local-operator", "action": action, "projectId": project,
         "candidateId": None, "reason": "operator asked", "confirmed": False}
    r.update(over)
    return r


def log(*rows):
    return "\n".join(json.dumps(r) for r in rows) + "\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = CandidateStore(os.path.join(self.tmp.name, "c.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def run_actions(self, *rows, decided="", ctx=context):
        return inbox.process(self.store, log(*rows), decided, context=ctx, now=NOW)

    def open_candidate(self):
        return self.store.request("tableflux", trigger="manual", reason="x", dev_sha="a" * 40, base_stable_sha="b" * 40, config_hash=CTX["configHash"], now=NOW)["candidateId"]


class Create(Base):
    def test_create_opens_one_candidate_and_a_second_folds_into_the_single_pending_request(self):
        [d] = self.run_actions(req("r1", "create"))
        self.assertEqual((d["outcome"], d["result"]), ("applied", "admitted"))
        self.assertEqual(self.store.active("tableflux")["id"], d["candidateId"])
        [d2] = self.run_actions(req("r2", "create"))
        self.assertEqual(d2["result"], "pending")
        self.assertEqual(self.store.pending_request("tableflux")["history"][0]["trigger"], "manual")

    def test_create_without_engine_context_is_rejected_not_guessed(self):
        [d] = self.run_actions(req("r1", "create"), ctx=lambda p: None)
        self.assertEqual(d["outcome"], "rejected")
        self.assertIsNone(self.store.active("tableflux"))


class Destructive(Base):
    def test_cancel_and_abandon_need_confirmation_and_end_only_the_active_candidate(self):
        cid = self.open_candidate()
        [d] = self.run_actions(req("r1", "cancel", candidateId=cid))
        self.assertEqual(d["outcome"], "rejected")
        self.assertIn("not confirmed", d["reason"])
        self.assertEqual(self.store.get(cid)["state"], "requested")
        [d] = self.run_actions(req("r2", "cancel", candidateId=cid, confirmed=True))
        self.assertEqual((d["outcome"], d["to"]), ("applied", "canceled"))
        self.assertEqual(self.store.get(cid)["state"], "canceled")
        self.assertIsNone(self.store.active("tableflux"))

    def test_abandon_fences_out_the_lease_holder(self):
        cid = self.open_candidate()
        before = self.store.get(cid)["fencing"]
        [d] = self.run_actions(req("r1", "abandon", candidateId=cid, confirmed=True))
        self.assertEqual(d["to"], "abandoned")
        self.assertGreater(self.store.get(cid)["fencing"], before)

    def test_an_action_naming_another_or_a_finished_candidate_is_rejected_and_changes_nothing(self):
        cid = self.open_candidate()
        [d] = self.run_actions(req("r1", "cancel", candidateId="cand-other", confirmed=True))
        self.assertEqual(d["outcome"], "rejected")
        self.assertIn(cid, d["reason"])
        self.assertEqual(self.store.get(cid)["state"], "requested")
        self.store.end(cid, "canceled", actor="x", reason="x", now=NOW)
        [d] = self.run_actions(req("r2", "cancel", candidateId=cid, confirmed=True))
        self.assertIn("no active candidate", d["reason"])


class HoldsAndRetry(Base):
    def test_pause_and_resume_are_recorded_holds_that_leave_candidate_state_alone(self):
        cid = self.open_candidate()
        decided = log(*self.run_actions(req("r1", "pause", candidateId=cid)))
        self.assertEqual(self.store.get(cid)["state"], "requested")
        self.assertEqual(inbox.paused_projects(decided), {"tableflux"})
        decided += log(*self.run_actions(req("r2", "resume", candidateId=cid), decided=decided))
        self.assertEqual(inbox.paused_projects(decided), set())

    def test_retry_is_only_for_a_candidate_that_needs_repair(self):
        cid = self.open_candidate()
        [d] = self.run_actions(req("r1", "retry", candidateId=cid))
        self.assertEqual(d["outcome"], "rejected")
        self.assertIn("needs repair", d["reason"])

    def test_retry_of_a_failed_candidate_starts_a_new_one_and_with_nothing_failed_is_rejected(self):
        [d] = self.run_actions(req("r0", "retry"))
        self.assertEqual(d["outcome"], "rejected")
        cid = self.open_candidate()
        self.store.end(cid, "failed", actor="x", reason="boom", now=NOW)
        [d] = self.run_actions(req("r1", "retry"))
        self.assertEqual((d["outcome"], d["result"]), ("applied", "admitted"))
        self.assertNotEqual(self.store.active("tableflux")["id"], cid)


class Idempotent(Base):
    def test_a_decided_request_is_never_applied_twice_and_damaged_lines_are_skipped(self):
        r = req("r1", "create")
        first = self.run_actions(r)
        decided = log(*first)
        self.assertEqual(inbox.process(self.store, log(r) + "{broken\n", decided, context=context, now=NOW), [])
        self.assertEqual(len(self.store.audit_log("tableflux")), 1)

    def test_unknown_actions_are_rejected(self):
        [d] = self.run_actions(req("r1", "explode"))
        self.assertEqual(d["outcome"], "rejected")


if __name__ == "__main__":
    unittest.main()
