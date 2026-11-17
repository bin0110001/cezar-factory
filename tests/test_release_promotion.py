import os
import subprocess
import tempfile
import unittest

from scripts.release import release_promotion as rp
from scripts.release import release_snapshot as rs
from scripts.release import release_verification as rv

NOW = 1000.0
OK = {"allowed": True, "reasons": [], "warnings": []}
SUITE = [{"id": "unit", "required": True, "adapterVersion": "1"}]


class Base(unittest.TestCase):
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
        self.tested = self.commit()
        self.ledger = rp.PromotionLedger(os.path.join(self.tmp.name, "promo.db"))
        self.manifest = rv.build_manifest(candidate_id="c1", revision=1, sha=self.tested, config_hash="cfg", asset_hash="as", env_hash="env", suites=SUITE)
        self.gate = rv.gate(self.manifest, [rv.evidence_record(self.manifest, "unit", status="passed", at=NOW)], now=NOW + 1)

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, *a):
        return subprocess.run(["git", "-C", self.dir, *a], capture_output=True, text=True, check=True).stdout.strip()

    def commit(self):
        self.n += 1
        with open(os.path.join(self.dir, "f"), "w") as f:
            f.write(str(self.n))
        self.sh("add", "-A")
        self.sh("commit", "-q", "-m", f"c{self.n}")
        return self.sh("rev-parse", "HEAD")

    def approval(self, **over):
        a = {"approver": "alice", "author": "bob", "actorKind": "human", "sha": self.tested, "manifestHash": self.manifest["manifestHash"], "expiresAt": NOW + 3600}
        a.update(over)
        return a

    def decide(self, **over):
        args = dict(manifest=self.manifest, gate=self.gate, mode="approval", approval=self.approval(), forward_port_blockers=[], now=NOW + 5)
        args.update(over)
        return rp.authorize(**args)

    def begin(self, decision=None):
        return self.ledger.begin(project_id="p", manifest=self.manifest, prior_stable_sha=self.stable, decision=decision or self.decide(), actor="promoter", now=NOW + 6)


class Authorization(Base):
    def test_valid_approval_allows(self):
        d = self.decide()
        self.assertEqual((d["allowed"], d["reasons"]), (True, []))

    def test_each_missing_condition_denies(self):
        pending = dict(self.gate, eligible=False, blocking=["unit"])
        cases = {
            "no evidence or pending check": dict(gate=pending),
            "no approval": dict(approval=None),
            "expired approval": dict(approval=self.approval(expiresAt=NOW)),
            "agent approving": dict(approval=self.approval(actorKind="agent")),
            "self approval": dict(approval=self.approval(approver="bob", author="bob")),
            "approval for another sha": dict(approval=self.approval(sha="f" * 40)),
            "approval for another manifest": dict(approval=self.approval(manifestHash="sha256:other")),
            "unresolved forward port": dict(forward_port_blockers=["fp-1"]),
            "quarantined": dict(quarantined=frozenset({self.tested})),
            "freshness block": dict(newer_dev_commits=3, freshness="block"),
            "unknown mode": dict(mode="yolo"),
        }
        for name, over in cases.items():
            d = self.decide(**over)
            self.assertFalse(d["allowed"], name)
            self.assertTrue(d["reasons"], name)

    def test_newer_dev_still_lets_an_older_tested_candidate_promote(self):
        self.assertTrue(self.decide(newer_dev_commits=20, freshness="allow")["allowed"])
        warn = self.decide(newer_dev_commits=20, freshness="warn")
        self.assertTrue(warn["allowed"] and warn["warnings"])

    def test_auto_mode_needs_no_approval_but_still_needs_evidence(self):
        self.assertTrue(self.decide(mode="auto", approval=None)["allowed"])
        bad = dict(self.gate, eligible=False, blocking=["unit"])
        self.assertFalse(self.decide(mode="auto", approval=None, gate=bad)["allowed"])


