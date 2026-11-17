import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone

from scripts.release import release_pipeline_config as cfg
from scripts.release import release_rollout as ro
from scripts.release import release_shadow as sh
from scripts.release import release_snapshot as rs
from scripts.release import release_triggers as rt
from scripts.release.release_candidate_store import CandidateStore

ROOT = pathlib.Path(__file__).resolve().parents[1]
UTC = timezone.utc
NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


def example():
    return json.loads((ROOT / "config" / "release-pipeline.example.json").read_text(encoding="utf8"))


def dev(**over):
    base = dict(dev_sha="d" * 40, last_accepted_sha="c" * 40, commits_since=6, changed_paths=["src/a.py"], last_candidate_at=None, oldest_unpromoted_at=None)
    base.update(over)
    return rt.DevState(**base)


def run(project="cezar-factory", **over):
    args = dict(doc=example(), project=project, now=NOW, dev=dev(), last_schedule_fired=None, active_candidate=None)
    args.update(over)
    return sh.shadow_run(**args)


class Shadow(unittest.TestCase):
    def test_cezar_factory_config_yields_a_deterministic_receipt(self):
        a, b = run(), run()
        self.assertEqual(a["receiptDigest"], b["receiptDigest"])
        self.assertEqual((a["mode"], a["project"], a["mutations"]), ("three-branch", "cezar-factory", []))
        self.assertEqual(a["outcome"], "would-create-candidate")
        self.assertTrue(a["effectiveConfigHash"].startswith("sha256:"))
        self.assertEqual([d["trigger"] for d in a["decisions"]], ["schedule", "change"])
        self.assertNotEqual(run(dev=dev(commits_since=1))["receiptDigest"], a["receiptDigest"])

    def test_effective_schedule_preview_for_both_pilot_projects(self):
        daily = run("cezar-factory")["nextScheduledTicks"]
        weekly = run("tableflux")["nextScheduledTicks"]
        self.assertEqual(len(daily), 3)
        self.assertEqual(len(weekly), 3)
        gaps = [(datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).days for a, b in zip(weekly, weekly[1:])]
        self.assertEqual(gaps, [7, 7])
        self.assertEqual(run("legacy-project")["nextScheduledTicks"], [])

    def test_dst_does_not_shift_the_local_schedule_time(self):
        spring = sh.next_ticks({"frequency": "daily", "hour": 4, "minute": 30, "timezone": "America/Detroit"}, datetime(2026, 3, 6, 12, tzinfo=UTC))
        self.assertEqual(spring, ["2026-03-07T09:30:00Z", "2026-03-08T08:30:00Z", "2026-03-09T08:30:00Z"])  # 04:30 local on each side of the jump

    def test_no_change_suppression_and_the_one_active_candidate_rule(self):
        same = run(dev=dev(last_accepted_sha="d" * 40))
        self.assertTrue(same["noChangeSuppressed"])
        self.assertEqual(same["outcome"], "no-request")
        active = run(active_candidate={"id": "cand-1", "state": "validating"})
        self.assertEqual(active["outcome"], "pending-request")
        self.assertEqual(active["activeCandidate"], {"id": "cand-1", "state": "validating"})
        self.assertGreaterEqual(active["pendingRequests"], 1)
        self.assertEqual(run(capacity_available=False)["outcome"], "admission-deferred")

    def test_shadow_writes_nothing_to_the_store_or_to_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = CandidateStore(os.path.join(tmp, "c.db"))
            cid = store.request("cezar-factory", trigger="manual", reason="r", dev_sha="a" * 40, base_stable_sha="b" * 40, config_hash="h", now=1.0)["candidateId"]

            def snapshot():
                db = sqlite3.connect(os.path.join(tmp, "c.db"))
                try:
                    return {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("candidates", "pending", "audit", "revisions", "results")}
                finally:
                    db.close()
            before = snapshot()
            repo = os.path.join(tmp, "repo")
            os.mkdir(repo)
            subprocess.run(["git", "-C", repo, "init", "-q", "-b", "dev"], check=True)
            refs = lambda: subprocess.run(["git", "-C", repo, "for-each-ref"], capture_output=True, text=True).stdout  # noqa: E731
            refs_before = refs()
            active = store.active("cezar-factory")
            receipt = run(active_candidate={"id": active["id"], "state": active["state"]}, pending_count=3)
            self.assertEqual(receipt["outcome"], "pending-request")
            self.assertEqual(receipt["pendingRequests"], 3 + receipt["counts"]["requests"])
            self.assertEqual(snapshot(), before)
            self.assertEqual(store.get(cid)["version"], 0)
            self.assertEqual(refs(), refs_before)

    def test_invalid_config_is_an_error_not_a_guess(self):
        with self.assertRaises(cfg.ConfigError):
            sh.shadow_run(doc={"schemaVersion": "release-pipeline/v1", "projects": {"p": {"promotion": {"bogus": 1}}}}, project="p", now=NOW, dev=dev(), last_schedule_fired=None, active_candidate=None)


