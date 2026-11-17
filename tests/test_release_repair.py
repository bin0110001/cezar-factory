import os
import subprocess
import tempfile
import threading
import unittest

from scripts.release import release_repair as rr


def git_new_enough():
    p = subprocess.run(["git", "--version"], capture_output=True, text=True)
    parts = p.stdout.split()[2].split(".")
    return (int(parts[0]), int(parts[1])) >= (2, 38)


class Ledger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = rr.RepairLedger(os.path.join(self.tmp.name, "repair.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def open(self, key="fail-1", **kw):
        args = dict(candidate_id="c1", revision=1, current_revision=1, failure_key=key, scope=["src/a.py"], validation_terminal=True, now=1.0)
        args.update(kw)
        return self.ledger.open_repair(**args)


class Tasks(Ledger):
    def test_duplicate_repair_events_return_one_task(self):
        first, again = self.open(), self.open()
        self.assertFalse(first["replayed"])
        self.assertTrue(again["replayed"])
        self.assertEqual(first["id"], again["id"])
        self.assertNotEqual(self.open("fail-2")["id"], first["id"])

    def test_concurrent_duplicate_events_create_one_task(self):
        ids, errors = [], []

        def go():
            try:
                ids.append(self.open()["id"])
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        threads = [threading.Thread(target=go) for _ in range(20)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(len(set(ids)), 1)

    def test_obsolete_revision_nonterminal_runs_and_unscoped_repairs_are_refused(self):
        with self.assertRaises(rr.RepairError):
            self.open(revision=1, current_revision=2)
        with self.assertRaises(rr.RepairError):
            self.open(validation_terminal=False)
        with self.assertRaises(rr.RepairError):
            self.open(scope=[])

    def test_attempt_cap_escalates_instead_of_looping(self):
        t = self.open(max_attempts=3)
        outcomes = [self.ledger.record_attempt(t["id"], outcome="failed", cost=1.0, now=2.0 + i) for i in range(3)]
        self.assertEqual([o["status"] for o in outcomes], ["open", "open", "escalated"])
        self.assertEqual(outcomes[-1]["escalation"], "abandon")
        again = self.ledger.record_attempt(t["id"], outcome="failed", cost=1.0, now=9.0)
        self.assertEqual((again["status"], again["attempts"]), ("escalated", 3))  # no further attempts counted

    def test_cost_and_time_caps_and_manual_review_escalation(self):
        costly = self.open("k1", max_cost=2.0)
        self.assertEqual(self.ledger.record_attempt(costly["id"], outcome="failed", cost=2.5, now=2.0, manual_review=True)["escalation"], "manual")
        slow = self.open("k2", max_seconds=60)
        self.assertEqual(self.ledger.record_attempt(slow["id"], outcome="failed", cost=0.1, now=200.0)["status"], "escalated")

    def test_a_fix_completes_the_task(self):
        t = self.open()
        self.assertEqual(self.ledger.record_attempt(t["id"], outcome="fixed", cost=0.5, now=2.0)["status"], "done")


class Obligations(Ledger):
    def test_one_forward_port_per_patch_even_with_duplicate_events(self):
        t = self.open()
        a = self.ledger.register_fix(t["id"], fix_sha="f" * 40, patch_id="p1", now=2.0)
        b = self.ledger.register_fix(t["id"], fix_sha="e" * 40, patch_id="p1", now=3.0)  # same patch, rebased SHA
        self.assertEqual((a["replayed"], b["replayed"], a["id"]), (False, True, b["id"]))
        self.assertEqual(len(self.ledger.obligations("c1")), 1)

    def test_states_receipts_and_waiver_rules(self):
        fp = self.ledger.register_fix(self.open()["id"], fix_sha="f" * 40, patch_id="p1", now=2.0)["id"]
        self.ledger.set_state(fp, "conflict", actor="system", now=3.0, detail={"paths": ["a"]})
        with self.assertRaises(rr.RepairError):
            self.ledger.set_state(fp, "waived", actor="agent", now=4.0)
        self.ledger.set_state(fp, "applied", actor="resolver", now=5.0)
        self.assertEqual(self.ledger.set_state(fp, "applied", actor="resolver", now=6.0), "applied")  # replay is a no-op
        with self.assertRaises(rr.RepairError):
            self.ledger.set_state(fp, "conflict", actor="system", now=7.0)  # terminal
        trail = [(r["from_state"], r["to_state"]) for r in self.ledger.receipts(fp)]
        self.assertEqual(trail, [(None, "pending"), ("pending", "conflict"), ("conflict", "applied")])

    def test_single_controlled_conflict_resolution(self):
        fp = self.ledger.register_fix(self.open()["id"], fix_sha="f" * 40, patch_id="p1", now=2.0)["id"]
        self.assertFalse(self.ledger.claim_conflict(fp, "agent-a"))  # not in conflict yet
        self.ledger.set_state(fp, "conflict", actor="system", now=3.0)
        self.assertTrue(self.ledger.claim_conflict(fp, "agent-a"))
        self.assertTrue(self.ledger.claim_conflict(fp, "agent-a"))
        self.assertFalse(self.ledger.claim_conflict(fp, "agent-b"))
        self.ledger.set_state(fp, "applied", actor="agent-a", now=4.0)

    def test_unresolved_candidate_authored_fixes_block_stable_by_default(self):
        t = self.open()
        a = self.ledger.register_fix(t["id"], fix_sha="a" * 40, patch_id="p1", now=2.0)["id"]
        b = self.ledger.register_fix(t["id"], fix_sha="b" * 40, patch_id="p2", authored_by_candidate=False, now=2.0)["id"]
        self.assertEqual(self.ledger.blocks_stable("c1"), [a])
        self.assertEqual(sorted(self.ledger.blocks_stable("c1", block_all=True)), sorted([a, b]))
        self.assertEqual(self.ledger.blocks_stable("c1", block_authored=False), [])
        self.ledger.set_state(a, "equivalent", actor="system", now=3.0)
        self.assertEqual(self.ledger.blocks_stable("c1"), [])
        c = self.ledger.register_fix(t["id"], fix_sha="c" * 40, patch_id="p3", now=4.0)["id"]
        self.ledger.set_state(c, "waived", actor="operator", now=5.0)
        self.assertEqual(self.ledger.blocks_stable("c1"), [])


class GitClassification(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.sh("init", "-q", "-b", "dev")
        for k, v in (("user.email", "t@example.org"), ("user.name", "t"), ("commit.gpgsign", "false")):
            self.sh("config", k, v)
        self.write("a.txt", "one\ntwo\nthree\n")
        self.base = self.commit("base")
        self.sh("checkout", "-q", "-b", "candidate")

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, *a):
        return subprocess.run(["git", "-C", self.dir, *a], capture_output=True, text=True, check=True).stdout.strip()

    def write(self, name, text):
        with open(os.path.join(self.dir, name), "w", newline="\n") as f:
            f.write(text)

    def commit(self, msg):
        self.sh("add", "-A")
        self.sh("commit", "-q", "-m", msg)
        return self.sh("rev-parse", "HEAD")

    def fix_on_candidate(self, text="one\nTWO\nthree\n", name="a.txt"):
        self.write(name, text)
        return self.commit("fix")

    def test_patch_id_is_stable_across_rebased_shas(self):
        fix = self.fix_on_candidate()
        self.sh("checkout", "-q", "dev")
        self.write("b.txt", "unrelated\n")
        self.commit("dev moves")
        self.sh("cherry-pick", "-x", fix)
        picked = self.sh("rev-parse", "HEAD")
        self.assertNotEqual(picked, fix)
        self.assertEqual(rr.patch_id(self.dir, fix), rr.patch_id(self.dir, picked))

    @unittest.skipUnless(git_new_enough(), "needs git >= 2.38 for merge-tree --write-tree")
    def test_equivalent_pending_and_conflict_are_detected(self):
        fix = self.fix_on_candidate()
        self.sh("checkout", "-q", "dev")
        self.write("b.txt", "unrelated\n")
        dev_other = self.commit("dev moves")
        self.assertEqual(rr.classify_forward_port(self.dir, dev_tip=dev_other, fix_sha=fix, base_sha=self.base), "pending")
        self.sh("cherry-pick", "-x", fix)
        dev_fixed = self.sh("rev-parse", "HEAD")
        self.assertEqual(rr.classify_forward_port(self.dir, dev_tip=dev_fixed, fix_sha=fix, base_sha=self.base), "equivalent")
        self.sh("checkout", "-q", "-B", "dev2", self.base)
        self.write("a.txt", "one\nDEV\nthree\n")
        dev_conflicting = self.commit("dev edits the same line differently")
        self.assertEqual(rr.classify_forward_port(self.dir, dev_tip=dev_conflicting, fix_sha=fix, base_sha=self.base), "conflict")

    def test_undecidable_input_is_reported_as_conflict_not_a_pass(self):
        self.assertEqual(rr.classify_forward_port(self.dir, dev_tip="0" * 40, fix_sha="1" * 40, base_sha=self.base), "conflict")


class Emergency(unittest.TestCase):
    def test_active_candidate_requires_an_explicit_decision(self):
        active = {"id": "c1"}
        blocked = rr.plan_emergency(active_candidate=active, decision=None)
        self.assertFalse(blocked["allowed"])
        self.assertFalse(rr.plan_emergency(active_candidate=active, decision="ignore")["allowed"])
        for d in ("reconcile", "revise", "abandon"):
            plan = rr.plan_emergency(active_candidate=active, decision=d)
            self.assertTrue(plan["allowed"], d)
            self.assertIn("open-forward-port-to-dev", plan["actions"])
        self.assertTrue(rr.plan_emergency(active_candidate=None, decision=None)["allowed"])


if __name__ == "__main__":
    unittest.main()
