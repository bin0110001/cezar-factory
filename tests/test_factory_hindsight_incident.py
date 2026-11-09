import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

PATH = Path(__file__).parents[1] / "scripts" / "hindsight" / "incident.py"
SPEC = importlib.util.spec_from_file_location("hindsight_incident", PATH)
inc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inc)

ENV = {"HINDSIGHT_URL": "http://hindsight"}
EVENT = {"event": "resolved", "findingId": "F-1", "runId": "run-9", "commit": "abc1234",
         "evidenceIds": ["ev-1"], "verified": True, "summary": "Timeout fixed", "fix": "Raise retry cap"}


class FakeHindsight:
    """Records retains per bank, keyed by document_id so duplicates collapse."""
    def __init__(self, fail=0):
        self.fail, self.banks, self.calls = fail, {}, 0

    def __call__(self, base, bank, token, tool, args, timeout):
        self.calls += 1
        if self.fail:
            self.fail -= 1
            raise URLError("down")
        if tool == "retain":
            self.banks.setdefault(bank, {})[args["document_id"]] = args["content"]
            return {"id": args["document_id"]}
        return {"memories": [{"id": k, "content": v, "score": 0.9} for k, v in self.banks.get(bank, {}).items()]}


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.box = str(Path(self.tmp.name) / "outbox.json")
        patcher = patch.dict(os.environ, ENV, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_duplicate_enqueue_and_retain_yield_one_memory(self):
        fake = FakeHindsight()
        self.assertEqual(inc.enqueue(self.box, "p", "bank-p", EVENT)["status"], "queued")
        self.assertEqual(inc.enqueue(self.box, "p", "bank-p", EVENT)["status"], "duplicate")
        inc.flush(self.box, call=fake)
        self.assertEqual(inc.enqueue(self.box, "p", "bank-p", EVENT)["status"], "duplicate")
        inc.flush(self.box, call=fake)
        self.assertEqual(len(fake.banks["bank-p"]), 1)

    def test_outage_keeps_entry_and_retry_is_idempotent(self):
        fake = FakeHindsight(fail=1)
        inc.enqueue(self.box, "p", "bank-p", EVENT)
        self.assertEqual(inc.flush(self.box, call=fake)["status"], "unavailable")
        self.assertEqual(len(inc.load_outbox(self.box)["pending"]), 1)
        self.assertEqual(inc.flush(self.box, call=fake)["retained"], 1)
        self.assertEqual(len(fake.banks["bank-p"]), 1)
        self.assertEqual(inc.load_outbox(self.box)["pending"], [])

    def test_disabled_is_non_fatal_and_keeps_queue(self):
        inc.enqueue(self.box, "p", "bank-p", EVENT)
        with patch.dict(os.environ, {"HINDSIGHT_INCIDENT_MEMORY": "0"}):
            self.assertEqual(inc.flush(self.box, call=FakeHindsight())["status"], "disabled")
            self.assertEqual(inc.recall("p", "bank-p", "q", call=FakeHindsight())["status"], "unavailable")

    def test_recall_outage_degrades_to_unavailable(self):
        self.assertEqual(inc.recall("p", "bank-p", "q", call=FakeHindsight(fail=1))["status"], "unavailable")

    def test_bank_isolation(self):
        fake = FakeHindsight()
        inc.enqueue(self.box, "a", "bank-a", EVENT)
        inc.enqueue(self.box, "b", "bank-b", dict(EVENT, summary="other project"))
        inc.flush(self.box, call=fake)
        got = inc.recall("a", "bank-a", "q", call=fake)
        self.assertEqual(len(got["items"]), 1)
        self.assertNotIn("other project", json.dumps(got))
        # Defence in depth: a foreign-project memory returned from a bank is dropped.
        foreign = inc.render(inc.build_entry("b", "bank-b", EVENT))
        self.assertEqual(inc.interpret([{"id": "x", "content": foreign}], "a"), [])

    def test_secrets_are_redacted_and_content_bounded(self):
        event = dict(EVENT, summary="token: zq9v8w7 " + "x" * 5000 + " ghp_" + "A" * 30,
                     fix="Authorization: Bearer topsecret", evidenceIds=["ok-1", "bad id with space"])
        entry = inc.build_entry("p", "bank-p", event)
        text = inc.render(entry)
        for leak in ("zq9v8w7", "topsecret", "ghp_AAAA"):
            self.assertNotIn(leak, text)
        self.assertLessEqual(len(text), inc.LIMITS["maxContentChars"])
        self.assertEqual(entry["evidenceIds"], ["ok-1"])

    def test_hypothesis_never_rendered_as_fact_and_provenance_present(self):
        fake = FakeHindsight()
        inc.enqueue(self.box, "p", "bank-p", dict(EVENT, event="first-seen", verified=True, findingId="F-2"))
        inc.enqueue(self.box, "p", "bank-p", EVENT)
        inc.flush(self.box, call=fake)
        items = {i["provenance"]["findingId"]: i for i in inc.recall("p", "bank-p", "q", call=fake)["items"]}
        self.assertEqual(items["F-1"]["marker"], "verified")
        self.assertEqual(items["F-1"]["provenance"]["evidenceIds"], ["ev-1"])
        self.assertEqual(items["F-2"]["marker"], "hypothesized")
        self.assertLessEqual(items["F-2"]["confidence"], 0.5)
        self.assertIn("hypothesis, not fact", items["F-2"]["advice"])
        plain = inc.interpret([{"id": "z", "content": "free text claim"}], "p")[0]
        self.assertEqual(plain["marker"], "hypothesized")

    def test_stale_by_age_and_by_reopen(self):
        old = "2020-01-01T00:00:00+00:00"
        item = lambda e: {"id": e["findingId"] + e["event"], "content": inc.render(inc.build_entry("p", "b", e))}
        aged = item(dict(EVENT, occurredAt=old))
        self.assertTrue(inc.interpret([aged], "p")[0]["stale"])
        now = time.time()
        fixed = item(dict(EVENT, occurredAt="2026-01-01T00:00:00+00:00"))
        reopened = item(dict(EVENT, event="reopened", runId="run-10", occurredAt="2026-02-01T00:00:00+00:00"))
        res = inc.interpret([fixed, reopened], "p", now=parse(now, "2026-03-01T00:00:00+00:00"))
        self.assertTrue(res[0]["stale"])
        self.assertFalse(res[1]["stale"])

    def test_outbox_is_bounded_and_expires(self):
        limits = dict(inc.LIMITS, maxEntries=3)
        box = {"pending": [{"key": str(i), "enqueuedAt": time.time()} for i in range(6)], "sent": []}
        with patch.object(inc, "LIMITS", limits):
            self.assertEqual(inc.bound_outbox(box, limits=limits), 3)
        self.assertEqual([e["key"] for e in box["pending"]], ["3", "4", "5"])
        stale = {"pending": [{"key": "old", "enqueuedAt": time.time() - 99 * 86400}], "sent": []}
        self.assertEqual(inc.bound_outbox(stale), 1)

    def test_invalid_event_rejected(self):
        self.assertEqual(inc.enqueue(self.box, "p", "b", {"event": "bogus", "findingId": "F"})["status"], "rejected")


def parse(_now, iso):
    return inc.parse_time(iso)


if __name__ == "__main__":
    unittest.main()