class Rollout(unittest.TestCase):
    def test_legacy_is_the_default_and_the_flag_must_be_explicit(self):
        self.assertEqual(ro.engine_for("p", None), "legacy")
        self.assertEqual(ro.engine_for("p", {"projects": {"p": "turbo"}}), "legacy")  # unknown value falls back to legacy
        flags = ro.set_engine(None, "p", "shadow", actor="op", reason="observe first", now=1.0)
        self.assertEqual(ro.route("p", flags), {"engine": "shadow", "usesLegacyPromoter": True, "newEngineActs": False, "newEngineObserves": True})
        self.assertEqual(ro.route("other", flags)["engine"], "legacy")
        new = ro.set_engine(flags, "p", "new", actor="op", reason="pilot approved", now=2.0)
        self.assertTrue(ro.route("p", new)["newEngineActs"])
        with self.assertRaises(ValueError):
            ro.set_engine(flags, "p", "new", actor="op", reason="", now=3.0)
        self.assertEqual([(a["from"], a["to"]) for a in new["audit"]], [("legacy", "shadow"), ("shadow", "new")])

    def test_flag_off_routes_to_the_legacy_promoter_only(self):
        r = ro.route("p", {"default": "legacy"})
        self.assertEqual((r["usesLegacyPromoter"], r["newEngineActs"], r["newEngineObserves"]), (True, False, False))

    def test_backfill_converts_what_it_can_and_never_guesses(self):
        out = ro.backfill_history([
            {"promotionId": "p1", "sha": "a" * 40, "outcome": "promoted", "finishedAt": "2026-11-10T00:00:00Z"},
            {"promotionId": "p2", "sha": "b" * 40, "outcome": "rolled-back"},
            {"promotionId": "p3", "outcome": "promoted"},
            {"promotionId": "p4", "sha": "c" * 40, "outcome": "mystery"},
        ])
        self.assertEqual([o.get("state") for o in out], ["promoted", "failed", None, None])
        self.assertEqual([o.get("skipped", False) for o in out], [False, False, True, True])
        self.assertEqual(out[0]["candidateId"], "legacy-" + "a" * 12)

    def test_rollback_drill_leaves_successful_stable_releases_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            git = rs.Git(tmp)
            sh_ = lambda *a: subprocess.run(["git", "-C", tmp, *a], capture_output=True, text=True, check=True).stdout.strip()  # noqa: E731
            sh_("init", "-q", "-b", "dev")
            for k, v in (("user.email", "t@example.org"), ("user.name", "t"), ("commit.gpgsign", "false")):
                sh_("config", k, v)
            for i in range(3):
                write(os.path.join(tmp, "f"), str(i))
                sh_("add", "-A")
                sh_("commit", "-q", "-m", f"c{i}")
            sh_("branch", "stable", "HEAD")
            before = sh_("rev-parse", "stable")
            flags = ro.set_engine(None, "p", "new", actor="op", reason="pilot", now=1.0)
            drill = ro.rollback_drill(flags, "p", git, stable_branch="stable", actor="op", now=2.0)
            self.assertTrue(drill["ok"], drill)
            self.assertEqual(drill["route"]["engine"], "legacy")
            self.assertEqual(sh_("rev-parse", "stable"), before)
            # if something had rewritten stable, the check says so
            sh_("checkout", "-q", "--orphan", "rewrite")
            write(os.path.join(tmp, "g"), "x")
            sh_("add", "-A")
            sh_("commit", "-q", "-m", "rewrite")
            sh_("update-ref", "refs/heads/stable", sh_("rev-parse", "HEAD"))
            self.assertFalse(ro.stable_history_intact(git, stable_branch="stable", before_sha=before)["intact"])
            with self.assertRaises(ValueError):
                ro.rollback_drill(flags, "p", rs.Git(tmp), stable_branch="missing", actor="op", now=3.0)

    def test_metrics_report_before_and_after_figures(self):
        day = 86400.0
        cut = 100 * day
        records = [
            {"promotedAt": cut - 10 * day, "computeSeconds": 7200, "conflicts": 2, "repairStartedAt": cut - 11 * day, "repairFinishedAt": cut - 10 * day},
            {"promotedAt": cut - 3 * day, "computeSeconds": 3600, "conflicts": 1},
            {"promotedAt": cut + 1 * day, "computeSeconds": 1800, "conflicts": 0, "repairStartedAt": cut + 0.5 * day, "repairFinishedAt": cut + 0.75 * day},
            {"promotedAt": cut + 2 * day, "computeSeconds": 1800},
            {"promotedAt": cut + 3 * day, "computeSeconds": 1800},
        ]
        r = ro.compare_periods(records, cutover=cut, before_days=14, after_days=7)
        self.assertEqual((r["before"]["releases"], r["after"]["releases"]), (2, 3))
        self.assertEqual(r["before"]["releasesPerWeek"], 1.0)
        self.assertEqual(r["after"]["releasesPerWeek"], 3.0)
        self.assertEqual((r["before"]["computeHours"], r["after"]["computeHours"]), (3.0, 1.5))
        self.assertEqual((r["before"]["mergeConflicts"], r["after"]["mergeConflicts"]), (3, 0))
        self.assertEqual((r["before"]["meanRepairHours"], r["after"]["meanRepairHours"]), (24.0, 6.0))
        self.assertEqual(r["delta"]["releasesPerWeek"], 2.0)
        empty = ro.release_metrics([], since=0, until=7 * day)
        self.assertEqual((empty["releases"], empty["meanRepairHours"]), (0, None))  # nothing is invented


