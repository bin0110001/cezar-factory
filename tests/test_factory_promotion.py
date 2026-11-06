import subprocess
import unittest
import urllib.error

from scripts.release.factory_promotion import (
    Breaker,
    CanaryRunner,
    GhRunner,
    PolicyError,
    file_issue,
    fingerprint,
    normalize_policy,
    promote_stable_ref,
    review_decision,
    select_canaries,
)

SHA = "a" * 40


def pr(**over):
    base = {"state": "MERGED", "baseRefName": "dev", "reviewDecision": "", "mergeCommit": {"oid": SHA}, "body": ""}
    base.update(over)
    return base


class PolicyTests(unittest.TestCase):
    def test_missing_section_keeps_legacy_behaviour(self):
        self.assertIsNone(normalize_policy(None))

    def test_autonomous_and_controlled_differ_only_by_data(self):
        auto = normalize_policy({"mode": "autonomous"})
        ctrl = normalize_policy({"mode": "controlled"})
        self.assertEqual((auto["review"], auto["stable"], auto["soakSeconds"]), ("self-review", "auto", 0))
        self.assertEqual((ctrl["review"], ctrl["stable"], ctrl["soakSeconds"]), ("approval", "approval", 3600))

    def test_mode_overrides_apply_to_the_selected_mode_only(self):
        policy = normalize_policy({"mode": "controlled", "modes": {"controlled": {"soakSeconds": 60}, "autonomous": {"soakSeconds": 5}}})
        self.assertEqual(policy["soakSeconds"], 60)

    def test_rejects_unknown_mode_and_bad_values(self):
        for bad in ({"mode": "yolo"}, {"modes": {"autonomous": {"review": "vibes"}}}, {"ghCommand": []},
                    {"breaker": {"maxConsecutiveFailures": 0}}, {"canaries": {"items": [{"id": "x"}]}},
                    {"canaries": {"items": [{"id": "x", "automation": "a"}, {"id": "x", "automation": "b"}]}}):
            with self.assertRaises(PolicyError, msg=str(bad)):
                normalize_policy(bad)

    def test_canary_selection_follows_changed_paths(self):
        policy = normalize_policy({"canaries": {"items": [
            {"id": "health", "automation": "h", "when": ["**"]},
            {"id": "maintenance", "automation": "m", "when": ["scripts/**"]}]}})
        self.assertEqual([c["id"] for c in select_canaries(policy, ["docs/a.md"])], ["health"])
        self.assertEqual([c["id"] for c in select_canaries(policy, ["scripts/x.ps1"])], ["health", "maintenance"])


class ReviewGateTests(unittest.TestCase):
    def test_autonomous_accepts_a_recorded_self_review(self):
        policy = normalize_policy({"mode": "autonomous"})
        ok, why = review_decision(policy, pr(body="## Self-review\nscope ok"), SHA, "dev")
        self.assertTrue(ok, why)

    def test_autonomous_rejects_a_merge_without_evidence(self):
        policy = normalize_policy({"mode": "autonomous"})
        ok, _ = review_decision(policy, pr(body="just a description"), SHA, "dev")
        self.assertFalse(ok)

    def test_controlled_requires_an_independent_approval(self):
        policy = normalize_policy({"mode": "controlled"})
        self.assertFalse(review_decision(policy, pr(body="## Self-review\nfine"), SHA, "dev")[0])
        self.assertTrue(review_decision(policy, pr(reviewDecision="APPROVED"), SHA, "dev")[0])

    def test_wrong_branch_state_or_commit_never_passes(self):
        policy = normalize_policy({"mode": "autonomous"})
        body = "## Self-review"
        self.assertFalse(review_decision(policy, pr(body=body, baseRefName="main"), SHA, "dev")[0])
        self.assertFalse(review_decision(policy, pr(body=body, state="OPEN"), SHA, "dev")[0])
        self.assertFalse(review_decision(policy, pr(body=body, mergeCommit={"oid": "b" * 40}), SHA, "dev")[0])


