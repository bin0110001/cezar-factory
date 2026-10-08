import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


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


if __name__ == "__main__":
    unittest.main()
