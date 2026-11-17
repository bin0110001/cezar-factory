import copy
import json
import os
import pathlib
import tempfile
import unittest

from scripts.release import quality_findings as qf
from scripts.release import quality_stage_gate as sg
from scripts.release import scanner_status as ss
from scripts.release.release_candidate_store import CandidateStore

ROOT = pathlib.Path(__file__).resolve().parents[1]
NOW = 100 * 86400.0
SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"


def doc(**project):
    d = json.loads((ROOT / "policies" / "quality-gates.json").read_text(encoding="utf8"))
    if project:
        d["projects"] = {"p": project}
    return d


def finding(fp="a" * 64, severity="medium", **over):
    f = {"fingerprint": fp, "category": "sca", "severity": severity, "advisoryId": "CVE-2021-0001", "path": "package-lock.json", "fixAvailable": True}
    f.update(over)
    return f


def waiver(**over):
    s = {"fingerprint": "a" * 64, "grantedByKind": "human", "grantedBy": "alice", "grantedAt": NOW - 86400, "expiresAt": NOW + 10 * 86400,
         "reason": "vendor patch pending", "receiptId": "rcpt-1", "scope": {"project": "p", "stages": ["stable"]}}
    s.update(over)
    return s


def stage(stage_name, checks=None, **over):
    args = dict(doc=doc(), project="p", repo_type=None, stage=stage_name, changed_paths=[], checks=checks if checks is not None else {}, findings=[], baseline=[], suppressions=[], now=NOW)
    args.update(over)
    return sg.evaluate_stage(**args)


GOOD_STABLE = {"test": {"status": "pass"}, "secrets": {"status": "pass"}, "sca": {"status": "pass"}}
GOOD_PR = {"format": {"status": "pass"}, "lint": {"status": "pass"}, "type": {"status": "pass"}, "test": {"status": "pass"}, "secrets": {"status": "pass"}}


class ScanStatus(unittest.TestCase):
    def cls(self, **over):
        args = dict(executed=True, feed_available=True, parsed=True, finding_count=0, completed_at=NOW - 3600, max_age_hours=24, now=NOW)
        args.update(over)
        return ss.classify_scan(**args)

    def test_clean_only_when_everything_worked(self):
        self.assertEqual(self.cls(), "clean")
        self.assertEqual(self.cls(finding_count=2), "findings")
        self.assertEqual(self.cls(executed=False), "outage")
        self.assertEqual(self.cls(feed_available=False), "outage")  # an outage never reports clean
        self.assertEqual(self.cls(parsed=False), "unknown")
        self.assertEqual(self.cls(completed_at=None), "unknown")

    def test_stale_is_distinct_from_outage_and_clean(self):
        self.assertEqual(self.cls(completed_at=NOW - 30 * 3600), "stale")
        self.assertEqual(self.cls(completed_at=NOW - 30 * 3600, max_age_hours=None), "clean")

    def test_policy_mapping_fails_closed_for_mandatory_checks(self):
        for state in ("unknown", "outage", "stale"):
            self.assertEqual(ss.outcome(state, fail_mode="fail-closed", level="required"), "block")
            self.assertEqual(ss.outcome(state, fail_mode="fail-open", level="required"), "warn")
            self.assertEqual(ss.outcome(state, fail_mode="fail-closed", level="advisory"), "warn")
        self.assertEqual(ss.outcome("findings", fail_mode="fail-open", level="required"), "block")
        self.assertEqual(ss.outcome("clean", fail_mode="fail-closed", level="required"), "pass")
        with self.assertRaises(ValueError):
            ss.outcome("green", fail_mode="fail-open", level="required")

    def test_backoff_is_exponential_and_bounded(self):
        delays = [ss.backoff_delay(n, base=60, cap=1000) for n in range(0, 8)]
        self.assertEqual(delays, [0.0, 60, 120, 240, 480, 960, 1000, 1000])
        self.assertTrue(all(d <= 1000 for d in [ss.backoff_delay(n, base=60, cap=1000) for n in range(1, 200)]))

    def test_book_tracks_failures_retries_and_downgrades_to_stale(self):
        book = ss.ScanBook()
        r1 = book.record("p", "sca", state="outage", now=NOW, db_snapshot=None, max_age_hours=24)
        self.assertEqual((r1["failures"], r1["nextRetryAt"]), (1, NOW + 300))
        self.assertFalse(book.retry_allowed("p", "sca", now=NOW + 10))
        self.assertTrue(book.retry_allowed("p", "sca", now=NOW + 301))
        r2 = book.record("p", "sca", state="outage", now=NOW + 301, db_snapshot=None, max_age_hours=24)
        self.assertEqual((r2["failures"], r2["nextRetryAt"]), (2, NOW + 301 + 600))
        book.record("p", "sca", state="clean", now=NOW + 1000, db_snapshot="db-1", max_age_hours=24)
        self.assertEqual(book.get("p", "sca")["failures"], 0)
        self.assertEqual(book.effective_state("p", "sca", now=NOW + 2000), "clean")
        self.assertEqual(book.effective_state("p", "sca", now=NOW + 1000 + 25 * 3600), "stale")
        self.assertEqual(book.effective_state("p", "never", now=NOW), "unknown")
        # a failed attempt keeps the last good scan time and snapshot rather than pretending it refreshed
        book.record("p", "sca", state="outage", now=NOW + 5000, db_snapshot=None, max_age_hours=24)
        self.assertEqual((book.get("p", "sca")["lastScanAt"], book.get("p", "sca")["dbSnapshot"]), (NOW + 1000, "db-1"))


