import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

from scripts.release.factory_local_scheduler import LocalPromotionScheduler, SchedulerError
from scripts.release.factory_promotion import GhRunner


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


class FakeGh:
    """Stands in for `gh` (normally reached through podman exec on the host)."""

    def __init__(self, sha, pr_body="## Self-review\nscope, risk, validation ok", review=""):
        self.sha, self.pr_body, self.review = sha, pr_body, review
        self.calls = []
        self.patched = []
        self.issues = []

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        joined = " ".join(argv)
        if "/commits/" in joined and joined.endswith(".[].number"):
            return self._ok("12\n")
        if "pr view 12" in joined:
            return self._ok(json.dumps({"state": "MERGED", "baseRefName": "dev", "reviewDecision": self.review,
                                        "mergeCommit": {"oid": self.sha}, "body": self.pr_body}))
        if "PATCH" in joined:
            self.patched.append(joined)
            return self._ok("{}")
        if "issue list" in joined:
            return self._ok("[]")
        if "issue create" in joined:
            self.issues.append(joined)
            return self._ok("https://github.com/example/factory/issues/1")
        return self._ok("")

    @staticmethod
    def _ok(text):
        return subprocess.CompletedProcess([], 0, text.encode(), b"")


class FakeCezar:
    def __init__(self, outcome="done", served_sha=""):
        self.outcome, self.served_sha, self.runs = outcome, served_sha, 0

    def __call__(self, method, url, body):
        if url.endswith("/automations"):
            return {"automations": [{"id": "a1", "name": "[factory] health", "kind": "schedule"}]}
        if url.endswith("/run"):
            self.runs += 1
            return {"runId": "r1"}
        if "/runs/" in url:
            failed = [{"id": "repair", "status": "failed", "error": "boom"}] if self.outcome == "failed" else []
            return {"status": self.outcome, "steps": failed}
        if url.endswith("/factory-release"):
            return {"channel": "dev", "sourceSha": self.served_sha}
        raise AssertionError(f"unexpected {method} {url}")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="factory-pipeline-test-")
        root = pathlib.Path(self.tmp.name)
        self.repo, self.origin, self.store = root / "repo", root / "origin.git", root / "store"
        self.config, self.registry = root / "scheduler.json", root / "projects.json"
        self.repo.mkdir()
        subprocess.run(["git", "init", "--bare", str(self.origin)], check=True, capture_output=True)
        subprocess.run(["git", "init", "-b", "main", str(self.repo)], check=True, capture_output=True)
        git(self.repo, "config", "user.name", "Factory Test")
        git(self.repo, "config", "user.email", "factory-test@example.invalid")
        (self.repo / "tracked.txt").write_text("baseline\n", encoding="utf-8")
        git(self.repo, "add", "tracked.txt")
        git(self.repo, "commit", "-m", "baseline")
        self.base_sha = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "remote", "add", "origin", str(self.origin))
        self.sha = self.push_commit("candidate")
        self.registry.write_text(json.dumps([{"projectId": "proj", "apiUrl": "http://cezar.invalid"}]), encoding="utf-8")
        self.activations, self.rollbacks, self.quarantined = [], [], []

    def tearDown(self):
        for item in sorted(pathlib.Path(self.tmp.name).rglob("*"), key=lambda p: len(p.parts), reverse=True):
            try:
                os.chmod(item, 0o700 if item.is_dir() else 0o600)
            except OSError:
                pass
        self.tmp.cleanup()

    def push_commit(self, text):
        (self.repo / "tracked.txt").write_text(text + "\n", encoding="utf-8")
        git(self.repo, "add", "tracked.txt")
        git(self.repo, "commit", "-m", text)
        subprocess.run(["git", "-C", str(self.repo), "push", "-f", "origin", "HEAD:refs/heads/dev"], check=True, capture_output=True)
        return git(self.repo, "rev-parse", "HEAD")

    def build(self, *, promotion=None, gh=None, cezar=None, deploy="writes-pointer", set_dev_pointer=True):
        policy = {"mode": "autonomous", "canaries": {"projectId": "proj", "items": [{"id": "health", "automation": "health", "timeoutSeconds": 60}]},
                  "stable": {"branch": "stable", "deployCommand": self.deploy_command(deploy)},
                  "issues": {"labels": ["factory:new"]}}
        policy.update(promotion or {})
        self.config.write_text(json.dumps({
            "schemaVersion": "factory-local-promotion/v1", "githubRepository": "example/factory", "maxParallel": 1, "gpuSlots": 0,
            "checks": [{"id": "suite", "when": ["**"], "command": [sys.executable, "-c", "pass"], "required": True, "timeoutSeconds": 60}],
            "promotion": policy}), encoding="utf-8")
        self.gh = gh or FakeGh(self.sha)
        self.cezar = cezar or FakeCezar()
        scheduler = LocalPromotionScheduler(self.repo, self.store, self.config, branch="dev", registry=self.registry,
                                            gh_runner=GhRunner(["gh"], runner=self.gh), canary_request=self.cezar, sleep=lambda _s: None)
        if set_dev_pointer:
            pointer = scheduler.controller.channels / "dev.json"
            pointer.parent.mkdir(parents=True, exist_ok=True)
            pointer.write_text(json.dumps({"schemaVersion": "factory-release-channel-pointer/v1", "channel": "dev", "currentSha": self.base_sha}), encoding="utf-8")
        scheduler.coordinator.activate = lambda sha: (self.activations.append(sha), {"status": "healthy", "activationId": "x", "targetCount": 1})[1]
        scheduler.coordinator.rollback = lambda sha: self.rollbacks.append(sha) or {"status": "rolled_back"}
        scheduler.coordinator._quarantine = lambda sha, code, why: self.quarantined.append((sha, code))
        return scheduler

    def deploy_command(self, kind):
        pointer = str(self.store / "release-store" / "channels" / "stable.json")
        code = {
            "writes-pointer": f"import json,pathlib;p=pathlib.Path(r'{pointer}');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps({{'currentSha':'{self.sha}'}}))",
            "no-pointer": "pass",
            "fails": "raise SystemExit(3)",
        }[kind]
        return [sys.executable, "-c", code]

    # -- autonomous happy path -----------------------------------------------------------------------
    def test_autonomous_pipeline_validates_activates_canaries_promotes_and_deploys(self):
        scheduler = self.build()
        result = scheduler.run_once()
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["promotion"]["status"], "promoted")
        self.assertEqual(self.activations, [self.sha])
        self.assertEqual(self.cezar.runs, 1)
        self.assertEqual(len(self.gh.patched), 1)
        self.assertIn("force=false", self.gh.patched[0])
        self.assertIn(f"sha={self.sha}", self.gh.patched[0])
        record = json.loads(pathlib.Path(result["recordPath"]).read_text(encoding="utf-8"))
        self.assertEqual(record["canaries"][0]["status"], "passed")
        self.assertEqual(scheduler.status(self.sha)["stage"], "stable-deployed")
        again = scheduler.run_once()
        self.assertEqual(again["status"], "unchanged")
        self.assertEqual(len(self.gh.patched), 1)

    def test_a_candidate_dev_already_serves_is_adopted_then_canaried_and_promoted(self):
        scheduler = self.build(set_dev_pointer=False)
        pointer = scheduler.controller.channels / "dev.json"
        pointer.parent.mkdir(parents=True, exist_ok=True)
        pointer.write_text(json.dumps({"schemaVersion": "factory-release-channel-pointer/v1", "channel": "dev", "currentSha": self.sha}), encoding="utf-8")
        result = scheduler.run_once()
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["activation"]["status"], "adopted")
        self.assertEqual(self.activations, [])  # nothing to stage or activate
        self.assertEqual(self.cezar.runs, 1)  # every canary still runs against what dev serves
        self.assertEqual(result["promotion"]["status"], "promoted")
        self.assertEqual(len(self.gh.patched), 1)

    # -- canary failure rolls back, quarantines, opens one issue, never reaches stable ---------------
    def test_failed_canary_rolls_dev_back_files_an_issue_and_never_reaches_stable(self):
        scheduler = self.build(cezar=FakeCezar("failed"))
        with self.assertRaisesRegex(SchedulerError, "canary health failed"):
            scheduler.run_once()
        self.assertEqual(self.rollbacks, [self.base_sha])
        self.assertEqual(self.quarantined, [(self.sha, "canary-failed")])
        self.assertEqual(self.gh.patched, [])
        self.assertEqual(len(self.gh.issues), 1)
        self.assertIn("[promotion] canary failed", self.gh.issues[0])
        row = scheduler.status(self.sha)
        self.assertEqual(row["status"], "failed")
        record = json.loads(pathlib.Path(row["recordPath"]).read_text(encoding="utf-8"))
        self.assertEqual(record["candidateState"], "rolled-back")
        self.assertIn("rolled dev back", record["rollback"])
        self.assertEqual(scheduler.run_once()["status"], "unchanged")  # cached; a fix is a new SHA

    def test_failed_validation_never_touches_dev_or_stable(self):
        scheduler = self.build()
        scheduler.config["checks"][0]["command"] = [sys.executable, "-c", "raise SystemExit(7)"]
        with self.assertRaisesRegex(SchedulerError, "required check suite failed"):
            scheduler.run_once()
        self.assertEqual((self.activations, self.rollbacks, self.gh.patched), ([], [], []))
        self.assertEqual(len(self.gh.issues), 1)

    # -- circuit breaker ----------------------------------------------------------------------------
    def test_breaker_pauses_new_candidates_after_repeated_failures(self):
        scheduler = self.build(promotion={"breaker": {"maxConsecutiveFailures": 1, "pauseSeconds": 3600}}, cezar=FakeCezar("failed"))
        with self.assertRaises(SchedulerError):
            scheduler.run_once()
        self.assertTrue(scheduler.status(self.sha)["breakerOpen"])
        self.assertTrue(any("circuit breaker open" in issue for issue in self.gh.issues))
        self.push_commit("next change")
        paused = scheduler.run_once()
        self.assertEqual(paused["status"], "paused")
        scheduler.breaker.reset()
        self.assertFalse(scheduler.status()["breakerOpen"])

    # -- controlled mode ----------------------------------------------------------------------------
    def test_controlled_mode_waits_for_approval_then_promotes(self):
        gh = FakeGh(self.sha, pr_body="no self review here", review="APPROVED")
        scheduler = self.build(promotion={"mode": "controlled", "modes": {"controlled": {"soakSeconds": 0}}}, gh=gh)
        first = scheduler.run_once()
        self.assertEqual(first["promotion"]["status"], "awaiting-approval")
        self.assertEqual(gh.patched, [])
        scheduler.approve(self.sha)
        second = scheduler.run_once()
        self.assertEqual(second["status"], "promoted")
        self.assertEqual(len(gh.patched), 1)

    def test_controlled_mode_honours_the_soak_period(self):
        gh = FakeGh(self.sha, review="APPROVED")
        scheduler = self.build(promotion={"mode": "controlled", "modes": {"controlled": {"soakSeconds": 600}}}, gh=gh)
        scheduler.approve(self.sha)
        result = scheduler.run_once()
        self.assertEqual(result["promotion"]["status"], "soaking")
        self.assertEqual(gh.patched, [])

    def test_controlled_mode_rejects_a_self_review_without_approval(self):
        scheduler = self.build(promotion={"mode": "controlled"})
        with self.assertRaisesRegex(SchedulerError, "approval gate"):
            scheduler.run_once()
        self.assertEqual(self.activations, [])

    # -- evidence gate ------------------------------------------------------------------------------
    def test_missing_self_review_blocks_once_and_is_not_re_recorded_every_tick(self):
        scheduler = self.build(gh=FakeGh(self.sha, pr_body="no evidence"))
        with self.assertRaisesRegex(SchedulerError, "self-review gate"):
            scheduler.run_once()
        self.assertEqual(scheduler.status(self.sha)["status"], "blocked")
        self.assertEqual(scheduler.run_once()["status"], "blocked")
        self.assertEqual(len(list((self.store / "promotion-records").iterdir())), 1)
        self.assertEqual(self.activations, [])
        self.gh.pr_body = "## Self-review\nadded after the fact"
        self.assertEqual(scheduler.run_once()["status"], "healthy")  # evidence arrived; same SHA proceeds

    # -- stable deploy ------------------------------------------------------------------------------
    def test_deploy_that_does_not_reach_the_stable_pointer_stays_pending_and_escalates_once(self):
        scheduler = self.build(deploy="no-pointer")
        first = scheduler.run_once()
        self.assertEqual(first["promotion"]["status"], "deploy-pending")
        for _ in range(3):
            last = scheduler.run_once()
        self.assertEqual(last["status"], "deploy-pending")
        self.assertEqual(last["attempts"], 4)
        self.assertEqual(len([i for i in self.gh.issues if "stable-deploy" in i]), 1)
        self.assertEqual(len(self.gh.patched), 1)  # the ref moved once; only the deploy is retried

    @unittest.skipUnless(os.name == "posix", "umask is POSIX-only")
    def test_stable_deploy_runs_with_a_world_readable_umask_even_under_a_restrictive_promoter(self):
        marker = pathlib.Path(self.tmp.name) / "deploy-umask"
        pointer = str(self.store / "release-store" / "channels" / "stable.json")
        code = (f"import json,os,pathlib;m=os.umask(0);os.umask(m);pathlib.Path(r'{marker}').write_text(oct(m));"
                f"p=pathlib.Path(r'{pointer}');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps({{'currentSha':'{self.sha}'}}))")
        scheduler = self.build()
        scheduler.policy["deployCommand"] = [sys.executable, "-c", code]
        previous = os.umask(0o077)  # what the promoter's systemd unit sets
        try:
            result = scheduler.run_once()
        finally:
            os.umask(previous)
        self.assertEqual(result["promotion"]["status"], "promoted")
        self.assertEqual(marker.read_text(), "0o22")

    def test_failing_deploy_command_is_retried_not_forgotten(self):
        scheduler = self.build(deploy="fails")
        self.assertEqual(scheduler.run_once()["promotion"]["status"], "deploy-pending")
        self.assertEqual(scheduler.run_once()["status"], "deploy-pending")

    def test_stable_already_containing_the_sha_is_not_pushed_again(self):
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", f"{self.sha}:refs/heads/stable"], check=True, capture_output=True)
        scheduler = self.build()
        self.assertEqual(scheduler.run_once()["promotion"]["status"], "promoted")
        self.assertEqual(self.gh.patched, [])

    # -- drift ------------------------------------------------------------------------------------
    def test_drift_reports_a_stable_pointer_that_lags_origin(self):
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", f"{self.sha}:refs/heads/stable"], check=True, capture_output=True)
        scheduler = self.build(cezar=FakeCezar(served_sha=self.base_sha))
        channels = scheduler.controller.channels
        (channels / "stable.json").write_text(json.dumps({"currentSha": self.base_sha}), encoding="utf-8")
        report = scheduler.drift()
        self.assertEqual(report["status"], "drift")
        self.assertTrue(any("lags origin/stable" in f for f in report["findings"]))

    def test_no_drift_when_everything_agrees(self):
        subprocess.run(["git", "-C", str(self.repo), "push", "origin", f"{self.base_sha}:refs/heads/stable"], check=True, capture_output=True)
        scheduler = self.build(cezar=FakeCezar(served_sha=self.base_sha))
        channels = scheduler.controller.channels
        (channels / "stable.json").write_text(json.dumps({"currentSha": self.base_sha}), encoding="utf-8")
        git(self.repo, "checkout", "-q", self.base_sha)
        report = scheduler.drift()
        self.assertEqual(report["status"], "ok", report)


if __name__ == "__main__":
    unittest.main()