class FingerprintTests(unittest.TestCase):
    def test_volatile_details_do_not_change_the_fingerprint(self):
        a = fingerprint("canary", "candidate", "canary health failed: run 1234 timed out after 900s at 2026-11-05 abcdef1234567")
        b = fingerprint("canary", "candidate", "canary health failed: run 9876 timed out after 600s at 2027-01-01 fedcba7654321")
        self.assertEqual(a, b)

    def test_different_failures_differ(self):
        self.assertNotEqual(fingerprint("canary", "c", "health failed"), fingerprint("canary", "c", "maintenance failed"))
        self.assertNotEqual(fingerprint("canary", "c", "x"), fingerprint("validation", "c", "x"))


class BreakerTests(unittest.TestCase):
    def setUp(self):
        self.store = {}
        self.now = 1000.0
        self.breaker = Breaker(lambda k, d: self.store.get(k, d), self.store.__setitem__, 3, 600, clock=lambda: self.now)

    def test_opens_after_the_limit_and_pauses_until_the_window_passes(self):
        self.assertFalse(self.breaker.record_failure())
        self.assertFalse(self.breaker.record_failure())
        self.assertTrue(self.breaker.record_failure())
        self.assertTrue(self.breaker.is_open())
        self.now += 601
        self.assertFalse(self.breaker.is_open())

    def test_success_resets_the_count(self):
        self.breaker.record_failure()
        self.breaker.record_failure()
        self.breaker.record_success()
        self.assertFalse(self.breaker.record_failure())
        self.assertEqual(self.breaker.failures(), 1)


class FakeApi:
    def __init__(self, statuses, automations=None):
        self.statuses = list(statuses)
        self.calls = []
        self.automations = automations if automations is not None else [{"id": "a1", "name": "[factory] health", "kind": "schedule"}]
        self.fail_first = 0

    def __call__(self, method, url, body):
        self.calls.append((method, url))
        if self.fail_first:
            self.fail_first -= 1
            raise urllib.error.URLError("connection refused")
        if url.endswith("/automations") and method == "GET":
            return {"automations": self.automations}
        if url.endswith("/run") and method == "POST":
            return {"runId": "r1"}
        if "/runs/" in url:
            status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
            return {"status": status, "steps": [{"id": "repair", "status": "failed", "error": "boom"}] if status == "failed" else []}
        raise AssertionError(f"unexpected call {method} {url}")