class Periodic(unittest.TestCase):
    def test_due_follows_cadence_and_backoff(self):
        cadence = {"sca": "daily", "sast": "weekly", "license": "monthly"}
        book = ss.ScanBook()
        self.assertEqual(ss.due_periodic(cadence, book, project="p", now=NOW), ["license", "sast", "sca"])
        for c in cadence:
            book.record("p", c, state="clean", now=NOW, db_snapshot="d", max_age_hours=None)
        self.assertEqual(ss.due_periodic(cadence, book, project="p", now=NOW + 2 * 86400), ["sca"])
        self.assertEqual(ss.due_periodic(cadence, book, project="p", now=NOW + 8 * 86400), ["sast", "sca"])
        book.record("p", "sca", state="outage", now=NOW + 8 * 86400, db_snapshot=None, max_age_hours=None)
        self.assertNotIn("sca", ss.due_periodic(cadence, book, project="p", now=NOW + 8 * 86400 + 60))  # backing off

    def test_advisory_db_change_invalidates_freshness_for_an_unchanged_sha(self):
        self.assertTrue(ss.evidence_fresh("db-1", "db-1"))
        self.assertFalse(ss.evidence_fresh("db-1", "db-2"))
        self.assertFalse(ss.evidence_fresh(None, "db-2"))

    def test_new_blocking_cve_flips_readiness_and_leaves_the_active_candidate_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = CandidateStore(os.path.join(tmp, "c.db"))
            cid = store.request("p", trigger="schedule", reason="r", dev_sha="d" * 40, base_stable_sha="b" * 40, config_hash="h", now=1.0)["candidateId"]
            before = store.get(cid)
            cand = {"id": cid, "sha": before["dev_sha"], "state": before["state"]}
            res = ss.apply_periodic_result(project="p", category="sca", state="findings", now=NOW, book=ss.ScanBook(), db_snapshot="db-2", max_age_hours=24,
                                           blocking_findings=["fp-new"], previously_blocking=[], candidate=cand, promotable_before=True)
            self.assertTrue(res["readinessFlipped"])
            self.assertEqual(res["newBlocking"], ["fp-new"])
            self.assertFalse(res["startedCandidate"])
            self.assertEqual(store.get(cid), before)  # untouched
            self.assertEqual(store.active("p")["id"], cid)
            self.assertIsNone(store.pending_request("p"))  # no second candidate and no pending request either

    def test_an_outage_never_keeps_readiness(self):
        res = ss.apply_periodic_result(project="p", category="sca", state="outage", now=NOW, book=ss.ScanBook(), db_snapshot=None, max_age_hours=24,
                                       blocking_findings=[], previously_blocking=[], candidate=None, promotable_before=True)
        self.assertTrue(res["readinessFlipped"])


