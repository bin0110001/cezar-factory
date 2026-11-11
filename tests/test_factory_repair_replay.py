"""End-to-end replay of the repair controller in job debug mode.

Drives `main()` against a recorded real failure served by a fake Cezar API and a fake local model, in a git
repo that (like cezar-factory) tracks `.factory/*.json` scratch. The three crashes that hid behind each other in
production (non-fast-forwardable branch, tracked scratch aborting source collection, a protected-file request
aborting the run) all fail this test; no hosted model, GitHub or real checkout is touched.
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("failure_repair_replay", ROOT / "scripts/repair-latest-failure.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
FIXTURE = json.loads((ROOT / "tests/replay/maintenance-considered-failure.json").read_text(encoding="utf-8"))
PROJECT = "cezar-factory"
PATCH = "diff --git a/source.py b/source.py\n--- a/source.py\n+++ b/source.py\n@@ -1 +1 @@\n-before\n+after\n"


def model_result(**overrides):
    value = {"status": "repaired", "classification": "code", "rootCause": "Strict-mode property read", "summary": "Guard the read",
             "files": ["source.py"], "patch": PATCH, "requestedFiles": [],
             "selfReview": {"scope": "one read", "risk": "low", "invariants": "contract kept", "unresolvedFindings": []}}
    value.update(overrides)
    return value


class FakeServices(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, runs):
        super().__init__(("127.0.0.1", 0), Handler)
        self.runs = runs
        self.model_responses = []
        self.model_requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        base = f"/api/v1/p/{PROJECT}"
        if self.path == base + "/runs":
            return self.send(200, json.dumps(self.server.runs))
        if self.path.endswith("/history"):
            return self.send(200, json.dumps(FIXTURE["history"]))
        if self.path.endswith("/handoff"):
            return self.send(200, FIXTURE["handoff"], "text/plain")
        self.send(404, "{}")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.model_requests.append(body)
        if not self.server.model_responses:
            return self.send(503, "{}")
        content = self.server.model_responses.pop(0)
        self.send(200, json.dumps({"choices": [{"message": {"content": json.dumps(content)}}]}))


class RepairReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="repair-replay-")
        self.root = pathlib.Path(self.tmp.name)
        self.repo = self.root / "repo"
        (self.repo / ".factory").mkdir(parents=True)
        (self.repo / "workflows").mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        repair.git(self.repo, "config", "user.name", "Factory Test")
        repair.git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "AGENTS.md").write_text("Keep the contract\n")
        (self.repo / "source.py").write_text("before\n")
        (self.repo / "workflows/maintenance.yaml").write_text("name: factory-maintenance\n")
        # Tracked run scratch named by the failure evidence: the repo really does track these on dev.
        (self.repo / ".factory/backlog-label-audit.json").write_text("{}\n")
        (self.repo / ".factory/backlog-label-audit-input.json").write_text("{}\n")
        repair.git(self.repo, "add", "-A")
        repair.git(self.repo, "commit", "-qm", "baseline")
        self.head = repair.git(self.repo, "rev-parse", "HEAD")
        self.config = self.root / "failure-repair.json"
        self.config.write_text(json.dumps({"schemaVersion": 1, "model": "local-model", "projects": {PROJECT: {
            "repository": "owner/project", "baseBranch": "dev", "channel": "dev", "validation": [["validator", "test"]],
            "deployment": {"kind": "commands", "commands": [["deploy", "{channel}", "{mergeSha}"]]}}}}))
        self.registry = self.root / "projects.json"
        self.registry.write_text(json.dumps([{"projectId": PROJECT}]))
        self.services = FakeServices(FIXTURE["runs"])
        threading.Thread(target=self.services.serve_forever, daemon=True).start()
        self.port = self.services.server_address[1]

    def tearDown(self):
        self.services.shutdown()
        self.services.server_close()
        self.tmp.cleanup()

    def run_controller(self, phase="run"):
        env = {"FACTORY_JOB_DEBUG": "1", "FACTORY_DEBUG_MODEL_URL": f"http://127.0.0.1:{self.port}/v1", "FACTORY_DEBUG_API_KEY": "test"}
        argv = [phase, "--api-url", f"http://127.0.0.1:{self.port}", "--project", PROJECT, "--config", str(self.config), "--registry", str(self.registry)]
        out = io.StringIO()
        cwd = os.getcwd()
        os.chdir(self.repo)
        try:
            with patch.dict(os.environ, env), contextlib.redirect_stdout(out):
                code = repair.main(argv)
        finally:
            os.chdir(cwd)
        receipt = json.loads(out.getvalue().strip().splitlines()[-1])
        return code, receipt

    def assert_repo_untouched(self):
        self.assertEqual(self.head, repair.git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual("", repair.git(self.repo, "status", "--porcelain", "--untracked-files=no"))
        self.assertEqual("before\n", (self.repo / "source.py").read_text())

    def test_selects_the_real_failure_and_sends_it_to_the_local_model_only(self):
        self.services.model_responses = [model_result(status="unresolved", files=[], patch="")]
        code, receipt = self.run_controller()
        self.assertEqual(0, code, receipt)
        self.assertEqual("5b384993-dd89-42e9-9db1-3fe5ac62ff0f", receipt["failure"]["runId"])
        self.assertEqual(1, len(self.services.model_requests))
        self.assertIn("considered", json.dumps(self.services.model_requests[0]))
        self.assertEqual(0, receipt["modelCalls"])  # no hosted calls
        self.assertEqual("debug-unresolved", receipt["status"])
        self.assert_repo_untouched()

    def test_protected_scratch_request_is_dropped_and_the_run_still_ends_cleanly(self):
        self.services.model_responses = [model_result(status="needs-context", files=[], patch="", requestedFiles=[
            {"path": ".factory/backlog-label-audit.json", "startLine": 1, "endLine": 100}])]
        code, receipt = self.run_controller()
        self.assertEqual(0, code, receipt)
        self.assertEqual("debug-unresolved", receipt["status"])
        self.assertEqual(1, len(self.services.model_requests))  # nothing allowed to fetch, so no second round
        self.assert_repo_untouched()

    def test_tracked_scratch_is_never_offered_to_the_model(self):
        self.services.model_responses = [model_result(status="unresolved", files=[], patch="")]
        self.run_controller()
        prompt = self.services.model_requests[0]["messages"][0]["content"]
        context = json.loads(prompt.split("Source context:\n", 1)[1])
        self.assertFalse(any(s["path"].startswith(".factory/") for s in context["sources"]))
        self.assertNotIn(".factory/", context["fileCatalog"])

    def test_valid_patch_is_dry_checked_without_changing_the_repo_or_history(self):
        self.services.model_responses = [model_result()]
        code, receipt = self.run_controller()
        self.assertEqual(0, code, receipt)
        self.assertEqual("debug-repaired", receipt["status"])
        self.assertTrue(receipt["patchApplies"])
        self.assert_repo_untouched()

    def test_unreachable_local_model_fails_with_a_clear_receipt(self):
        self.services.model_responses = []  # fake answers 503
        code, receipt = self.run_controller()
        self.assertEqual(1, code)
        self.assertEqual("failed", receipt["status"])
        self.assertIn("local model call", receipt["error"])
        self.assert_repo_untouched()

    def test_probe_rehearses_the_pre_model_path_with_no_model_history_or_git_effects(self):
        code, receipt = self.run_controller("probe")
        self.assertEqual(0, code, receipt)
        self.assertEqual("probe-ok", receipt["status"])
        self.assertEqual("5b384993-dd89-42e9-9db1-3fe5ac62ff0f", receipt["runId"])
        self.assertEqual("valid", receipt["configuration"])
        self.assertGreater(receipt["sourceFiles"], 0)
        self.assertEqual([], self.services.model_requests)
        self.assertFalse((self.repo / ".ai").exists())  # no history database
        self.assert_repo_untouched()

    def test_probe_skips_cleanly_when_nothing_failed(self):
        self.services.runs = [r for r in FIXTURE["runs"] if r["status"] != "failed"]
        code, receipt = self.run_controller("probe")
        self.assertEqual((0, "skipped"), (code, receipt["status"]))

    def test_probe_fails_loudly_when_context_assembly_breaks(self):
        with patch.object(repair, "source_context", side_effect=repair.RepairError("Protected or non-relative source path")):
            code, receipt = self.run_controller("probe")
        self.assertEqual((1, "failed"), (code, receipt["status"]))
        self.assertIn("Protected", receipt["error"])

    def test_probe_rejects_an_invalid_present_configuration(self):
        self.config.write_text(json.dumps({"schemaVersion": 1, "projects": {PROJECT: {"repository": "not-a-repo"}}}))
        code, receipt = self.run_controller("probe")
        self.assertEqual((1, "failed"), (code, receipt["status"]))

    def test_no_failed_run_skips_without_calling_the_model(self):
        self.services.runs = [r for r in FIXTURE["runs"] if r["status"] != "failed"]
        code, receipt = self.run_controller()
        self.assertEqual(0, code)
        self.assertEqual("no-failed-run", receipt["reason"])
        self.assertEqual([], self.services.model_requests)


if __name__ == "__main__":
    unittest.main()