def pilot():
    return json.loads((ROOT / "config" / "release-pipeline.pilot.example.json").read_text(encoding="utf8"))


class Pilots(unittest.TestCase):
    """#644: cezar-factory (daily) and TableFlux (weekly) are config-only differences on one engine."""

    def test_pilots_differ_only_in_config_and_need_no_hardware(self):
        self.assertEqual(cfg.validate_document(pilot()), [])
        a, b = cfg.effective_config(pilot(), "cezar-factory"), cfg.effective_config(pilot(), "tableflux")
        self.assertEqual((a["triggers"]["schedule"]["frequency"], b["triggers"]["schedule"]["frequency"]), ("daily", "weekly"))
        self.assertEqual(b["triggers"]["schedule"]["dayOfWeek"], "thursday")
        self.assertNotEqual(cfg.config_hash(a), cfg.config_hash(b))
        text = json.dumps(pilot()).lower()
        for word in ("gpu", "hardware", "host", "bazzite"):
            self.assertNotIn(word, text)
        src = (ROOT / "scripts" / "release" / "release_shadow.py").read_text(encoding="utf8").lower()
        self.assertNotIn("tableflux", src)
        self.assertNotIn("cezar-factory", src)

    def test_shadow_receipts_for_both_pilots_use_the_same_engine(self):
        for project in ("cezar-factory", "tableflux"):
            r = run(project, doc=pilot())
            self.assertEqual(r["mutations"], [])
            self.assertEqual(r["receiptDigest"], run(project, doc=pilot())["receiptDigest"])
            self.assertEqual(len(r["nextScheduledTicks"]), 3)

    def test_pilot_rollout_audit_and_rollback(self):
        flags = None
        for project in ("cezar-factory", "tableflux"):
            flags = ro.set_engine(flags, project, "shadow", actor="op", reason="pilot shadow", now=1.0)
            flags = ro.set_engine(flags, project, "new", actor="op", reason="pilot flag-on", now=2.0)
            self.assertTrue(ro.route(project, flags)["newEngineActs"])
        self.assertEqual(len(flags["audit"]), 4)
        with tempfile.TemporaryDirectory() as tmp:
            sh_ = lambda *a: subprocess.run(["git", "-C", tmp, *a], capture_output=True, text=True, check=True).stdout.strip()  # noqa: E731
            sh_("init", "-q", "-b", "dev")
            for k, v in (("user.email", "t@example.org"), ("user.name", "t"), ("commit.gpgsign", "false")):
                sh_("config", k, v)
            write(os.path.join(tmp, "f"), "x")
            sh_("add", "-A")
            sh_("commit", "-q", "-m", "c")
            sh_("branch", "stable", "HEAD")
            for project in ("cezar-factory", "tableflux"):
                drill = ro.rollback_drill(flags, project, rs.Git(tmp), stable_branch="stable", actor="op", now=3.0)
                self.assertTrue(drill["ok"])
                self.assertEqual(drill["route"]["engine"], "legacy")


if __name__ == "__main__":
    unittest.main()