class Findings(unittest.TestCase):
    def ev(self, findings, stage_name="pr-dev", baseline=(), suppressions=(), now=NOW, policy=None):
        eff = policy or doc()["defaults"]
        return qf.evaluate_findings(findings, policy=eff, stage=stage_name, project="p", baseline=list(baseline), suppressions=list(suppressions), now=now)

    def test_old_baselined_medium_does_not_block_dev_but_a_new_one_does_when_configured(self):
        policy = copy.deepcopy(doc()["defaults"])
        policy["tolerances"]["maxNewFindings"]["medium"] = 0
        old = finding("1" * 64, "medium")
        base = [qf.baseline_entry(old, added_at=NOW - 30 * 86400)]
        res = self.ev([old], baseline=base, policy=policy)
        self.assertFalse(res["blocked"])
        self.assertEqual(res["verdicts"][0]["status"], "baselined")
        res = self.ev([old, finding("2" * 64, "medium")], baseline=base, policy=policy)
        self.assertEqual(res["blocking"], ["2" * 64])

    def test_baseline_entries_expire(self):
        policy = copy.deepcopy(doc()["defaults"])
        policy["tolerances"]["maxNewFindings"]["medium"] = 0
        old = finding("1" * 64, "medium")
        res = self.ev([old], baseline=[qf.baseline_entry(old, added_at=NOW - 120 * 86400)], policy=policy)
        self.assertTrue(res["blocked"])
        self.assertTrue(any("baseline entry expired" in r for r in res["verdicts"][0]["reasons"]))

    def test_new_critical_blocks_and_severity_tightens_for_exploitable_fixable_findings(self):
        self.assertTrue(self.ev([finding("3" * 64, "critical")])["blocked"])
        self.assertFalse(self.ev([finding("4" * 64, "low")])["blocked"])
        esc = self.ev([finding("5" * 64, "medium", exploitable="confirmed", fixAvailable=True)])
        self.assertEqual(esc["verdicts"][0]["effectiveSeverity"], "high")
        self.assertTrue(esc["blocked"])
        self.assertFalse(self.ev([finding("6" * 64, "medium", exploitable="confirmed", fixAvailable=False)])["blocked"])

    def test_suppression_validity_scope_and_expiry(self):
        f = finding("a" * 64, "critical")
        self.assertFalse(self.ev([f], "stable", suppressions=[waiver()])["blocked"])
        after = self.ev([f], "stable", suppressions=[waiver()], now=NOW + 11 * 86400)
        self.assertTrue(after["blocked"])  # expired suppression re-blocks
        self.assertTrue(any("expired" in r for r in after["verdicts"][0]["reasons"]))
        self.assertTrue(self.ev([f], "pr-dev", suppressions=[waiver()])["blocked"])  # scoped to stable only
        self.assertTrue(self.ev([f], "stable", suppressions=[waiver(scope={"project": "other"})])["blocked"])

    def test_agents_cannot_self_waive_and_waivers_must_be_bounded_and_receipted(self):
        f = finding("a" * 64, "critical")
        bad = {
            "agent": waiver(grantedByKind="agent", grantedBy="impl-agent"),
            "no receipt": waiver(receiptId=None),
            "no expiry": waiver(expiresAt=None),
            "too long": waiver(expiresAt=NOW + 400 * 86400),
            "blanket": waiver(fingerprint=None, advisoryId=None),
            "no reason": waiver(reason=""),
        }
        for name, sup in bad.items():
            res = self.ev([f], "stable", suppressions=[sup])
            self.assertTrue(res["blocked"], name)
        agent = self.ev([f], "stable", suppressions=[bad["agent"]])
        self.assertTrue(any("agents cannot self-waive" in r for r in agent["verdicts"][0]["reasons"]))

    def test_exception_receipt_is_deterministic(self):
        self.assertEqual(qf.exception_receipt(waiver()), qf.exception_receipt(waiver()))
        self.assertNotEqual(qf.exception_receipt(waiver())["digest"], qf.exception_receipt(waiver(reason="other"))["digest"])

    def test_issues_are_bounded_deduplicated_and_actionable(self):
        blocking = [{"fingerprint": str(i) * 64, "effectiveSeverity": "critical" if i < 2 else "high", "advisoryId": f"CVE-{i}", "fixAvailable": i % 2 == 0} for i in range(6)]
        issues = qf.plan_issues(blocking, existing_keys=set(), max_new=3, project="p")
        self.assertEqual(len(issues), 3)
        self.assertEqual([i["severity"] for i in issues], ["critical", "critical", "high"])
        again = qf.plan_issues(blocking, existing_keys={i["key"] for i in issues}, max_new=3, project="p")
        self.assertTrue(all(i["key"] not in {x["key"] for x in issues} for i in again))
        self.assertIn("fix is available", issues[0]["body"])


