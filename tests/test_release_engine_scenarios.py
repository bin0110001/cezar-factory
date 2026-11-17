"""Local sandbox scenarios for the release engine (#642): real temporary git repositories, no GitHub, no network.

Each test drives several release modules together, the way the pipeline will, and asserts the safety properties: dev stays
writable, stable history is only ever fast-forwarded, one candidate is active per project, and nothing fails open.
"""

import os
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timezone

from scripts.release import release_pipeline_config as cfg
from scripts.release import release_promotion as rp
from scripts.release import release_repair as rr
from scripts.release import release_snapshot as rs
from scripts.release import release_triggers as rt
from scripts.release import release_verification as rv
from scripts.release import scanner_status as ss
from scripts.release.release_candidate_store import CandidateStore

UTC = timezone.utc
NOW = 1000.0
SUITE = [{"id": "unit", "required": True, "adapterVersion": "1"}]
OK = {"allowed": True, "reasons": [], "warnings": []}


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, "repo")
        os.mkdir(self.dir)
        self.git = rs.Git(self.dir)
        self.sh("init", "-q", "-b", "dev")
        for k, v in (("user.email", "t@example.org"), ("user.name", "t"), ("commit.gpgsign", "false")):
            self.sh("config", k, v)
        self.n = 0
        self.stable = self.commit()
        self.sh("branch", "stable", self.stable)
        self.store = CandidateStore(os.path.join(self.tmp.name, "c.db"))
        self.ledger = rp.PromotionLedger(os.path.join(self.tmp.name, "p.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, *a):
        return subprocess.run(["git", "-C", self.dir, *a], capture_output=True, text=True, check=True).stdout.strip()

    def commit(self):
        self.n += 1
        write(os.path.join(self.dir, "f"), str(self.n))
        self.sh("add", "-A")
        self.sh("commit", "-q", "-m", f"c{self.n}")
        return self.sh("rev-parse", "HEAD")

    def manifest(self, sha, cid="c1", **over):
        args = dict(candidate_id=cid, revision=1, sha=sha, config_hash="cfg", asset_hash="as", env_hash="env", suites=SUITE)
        args.update(over)
        return rv.build_manifest(**args)

    def passing(self, m):
        return rv.gate(m, [rv.evidence_record(m, "unit", status="passed", at=NOW)], now=NOW + 1)

    def promote(self, m, mode="auto"):
        decision = rp.authorize(manifest=m, gate=self.passing(m), mode=mode, approval=None, forward_port_blockers=[], now=NOW + 5)
        p = self.ledger.begin(project_id="p", manifest=m, prior_stable_sha=self.sh("rev-parse", "stable"), decision=decision, actor="promoter", now=NOW + 6)
        self.ledger.move_stable(p["id"], self.git, stable_branch="stable", now=NOW + 7)
        return p["id"]


class Ancestry(Sandbox):
    def test_dev_stays_writable_while_a_candidate_is_frozen_and_stable_only_fast_forwards(self):
        tested = self.commit()
        snap = rs.create_snapshot(self.git, candidate_id="c1", revision=1, dev_sha=tested, base_stable_sha=self.stable, config_hash="cfg", fingerprints={})
        self.assertTrue(snap.ok)
        for _ in range(5):
            self.commit()  # dev keeps accepting merges
        stable_log_before = self.sh("rev-list", "stable")
        self.promote(self.manifest(tested))
        self.assertEqual(self.sh("rev-parse", "stable"), tested)
        self.assertTrue(self.sh("rev-list", "stable").endswith(stable_log_before))  # history only grew at the tip
        self.assertNotEqual(self.sh("rev-parse", "dev"), tested)  # newer dev is not promoted with it

    def test_two_stage_compatibility_needs_no_regression_branch(self):
        spec = cfg.effective_config({"schemaVersion": cfg.SCHEMA_VERSION, "projects": {"legacy": {}}}, "legacy")
        self.assertEqual([s["branch"] for s in spec["stages"]], ["dev", "stable"])
        tested = self.commit()
        snap = rs.create_snapshot(self.git, candidate_id="c2", revision=1, dev_sha=tested, base_stable_sha=self.stable, config_hash="cfg", fingerprints={}, regression_branch=None)
        self.assertTrue(snap.ok and not snap.pointer_moved)
        self.assertEqual(sorted(self.sh("for-each-ref", "--format=%(refname)", "refs/heads").split()), ["refs/heads/dev", "refs/heads/stable"])


class DriftAndCrash(Sandbox):
    def test_unexpected_stable_writer_is_detected_and_never_overwritten(self):
        tested = self.commit()
        m = self.manifest(tested)
        decision = rp.authorize(manifest=m, gate=self.passing(m), mode="auto", approval=None, forward_port_blockers=[], now=NOW + 5)
        p = self.ledger.begin(project_id="p", manifest=m, prior_stable_sha=self.stable, decision=decision, actor="promoter", now=NOW + 6)
        intruder = self.commit()
        self.sh("update-ref", "refs/heads/stable", intruder)
        with self.assertRaises(rp.PromotionError):
            self.ledger.move_stable(p["id"], self.git, stable_branch="stable", now=NOW + 7)
        self.assertEqual(self.sh("rev-parse", "stable"), intruder)
        self.assertTrue(rp.detect_drift(stable_ref_sha=intruder, serving_sha=self.stable, last_active_sha=self.stable)["drift"])

    def test_crash_mid_promotion_resumes_then_activation_failure_rolls_back_cleanly(self):
        tested = self.commit()
        pid = self.promote(self.manifest(tested))
        self.ledger.begin_activation(pid, now=NOW + 8)
        self.assertEqual([r["id"] for r in self.ledger.stale_activations(now=NOW + 900, timeout=60)], [pid])  # the supervisor sees it after a crash
        out = self.ledger.fail_activation(pid, self.git, stable_branch="stable", reason="health failed after restart", now=NOW + 901)
        self.assertTrue(out["restored"])
        self.assertEqual(self.sh("rev-parse", "stable"), self.stable)
        self.assertTrue(self.ledger.is_quarantined(tested))


class Triggers(Sandbox):
    def test_concurrent_triggers_leave_exactly_one_active_candidate(self):
        results = []

        def fire(i):
            s = CandidateStore(os.path.join(self.tmp.name, "c.db"))
            results.append(s.request("p", trigger=("schedule", "change", "manual")[i % 3], reason="r", dev_sha="d" * 40, base_stable_sha=self.stable, config_hash="h", now=float(i)))
        threads = [threading.Thread(target=fire, args=(i,)) for i in range(40)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sum(r["result"] == "admitted" for r in results), 1)
        self.assertEqual(len(self.store.pending_request("p")["history"]), 39)

    def test_dst_transition_keeps_the_local_schedule_time(self):
        sched = {"frequency": "daily", "hour": 3, "minute": 0, "timezone": "America/Detroit"}
        ticks = rt.occurrences(sched, datetime(2026, 3, 7, 0, tzinfo=UTC), datetime(2026, 3, 10, 0, tzinfo=UTC))
        local = [t.astimezone(__import__("zoneinfo").ZoneInfo("America/Detroit")) for t in ticks]
        self.assertEqual([(t.hour, t.minute) for t in local], [(3, 0), (3, 0), (3, 0)])  # 3:00 local on both sides of the jump
        self.assertEqual(len(ticks), 3)


class OutageAndRetry(Sandbox):
    def test_a_scanner_outage_never_promotes(self):
        tested = self.commit()
        m = self.manifest(tested, suites=SUITE + [{"id": "sca", "required": True, "adapterVersion": "1", "advisoryBound": True}], advisory_refresh="adv1")
        state = ss.classify_scan(executed=True, feed_available=False, completed_at=None, max_age_hours=24, now=NOW)
        self.assertEqual(state, "outage")
        evidence = [rv.evidence_record(m, "unit", status="passed", at=NOW), rv.evidence_record(m, "sca", status="unknown" if state != "clean" else "passed", at=NOW)]
        gate = rv.gate(m, evidence, now=NOW + 1)
        self.assertEqual(gate["blocking"], ["sca"])
        decision = rp.authorize(manifest=m, gate=gate, mode="auto", approval=None, forward_port_blockers=[], now=NOW + 2)
        self.assertFalse(decision["allowed"])
        with self.assertRaises(rp.PromotionError):
            self.ledger.begin(project_id="p", manifest=m, prior_stable_sha=self.stable, decision=decision, actor="promoter", now=NOW + 3)
        self.assertEqual(self.sh("rev-parse", "stable"), self.stable)

    def test_retries_back_off_and_a_stuck_repair_escalates_instead_of_looping(self):
        self.assertEqual([ss.backoff_delay(n, base=60, cap=240) for n in (1, 2, 3, 4, 9)], [60, 120, 240, 240, 240])
        ledger = rr.RepairLedger(os.path.join(self.tmp.name, "r.db"))
        t = ledger.open_repair(candidate_id="c1", revision=1, current_revision=1, failure_key="f", scope=["a"], validation_terminal=True, max_attempts=2, now=1.0)
        self.assertEqual(ledger.record_attempt(t["id"], outcome="failed", cost=0.1, now=2.0)["status"], "open")
        esc = ledger.record_attempt(t["id"], outcome="failed", cost=0.1, now=3.0)
        self.assertEqual((esc["status"], esc["escalation"]), ("escalated", "abandon"))


class Hotfix(Sandbox):
    def test_emergency_fix_needs_an_explicit_decision_and_leaves_a_blocking_forward_port(self):
        active = self.store.request("p", trigger="manual", reason="r", dev_sha="d" * 40, base_stable_sha=self.stable, config_hash="h", now=1.0)
        cand = self.store.active("p")
        self.assertEqual(active["result"], "admitted")
        self.assertFalse(rr.plan_emergency(active_candidate=cand, decision=None)["allowed"])
        plan = rr.plan_emergency(active_candidate=cand, decision="reconcile")
        self.assertTrue(plan["allowed"])
        self.assertIn("open-forward-port-to-dev", plan["actions"])
        # the hotfix is branched from stable, validated alone and promoted; its forward port to dev stays an open obligation
        self.sh("checkout", "-q", "-b", "hotfix", "stable")
        fix = self.commit()
        self.sh("checkout", "-q", "dev")
        self.assertEqual(self.promote(self.manifest(fix, cid="hotfix-1")), "promo-hotfix-1")
        self.assertEqual(self.sh("rev-parse", "stable"), fix)
        repairs = rr.RepairLedger(os.path.join(self.tmp.name, "r.db"))
        t = repairs.open_repair(candidate_id="hotfix-1", revision=1, current_revision=1, failure_key="prod-outage", scope=["f"], validation_terminal=True, now=2.0)
        fp = repairs.register_fix(t["id"], fix_sha=fix, patch_id="pid-1", now=3.0)["id"]
        self.assertEqual(repairs.blocks_stable("hotfix-1"), [fp])
        self.assertEqual(self.store.active("p")["id"], cand["id"])  # the one-active rule was never broken


if __name__ == "__main__":
    unittest.main()