class CanaryTests(unittest.TestCase):
    def runner(self, api, **kw):
        self.t = 0.0

        def clock():
            return self.t

        def sleep(seconds):
            self.t += seconds

        return CanaryRunner("http://cezar", "proj", request=api, sleep=sleep, clock=clock, ready_seconds=60, poll_seconds=10, **kw)

    def test_passes_when_the_run_finishes_done(self):
        result = self.runner(FakeApi(["running", "done"])).run({"id": "health", "automation": "health", "timeoutSeconds": 300, "queueTimeoutSeconds": 600})
        self.assertEqual((result["status"], result["runId"]), ("passed", "r1"))

    def test_failed_run_reports_the_failing_step(self):
        result = self.runner(FakeApi(["failed"])).run({"id": "health", "automation": "health", "timeoutSeconds": 300, "queueTimeoutSeconds": 600})
        self.assertEqual(result["status"], "failed")
        self.assertIn("step repair: boom", result["reason"])

    def test_times_out_instead_of_waiting_forever(self):
        result = self.runner(FakeApi(["running"])).run({"id": "health", "automation": "health", "timeoutSeconds": 60, "queueTimeoutSeconds": 600})
        self.assertEqual(result["status"], "failed")
        self.assertIn("timed out", result["reason"])

    def test_time_spent_queued_does_not_count_against_the_run_budget(self):
        # five polls queued (50s) then running, then done, with only a 30s run budget: it passes.
        api = FakeApi(["queued"] * 5 + ["running", "done"])
        result = self.runner(api).run({"id": "h", "automation": "health", "timeoutSeconds": 30, "queueTimeoutSeconds": 600})
        self.assertEqual(result["status"], "passed")

    def test_a_run_that_never_leaves_the_queue_fails_with_a_queue_reason(self):
        result = self.runner(FakeApi(["queued"])).run({"id": "h", "automation": "health", "timeoutSeconds": 30, "queueTimeoutSeconds": 60})
        self.assertEqual(result["status"], "failed")
        self.assertIn("never started", result["reason"])

    def test_a_started_run_that_hangs_still_fails_on_the_run_budget(self):
        api = FakeApi(["queued", "queued", "running"])
        result = self.runner(api).run({"id": "h", "automation": "health", "timeoutSeconds": 30, "queueTimeoutSeconds": 600})
        self.assertEqual(result["status"], "failed")
        self.assertIn("running", result["reason"])

    def test_waits_through_a_cezar_restart_before_giving_up(self):
        api = FakeApi(["done"])
        api.fail_first = 3
        self.assertEqual(self.runner(api).run({"id": "h", "automation": "health", "timeoutSeconds": 300, "queueTimeoutSeconds": 600})["status"], "passed")

    def test_an_unreachable_cezar_fails_the_canary_cleanly(self):
        api = FakeApi(["done"])
        api.fail_first = 10_000
        result = self.runner(api).run({"id": "h", "automation": "health", "timeoutSeconds": 300, "queueTimeoutSeconds": 600})
        self.assertEqual(result["status"], "failed")
        self.assertIn("unavailable", result["reason"])

    def test_unknown_automation_fails(self):
        result = self.runner(FakeApi(["done"], automations=[])).run({"id": "h", "automation": "nope", "timeoutSeconds": 300, "queueTimeoutSeconds": 600})
        self.assertEqual(result["status"], "failed")
        self.assertIn("not found", result["reason"])


class GhFake:
    def __init__(self, listing="[]", create_rc=0):
        self.calls, self.listing, self.create_rc = [], listing, create_rc

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        joined = " ".join(argv)
        rc = self.create_rc if "issue create" in joined or "PATCH" in joined else 0
        out = self.listing if "issue list" in joined else "https://github.com/o/r/issues/9"
        return subprocess.CompletedProcess(argv, rc, out.encode(), b"denied" if rc else b"")


class GhActionTests(unittest.TestCase):
    def test_issue_is_created_once_then_commented_for_the_same_fingerprint(self):
        gh = GhRunner(["gh"], runner=GhFake())
        self.assertIn("issues/9", file_issue(gh, "o/r", "t", "body", ["factory:new"], "abc"))
        gh = GhRunner(["gh"], runner=GhFake(listing='[{"number": 4}]'))
        self.assertEqual(file_issue(gh, "o/r", "t", "body", ["factory:new"], "abc"), "commented #4")

    def test_stable_ref_update_is_fast_forward_only(self):
        fake = GhFake()
        promote_stable_ref(GhRunner(["gh"], runner=fake), "o/r", "stable", SHA)
        self.assertIn("force=false", " ".join(fake.calls[0]))
        self.assertIn("repos/o/r/git/refs/heads/stable", " ".join(fake.calls[0]))

    def test_a_refused_ref_update_raises(self):
        with self.assertRaises(PolicyError):
            promote_stable_ref(GhRunner(["gh"], runner=GhFake(create_rc=1)), "o/r", "stable", SHA)

    def test_gh_runs_through_the_configured_prefix(self):
        fake = GhFake()
        GhRunner(["podman", "exec", "cezar", "gh"], runner=fake)("pr", "list")
        self.assertEqual(fake.calls[0][:5], ["podman", "exec", "cezar", "gh", "pr"])


if __name__ == "__main__":
    unittest.main()