class StageGate(unittest.TestCase):
    def test_fast_pr_checks_allow_a_clean_change(self):
        r = stage("pr-dev", GOOD_PR)
        self.assertTrue(r["allowed"], r["blockers"])
        self.assertEqual(r["schemaVersion"], "quality-gate-receipt/v1")

    def test_stable_blocks_without_evidence_for_a_required_security_check(self):
        r = stage("stable", {"test": {"status": "pass"}, "secrets": {"status": "pass"}})  # no sca result at all
        self.assertFalse(r["allowed"])
        self.assertEqual([b["category"] for b in r["blockers"]], ["sca"])
        self.assertEqual(r["blockers"][0]["status"], "unknown")

    def test_scanner_outage_and_staleness_block_stable_but_not_the_fail_open_periodic_refresh(self):
        outage = {"scan": dict(executed=False, feed_available=False, completed_at=None, max_age_hours=24, now=NOW)}
        stale = {"scan": dict(executed=True, feed_available=True, completed_at=NOW - 50 * 3600, max_age_hours=24, now=NOW)}
        for name, sca in (("outage", outage), ("stale", stale)):
            r = stage("stable", {**GOOD_STABLE, "sca": sca})
            self.assertFalse(r["allowed"], name)
        periodic = stage("periodic", {"sca": outage})
        self.assertTrue(periodic["allowed"], periodic["blockers"])  # configured fail-open

    def test_risk_pattern_makes_dependency_scan_required_on_the_pr(self):
        self.assertTrue(stage("pr-dev", GOOD_PR, changed_paths=["src/a.py"])["allowed"])
        r = stage("pr-dev", GOOD_PR, changed_paths=["web/package-lock.json"])  # sca result missing
        self.assertFalse(r["allowed"])
        self.assertTrue(stage("pr-dev", {**GOOD_PR, "sca": {"status": "pass"}}, changed_paths=["web/package-lock.json"])["allowed"])

    def test_scenario_old_medium_baselined_does_not_block_dev(self):
        d = doc(tolerances={"maxNewFindings": {"medium": 0}})
        old = finding("1" * 64, "medium")
        r = stage("pr-dev", GOOD_PR, doc=d, findings=[old], baseline=[qf.baseline_entry(old, added_at=NOW - 10 * 86400)])
        self.assertTrue(r["allowed"], r)

    def test_scenario_new_critical_blocks_stable_and_emits_a_bounded_issue(self):
        r = stage("stable", GOOD_STABLE, findings=[finding("c" * 64, "critical", advisoryId="CVE-2026-9999")])
        self.assertFalse(r["allowed"])
        self.assertTrue(r["findings"]["blocked"])
        self.assertEqual(len(r["issues"]), 1)
        self.assertIn("CVE-2026-9999", r["issues"][0]["title"])
        dup = stage("stable", GOOD_STABLE, findings=[finding("c" * 64, "critical", advisoryId="CVE-2026-9999")], existing_issue_keys={r["issues"][0]["key"]})
        self.assertEqual(dup["issues"], [])

    def test_scenario_expired_suppression_reblocks_stable(self):
        f = finding("a" * 64, "critical")
        ok = stage("stable", GOOD_STABLE, findings=[f], suppressions=[waiver()])
        self.assertTrue(ok["allowed"], ok)
        later = stage("stable", GOOD_STABLE, findings=[f], suppressions=[waiver()], now=NOW + 11 * 86400)
        self.assertFalse(later["allowed"])

    def test_receipts_never_contain_secrets(self):
        planted = "fixture-planted-value-0123456789"
        leaky = finding("d" * 64, "critical", advisoryId=f"CVE-1 {SECRET} {planted}")
        r = stage("stable", GOOD_STABLE, findings=[leaky], secrets=(planted,))
        text = json.dumps(r)
        self.assertNotIn(SECRET, text)
        self.assertNotIn(planted, text)
        self.assertIn(sg.REDACTED, text)

    def test_advisory_findings_do_not_gate_a_stage_without_security_enforcement(self):
        only_format = {"checks": {"sca": {"pr-dev": "off"}, "secrets": {"pr-dev": "off"}}}
        d = doc(**only_format)
        r = stage("pr-dev", {k: v for k, v in GOOD_PR.items() if k != "secrets"}, doc=d, findings=[finding("e" * 64, "critical")])
        self.assertTrue(r["allowed"])


if __name__ == "__main__":
    unittest.main()