class TwoPhase(Base):
    def promote_ref(self):
        p = self.begin()
        self.ledger.move_stable(p["id"], self.git, stable_branch="stable", now=NOW + 7)
        return p["id"]

    def test_full_success_needs_probes_not_just_the_ref(self):
        pid = self.promote_ref()
        self.assertEqual(self.sh("rev-parse", "stable"), self.tested)
        self.assertEqual(self.ledger.get(pid)["state"], "ref-moved")  # a moved ref is not a deployment
        self.ledger.begin_activation(pid, now=NOW + 8)
        with self.assertRaises(rp.PromotionError):
            self.ledger.complete_activation(pid, required_probes=["ready", "health"], now=NOW + 9)
        self.ledger.record_probe(pid, name="ready", ok=True, detail={}, now=NOW + 9)
        self.ledger.record_probe(pid, name="health", ok=False, detail={"code": 500}, now=NOW + 9)
        with self.assertRaises(rp.PromotionError):
            self.ledger.complete_activation(pid, required_probes=["ready", "health"], now=NOW + 10)
        self.ledger.record_probe(pid, name="health", ok=True, detail={}, now=NOW + 11)
        self.ledger.complete_activation(pid, required_probes=["ready", "health"], now=NOW + 12)
        self.assertEqual(self.ledger.get(pid)["state"], "active")

    def test_activation_cannot_be_confirmed_with_no_required_probes(self):
        pid = self.promote_ref()
        self.ledger.begin_activation(pid, now=NOW + 8)
        with self.assertRaises(rp.PromotionError):
            self.ledger.complete_activation(pid, required_probes=[], now=NOW + 9)

    def test_activation_failure_restores_prior_stable_and_keeps_the_audit(self):
        pid = self.promote_ref()
        self.ledger.begin_activation(pid, now=NOW + 8)
        out = self.ledger.fail_activation(pid, self.git, stable_branch="stable", reason="health check failed", now=NOW + 9)
        self.assertTrue(out["restored"])
        self.assertEqual(self.sh("rev-parse", "stable"), self.stable)
        self.assertEqual(self.ledger.get(pid)["state"], "rolled-back")
        self.assertTrue(self.ledger.is_quarantined(self.tested))
        events = [e["event"] for e in self.ledger.audit_log(pid)]
        self.assertEqual(events, ["authorized", "ref-moved", "activation-started", "rollback"])
        self.assertFalse(self.decide(quarantined=self.ledger.quarantined())["allowed"])

    def test_rollback_does_not_clobber_a_ref_someone_else_moved(self):
        pid = self.promote_ref()
        self.ledger.begin_activation(pid, now=NOW + 8)
        other = self.commit()
        self.sh("update-ref", "refs/heads/stable", other)
        out = self.ledger.fail_activation(pid, self.git, stable_branch="stable", reason="x", now=NOW + 9)
        self.assertFalse(out["restored"])
        self.assertEqual(self.sh("rev-parse", "stable"), other)
        self.assertEqual(self.ledger.get(pid)["state"], "failed")

    def test_unexpected_stable_writer_is_refused_and_not_overwritten(self):
        p = self.begin()
        intruder = self.commit()
        self.sh("update-ref", "refs/heads/stable", intruder)
        with self.assertRaises(rp.PromotionError):
            self.ledger.move_stable(p["id"], self.git, stable_branch="stable", now=NOW + 7)
        self.assertEqual(self.sh("rev-parse", "stable"), intruder)
        self.assertEqual(self.ledger.get(p["id"])["state"], "refused")

    def test_tested_sha_must_descend_from_stable(self):
        self.sh("checkout", "-q", "-b", "side", self.stable)
        diverged = self.commit()
        self.sh("checkout", "-q", "dev")
        manifest = rv.build_manifest(candidate_id="c2", revision=1, sha=diverged, config_hash="c", asset_hash="a", env_hash="e", suites=SUITE)
        self.sh("update-ref", "refs/heads/stable", self.tested)  # stable moved on; the diverged commit is not a descendant
        p = self.ledger.begin(project_id="p2", manifest=manifest, prior_stable_sha=self.tested, decision=OK, actor="promoter", now=NOW)
        with self.assertRaises(rp.PromotionError):
            self.ledger.move_stable(p["id"], self.git, stable_branch="stable", now=NOW + 1)
        self.assertEqual(self.sh("rev-parse", "stable"), self.tested)

    def test_never_two_promotions_at_once_and_replays_are_idempotent(self):
        first = self.begin()
        again = self.begin()
        self.assertTrue(again["replayed"])
        self.assertEqual(first["id"], again["id"])
        other = rv.build_manifest(candidate_id="c2", revision=1, sha=self.tested, config_hash="c", asset_hash="a", env_hash="e", suites=SUITE)
        with self.assertRaises(rp.PromotionError):
            self.ledger.begin(project_id="p", manifest=other, prior_stable_sha=self.stable, decision=OK, actor="promoter", now=NOW)

    def test_refused_authorization_creates_no_promotion(self):
        with self.assertRaises(rp.PromotionError):
            self.begin(self.decide(approval=None))
        with self.assertRaises(rp.PromotionError):
            self.ledger.get("promo-c1")

    def test_crash_after_the_cas_resumes_without_a_second_move(self):
        p = self.begin()
        self.assertTrue(self.git.cas("refs/heads/stable", self.tested, self.stable))  # ref moved, ledger not yet updated
        self.ledger._set(p["id"], ("authorized",), "ref-moved", "promoter", "ref-moved", {}, NOW + 7)
        self.ledger.move_stable(p["id"], self.git, stable_branch="stable", now=NOW + 8)  # replay is a no-op
        self.assertEqual(self.ledger.get(p["id"])["state"], "ref-moved")

    def test_interrupted_activation_is_listed_for_recovery(self):
        pid = self.promote_ref()
        self.ledger.begin_activation(pid, now=NOW + 8)
        self.assertEqual(self.ledger.stale_activations(now=NOW + 20, timeout=60), [])
        self.assertEqual([r["id"] for r in self.ledger.stale_activations(now=NOW + 500, timeout=60)], [pid])


class Drift(unittest.TestCase):
    def test_ref_movement_alone_is_drift_until_serving_agrees(self):
        self.assertEqual(rp.detect_drift(stable_ref_sha="b", serving_sha="a", last_active_sha="a")["kind"], "ref-ahead-of-serving")
        self.assertEqual(rp.detect_drift(stable_ref_sha="b", serving_sha="x", last_active_sha="a")["kind"], "serving-diverged")
        self.assertEqual(rp.detect_drift(stable_ref_sha="a", serving_sha=None, last_active_sha="a")["kind"], "serving-unknown")
        self.assertFalse(rp.detect_drift(stable_ref_sha="a", serving_sha="a", last_active_sha="a")["drift"])


if __name__ == "__main__":
    unittest.main()
