import hashlib
import json
import pathlib
import tempfile
import unittest
from unittest import mock

from scripts.release import factory_control_center as cc


class ControlCenterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.repo = self.root / "repo"
        (self.repo / ".git").mkdir(parents=True)
        self.store = self.root / "store"
        self.store.mkdir()
        self.service = cc.ControlCenter(self.repo, self.store, cache_file=self.root / "cache.json")

    def tearDown(self):
        self.temp.cleanup()

    def test_action_request_is_strict_and_validates_protection_fields(self):
        base = {"schemaVersion": cc.ACTION_SCHEMA, "idempotencyKey": "operator-request-0001", "action": "stage", "channel": "dev", "reason": "Stage candidate"}
        self.assertEqual(cc._validate_action_request(base)["action"], "stage")
        with self.assertRaises(cc.ControlCenterError):
            cc._validate_action_request({**base, "unexpected": "ignored"})
        with self.assertRaises(cc.ControlCenterError):
            cc._validate_action_request({**base, "action": "protect", "sha": "a" * 40})
        with self.assertRaises(cc.ControlCenterError):
            cc._validate_action_request({**base, "action": "sync", "sha": "a" * 40})

    def test_role_denial_is_audited(self):
        with self.assertRaises(cc.ControlCenterError) as raised:
            self.service.authorize({"tokenId": "reader", "scopes": ["read"]}, "rollback")
        self.assertEqual(raised.exception.status, 403)
        events = self.service.list_events()
        self.assertEqual(events["items"][0]["eventType"], "action-denied")

    def test_idempotency_replay_does_not_repeat_controller_action(self):
        request = {"schemaVersion": cc.ACTION_SCHEMA, "idempotencyKey": "operator-request-0002", "action": "stage", "channel": "dev", "reason": "Stage candidate"}
        identity = {"tokenId": "operator", "scopes": ["stage"]}
        controller = mock.MagicMock()
        controller.store = self.store
        controller.stage_current.return_value = {"state": "verified", "sourceSha": "a" * 40}
        with mock.patch.object(cc, "ReleaseController", return_value=controller), mock.patch.object(cc, "exclusive_lock"):
            first, replayed = self.service.submit_action(request, identity)
            second, replayed_again = self.service.submit_action(request, identity)
        self.assertFalse(replayed)
        self.assertTrue(replayed_again)
        self.assertEqual(first["status"], "succeeded")
        self.assertEqual(second, first)
        controller.stage_current.assert_called_once_with()

    def test_interrupted_action_is_fenced(self):
        request = {"schemaVersion": cc.ACTION_SCHEMA, "idempotencyKey": "operator-request-0003", "action": "stage", "channel": "dev", "reason": "Stage candidate"}
        identity = {"tokenId": "operator", "scopes": ["stage"]}
        parsed = cc._validate_action_request(request)
        db = self.service._connect_write()
        try:
            db.execute("INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?)", (request["idempotencyKey"], cc._sha256_text(cc.canonical_json(parsed)), "stage", "dev", "operator", "running", cc.utc_now(), None, None))
        finally:
            db.close()
        with mock.patch.object(cc, "ReleaseController") as controller:
            receipt, replayed = self.service.submit_action(request, identity)
        self.assertTrue(replayed)
        self.assertEqual(receipt["status"], "running")
        controller.assert_not_called()

    def test_pagination_is_bounded_and_cursor_is_validated(self):
        self.service.read = lambda: {"releases": [{"stagedAt": f"2026-01-0{i}T00:00:00Z", "sourceSha": str(i) * 40, "channel": "dev", "state": "verified"} for i in range(1, 4)]}
        first = self.service.list_releases(limit=2)
        self.assertEqual(len(first["items"]), 2)
        second = self.service.list_releases(limit=2, cursor=first["nextCursor"])
        self.assertEqual(len(second["items"]), 1)
        with self.assertRaises(cc.ControlCenterError):
            self.service.list_releases(limit=101)
        with self.assertRaises(cc.ControlCenterError):
            self.service.list_releases(cursor="bad")

    def test_offline_snapshot_uses_cached_data_and_marks_it_degraded(self):
        online = {"schemaVersion": cc.API_SCHEMA, "generatedAt": "2026-01-01T00:00:00Z", "source": {"status": "online", "observedAt": "2026-01-01T00:00:00Z", "reasons": []}, "projects": [], "releases": [{"freshness": "fresh", "health": "healthy"}], "promotions": [], "incidents": [], "workerResources": {}}
        self.service._write_cache(online)
        self.service._live_snapshot = lambda: (_ for _ in ()).throw(OSError("offline"))
        result = self.service.read()
        self.assertEqual(result["source"]["status"], "offline")
        self.assertEqual(result["releases"][0]["health"], "unknown")
        self.assertEqual(result["releases"][0]["freshness"], "stale")

    def test_access_file_stores_hash_and_authenticates_token(self):
        token = "sample-token-value"
        access = self.root / "access.json"
        access.write_text(json.dumps({"schemaVersion": "factory-control-center-access/v1", "tokens": [{"tokenId": "viewer-1", "tokenSha256": hashlib.sha256(token.encode()).hexdigest(), "roles": ["viewer"]}]}), encoding="utf-8")
        service = cc.ControlCenter(self.repo, self.store, token_file=access)
        self.assertEqual(service.authenticate(token)["tokenId"], "viewer-1")
        with self.assertRaises(cc.ControlCenterError):
            service.authenticate("wrong-token")

    def test_scrubber_removes_paths_and_credentials(self):
        value = "failed at C:\\Users\\alice\\secret.txt with bearer abcdefghijklmnop and api_key=hunter2"
        safe = cc._scrub_text(value)
        self.assertNotIn("C:\\Users", safe)
        self.assertNotIn("abcdefghijklmnop", safe)
        self.assertNotIn("hunter2", safe)

    def test_server_rejects_non_loopback_address(self):
        with self.assertRaises(cc.ControlCenterError):
            cc.run_server(self.service, "0.0.0.0", 0)


if __name__ == "__main__":
    unittest.main()
