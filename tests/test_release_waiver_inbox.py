import json
import unittest
from datetime import datetime, timezone

from scripts.release import quality_findings as qf
from scripts.release import release_waiver_inbox as inbox

POLICY = {"grantedBy": ["human", "operator"], "maxDays": 30}
NOW = 1_800_000_000.0


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def req(i="wvr-1", **over):
    r = {"id": i, "at": iso(NOW - 60), "actor": "local-operator", "reviewerKind": "operator", "projectId": "tableflux", "candidateId": None,
         "fingerprint": "a" * 64, "advisoryId": None, "stages": ["stable"], "pathGlob": None, "reason": "Upstream fix lands next week", "expiresAt": iso(NOW + 7 * 86400)}
    r.update(over)
    return r


def log(*rows):
    return "\n".join(json.dumps(r) for r in rows) + "\n"


class Decide(unittest.TestCase):
    def test_valid_request_becomes_an_operator_granted_suppression_with_a_receipt(self):
        [d] = inbox.process(log(req()), "", policy_waivers=POLICY, now=NOW)
        self.assertEqual(d["outcome"], "granted")
        self.assertEqual(d["suppression"]["scope"], {"project": "tableflux", "stages": ["stable"]})
        self.assertEqual(d["receipt"]["schemaVersion"], "quality-exception-receipt/v1")
        self.assertEqual(qf.suppression_problems(d["suppression"], POLICY, now=NOW), [])

    def test_a_request_the_policy_forbids_is_rejected_with_reasons(self):
        cases = [
            (req(reviewerKind="agent"), "agents cannot self-waive"),
            (req(expiresAt=iso(NOW + 90 * 86400)), "exceeds the policy maximum"),
            (req(expiresAt=iso(NOW - 10)), "expired"),
            (req(fingerprint=None, advisoryId=None), "no blanket waivers"),
            (req(expiresAt=None), "must expire"),
            (req(at="garbage"), "no readable time"),
        ]
        for r, needle in cases:
            [d] = inbox.process(log(r), "", policy_waivers=POLICY, now=NOW)
            self.assertEqual(d["outcome"], "rejected", needle)
            self.assertTrue(any(needle in p for p in d["problems"]), (needle, d["problems"]))
            self.assertNotIn("suppression", d)

    def test_a_policy_that_does_not_allow_operators_rejects_everything(self):
        [d] = inbox.process(log(req()), "", policy_waivers={"grantedBy": ["human"], "maxDays": 30}, now=NOW)
        self.assertEqual(d["outcome"], "rejected")


class Idempotent(unittest.TestCase):
    def test_a_decided_request_is_never_decided_twice(self):
        first = inbox.process(log(req("a"), req("b")), "", policy_waivers=POLICY, now=NOW)
        decided = log(*first)
        self.assertEqual(inbox.process(log(req("a"), req("b")), decided, policy_waivers=POLICY, now=NOW), [])
        later = inbox.process(log(req("a"), req("b"), req("c")), decided, policy_waivers=POLICY, now=NOW)
        self.assertEqual([d["requestId"] for d in later], ["c"])

    def test_duplicate_ids_in_one_log_and_damaged_lines_are_handled(self):
        text = log(req("a")) + "{not json\n" + log(req("a"), req("b"))
        self.assertEqual([d["requestId"] for d in inbox.process(text, "", policy_waivers=POLICY, now=NOW)], ["a", "b"])


class Applied(unittest.TestCase):
    def test_active_suppressions_are_per_project_granted_and_unexpired_and_actually_waive_the_finding(self):
        ds = inbox.process(log(req("a"), req("b", projectId="other"), req("c", reviewerKind="agent")), "", policy_waivers=POLICY, now=NOW)
        decided = log(*ds)
        active = inbox.active_suppressions(decided, project="tableflux", now=NOW)
        self.assertEqual(len(active), 1)
        self.assertEqual(inbox.active_suppressions(decided, project="tableflux", now=NOW + 8 * 86400), [])  # expired blocks again
        finding = {"fingerprint": "a" * 64, "severity": "high", "class": "security", "path": "x.py"}
        self.assertTrue(qf._matches(active[0], finding, project="tableflux", stage="stable"))
        self.assertFalse(qf._matches(active[0], finding, project="tableflux", stage="candidate"))


if __name__ == "__main__":
    unittest.main()
