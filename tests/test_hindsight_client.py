import importlib.util
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError


CLIENT_PATH = Path(__file__).parents[1] / "scripts" / "hindsight" / "client.py"
SPEC = importlib.util.spec_from_file_location("hindsight_client", CLIENT_PATH)
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)


class FakeResponse:
    def __init__(self, body, session_id="session-1"):
        self.body = body.encode("utf-8")
        self.headers = {"Mcp-Session-Id": session_id}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.body


class HindsightResponseTests(unittest.TestCase):
    def test_decodes_json_response(self):
        self.assertEqual(client.decode_mcp_response('{"result": {}}'), {"result": {}})

    def test_decodes_sse_with_event_metadata(self):
        body = "event: message\n\ndata: " + json.dumps({"result": {"ok": True}}) + "\n\n"
        self.assertEqual(client.decode_mcp_response(body), {"result": {"ok": True}})

    def test_mcp_request_accepts_sse_response(self):
        body = "\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n"
        with patch.object(client, "urlopen", return_value=FakeResponse(body)):
            value, session = client.mcp_request(
                "http://hindsight", "project-test", "", "initialize", {}, 1
            )
        self.assertEqual(value["id"], 1)
        self.assertEqual(session, "session-1")


class HindsightProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.candidate_path = self.root / "candidate.json"
        self.index_path = self.root / "deterministic.json"
        self.state_path = self.root / "provenance.jsonl"
        self.base_candidate = {
            "topic": "Stable async startup", "lesson": "Bound startup readiness by a deadline and surface the failed probe.",
            "kind": "successful-fix", "evidence": "The local startup suite reproduced and then passed.",
            "scope": "repo", "claimType": "fact", "evidenceLinks": [{"kind": "run", "ref": "run:verified-1"}],
        }

    def tearDown(self):
        self.temp.cleanup()

    def args(self, **overrides):
        values = {
            "project": "cezar-factory", "bank": "project-cezar-factory", "project_bank": "project-cezar-factory",
            "factory_bank": "factory-lessons", "objective": "async startup readiness", "task_class": "investigation",
            "keywords": ["test:startup-ready"], "failure_signature": "a" * 64, "timeout": 1,
            "candidate": str(self.candidate_path), "approved": True, "workflow": "factory-learn",
            "issue": "134", "worker": "codex", "model": "local", "output": str(self.root / "output.json"),
            "deterministic_index": str(self.index_path), "provenance_index": str(self.state_path),
        }
        values.update(overrides)
        return Namespace(**values)

    def write_candidate(self, candidate=None):
        self.candidate_path.write_text(json.dumps(candidate or self.base_candidate), encoding="utf-8")

    def write_index(self, records):
        self.index_path.write_text(json.dumps({"schemaVersion": 1, "records": records}), encoding="utf-8")

    def test_candidates_require_scope_claim_type_and_evidence_link(self):
        for field, reason in (("scope", "missing-or-invalid-scope"),
                              ("claimType", "missing-or-invalid-claim-type"),
                              ("evidenceLinks", "evidence-link-required")):
            candidate = dict(self.base_candidate)
            candidate.pop(field)
            self.assertEqual(client.candidate_allowed(candidate), (False, reason))

    def test_fact_without_validated_deterministic_evidence_is_retained_as_hypothesis(self):
        self.write_candidate()
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", return_value={"id": "memory-1"}
        ) as call:
            receipt = client.retain(self.args())
        self.assertEqual(receipt["status"], "retained")
        self.assertEqual(receipt["record"]["claimType"], "hypothesis")
        self.assertEqual(receipt["record"]["validationStatus"], "unvalidated")
        metadata = call.call_args.args[4]["metadata"]
        self.assertEqual(metadata["claimType"], "hypothesis")
        self.assertEqual(metadata["evidenceLinks"][0]["validationStatus"], "unvalidated")
        self.assertRegex(call.call_args.args[4]["document_id"], r"^cezar-memory-[a-f0-9]{32}$")

    def test_retention_rejects_missing_evidence_links_without_calling_hindsight(self):
        candidate = dict(self.base_candidate, evidenceLinks=[])
        self.write_candidate(candidate)
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(client, "mcp_call") as call:
            receipt = client.retain(self.args())
        self.assertEqual(receipt["status"], "rejected")
        self.assertEqual(receipt["reason"], "evidence-link-required")
        call.assert_not_called()

    def test_validated_run_reference_can_support_a_fact(self):
        self.write_candidate()
        self.write_index([{"kind": "run", "id": "run-1", "ref": "run:verified-1", "verified": True, "contentHash": "b" * 64}])
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", return_value={"memoryId": "memory-1"}
        ):
            receipt = client.retain(self.args())
        self.assertEqual(receipt["record"]["claimType"], "fact")
        self.assertEqual(receipt["record"]["validationStatus"], "validated")

    def test_recall_returns_deterministic_matches_first_and_captures_versions(self):
        self.write_index([
            {"kind": "fingerprint", "id": "failure-1", "ref": "ledger:failure-1", "fingerprint": "a" * 64, "verified": True},
            {"kind": "test", "id": "test-1", "ref": "verification:test-1", "testId": "test:startup-ready", "verified": True},
        ])
        record = client.create_record(client.normalized_candidate(self.base_candidate, self.args()), "memory-1", self.args(), [])
        client.append_state(self.state_path, {"event": "retained", "timestamp": record["retainedAt"], "record": record})
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", return_value={"memories": [{"id": "memory-1", "content": record["lesson"], "score": 0.9}]}
        ):
            result = client.recall(self.args())
        self.assertEqual(result["status"], "ok")
        self.assertEqual([row["kind"] for row in result["deterministicMatches"]], ["fingerprint", "test"])
        self.assertEqual(result["selected"][0]["version"], 1)
        self.assertEqual(result["retrievalCapture"]["memories"][0]["contentHash"], record["contentHash"])
        self.assertEqual(result["retrievalCapture"]["project"], "cezar-factory")

    def test_legacy_recall_records_unknown_version_without_inventing_one(self):
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", return_value={"memories": [{"id": "legacy-1", "content": "Legacy unversioned advice."}]}
        ):
            result = client.recall(self.args())
        self.assertIsNone(result["selected"][0]["version"])
        self.assertIsNone(result["retrievalCapture"]["memories"][0]["version"])
        self.assertEqual(result["selected"][0]["validationStatus"], "unvalidated")

    def test_recall_stays_within_eight_memories_and_twelve_thousand_characters(self):
        self.index_path.unlink(missing_ok=True)
        response = {"memories": [{"id": f"m-{index}", "content": "x" * 1800} for index in range(12)]}
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(client, "mcp_call", return_value=response):
            result = client.recall(self.args())
        self.assertLessEqual(result["memoryCount"], client.MAX_MEMORIES)
        self.assertLessEqual(result["contextChars"], client.MAX_CHARS)
        self.assertLessEqual(len(result["retrievalCapture"]["memories"]), client.MAX_MEMORIES)

    def test_provenance_index_appends_concurrent_events_without_losing_records(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda index: client.append_state(self.state_path, {"event": "test", "id": index}), range(40)))
        records = client.read_json_lines(self.state_path)
        self.assertEqual(len(records), 40)
        self.assertEqual({row["id"] for row in records}, set(range(40)))

    def test_supersede_requires_validated_evidence_and_marks_old_record(self):
        self.write_index([{"kind": "run", "id": "run-1", "ref": "run:verified-1", "verified": True}])
        self.write_candidate()
        args = self.args()
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", side_effect=[{"id": "memory-old"}, {"id": "memory-new"}]
        ):
            first = client.retain(args)
            candidate = dict(self.base_candidate, lesson="Use the concrete health endpoint and a bounded retry window.")
            self.write_candidate(candidate)
            second = client.retain(args, supersedes="memory-old")
        self.assertEqual(first["status"], "retained")
        self.assertEqual(second["status"], "retained")
        state = client.state_records(args)
        self.assertTrue(state["memory-old"]["superseded"])
        self.assertEqual(state["memory-old"]["supersededBy"], "memory-new")
        self.assertEqual(state["memory-new"]["supersedes"], "memory-old")
        self.assertEqual(state["memory-new"]["versionHistory"][-1]["id"], "memory-old")

    def test_recall_excludes_superseded_memory_and_unconfigured_hindsight_degrades(self):
        old = client.create_record(client.normalized_candidate(self.base_candidate, self.args()), "old", self.args(), [])
        client.append_state(self.state_path, {"event": "retained", "timestamp": old["retainedAt"], "record": old})
        replacement = dict(old, id="new", supersedes="old", superseded=False, retainedAt="2026-01-01T00:00:00Z")
        client.append_state(self.state_path, {"event": "retained", "timestamp": replacement["retainedAt"], "record": replacement, "supersedes": "old"})
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", return_value={"memories": [
                {"id": "old", "content": "disproven memory"}, {"id": "new", "content": replacement["lesson"]}]}
        ):
            result = client.recall(self.args())
        self.assertEqual([row["id"] for row in result["selected"]], ["new"])
        with patch.dict(os.environ, {}, clear=True):
            unavailable = client.recall(self.args())
        self.assertEqual(unavailable["status"], "unavailable")
        self.assertEqual(unavailable["retrievalCapture"]["memories"], [])

    def test_unreachable_hindsight_degrades_to_unavailable(self):
        with patch.dict(os.environ, {"HINDSIGHT_URL": "http://hindsight"}), patch.object(
            client, "mcp_call", side_effect=URLError("offline")
        ):
            result = client.recall(self.args())
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["warning"], "Hindsight recall unavailable; continuing without recall.")


if __name__ == "__main__":
    unittest.main()
