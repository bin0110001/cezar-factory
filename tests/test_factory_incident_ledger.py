import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.release.factory_incident_ledger import (
    IncidentLedger,
    IncidentLedgerError,
    failure_fingerprint,
    normalize_failure,
)


class IncidentLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "incidents.sqlite3"

    def test_normalization_and_fingerprint_ignore_volatile_values_and_redact_secrets(self):
        left = "Release failed for abcdef0123456789abcdef0123456789abcdef01 at C:\\work\\old\\release.py:40 (runId=123, port=4300, 1700000000)"
        right = "Release failed for 0123456789abcdef0123456789abcdef01234567 at D:\\tmp\\new\\deploy.py:92 (runId=987, port=5100, 1700000100)"
        self.assertEqual(failure_fingerprint("release", left), failure_fingerprint("release", right))
        self.assertNotEqual(failure_fingerprint("release", left), failure_fingerprint("automation", left))
        safe = normalize_failure("Authorization: Bearer secret-value api_key=sk-abcdefghijklmnop")
        self.assertNotIn("secret-value", safe)
        self.assertNotIn("sk-abcdefghijklmnop", safe)
        self.assertEqual(len(failure_fingerprint("release", left)), 64)

    def test_budgets_backoff_and_escalation_persist_across_reopen(self):
        policies = {"release": {"budget": 3, "baseDelaySeconds": 10, "maxDelaySeconds": 40}}
        ledger = IncidentLedger(self.db, policies=policies)
        first = ledger.record_failure("release", "deployment failed", now=1000)
        self.assertEqual(first["attempt"], 1)
        self.assertEqual(first["nextAttemptAt"], 1010)
        early = ledger.record_failure("release", "deployment failed", now=1009)
        self.assertFalse(early["allowed"])
        self.assertEqual(early["reason"], "backoff")

        reopened = IncidentLedger(self.db, policies=policies)
        second = reopened.record_failure("release", "deployment failed", now=1010)
        self.assertEqual(second["attempt"], 2)
        self.assertEqual(second["nextAttemptAt"], 1030)
        third = reopened.record_failure("release", "deployment failed", now=1030)
        self.assertTrue(third["escalated"])
        self.assertIsNone(third["nextAttemptAt"])
        exhausted = reopened.record_failure("release", "deployment failed", now=5000)
        self.assertFalse(exhausted["allowed"])
        self.assertEqual(exhausted["reason"], "budget-exhausted")
        self.assertEqual(len(reopened.attempts("release", first["fingerprint"])), 3)

    def test_release_failure_requires_candidate_linked_causal_evidence(self):
        ledger = IncidentLedger(self.db, policies={"release": {"budget": 4, "baseDelaySeconds": 0, "maxDelaySeconds": 0}})
        sha = "a" * 40
        debt = ledger.record_failure("release", "candidate failed at scripts/release/run.py", now=10)
        self.assertTrue(debt["knownDebt"])
        self.assertFalse(debt["releaseFailure"])
        linked = ledger.record_failure(
            "release", "candidate failed at scripts/release/run.py", candidate_sha=sha,
            causal_evidence={"candidateSha": sha, "source": "validation receipt", "stage": "full-suite"}, now=11,
        )
        self.assertFalse(linked["knownDebt"])
        self.assertTrue(linked["releaseFailure"])
        incident = ledger.get_incident("release", debt["fingerprint"])
        self.assertEqual(incident["release_failure_count"], 1)
        self.assertEqual(incident["attempt_count"], 2)
        self.assertEqual([row["release_failure"] for row in ledger.attempts("release", debt["fingerprint"])], [0, 1])

        mismatch = ledger.record_failure(
            "release", "other candidate failed", candidate_sha=sha,
            causal_evidence={"candidateSha": "b" * 40, "source": "validation receipt", "stage": "full-suite"}, now=12,
        )
        self.assertTrue(mismatch["knownDebt"])
        with self.assertRaises(IncidentLedgerError):
            ledger.record_failure("release", "invalid sha", candidate_sha="short", now=13)

    def test_version_zero_database_migrates_additively_and_preserves_incidents(self):
        fingerprint = "c" * 64
        db = sqlite3.connect(self.db)
        try:
            db.execute("""CREATE TABLE incidents (
                failure_class TEXT NOT NULL, fingerprint TEXT NOT NULL, summary TEXT NOT NULL,
                first_seen REAL NOT NULL, last_seen REAL NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(failure_class, fingerprint)
            )""")
            db.execute("INSERT INTO incidents VALUES(?,?,?,?,?,?)", ("release", fingerprint, "old incident", 1, 2, 1))
            db.execute("PRAGMA user_version=0")
            db.commit()
        finally:
            db.close()

        ledger = IncidentLedger(self.db)
        incident = ledger.get_incident("release", fingerprint)
        self.assertEqual(incident["summary"], "old incident")
        self.assertEqual(incident["attempt_count"], 1)
        self.assertEqual(incident["known_debt"], 1)
        self.assertEqual(incident["causal_evidence"], {})
        IncidentLedger(self.db)  # migration is idempotent

        db = sqlite3.connect(self.db)
        try:
            db.execute("PRAGMA user_version=2")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(IncidentLedgerError, "newer than supported"):
            IncidentLedger(self.db)

    def test_hindsight_summary_is_best_effort_and_receives_only_safe_metadata(self):
        seen = []

        def broken_summary(summary):
            seen.append(summary)
            raise RuntimeError("offline")

        ledger = IncidentLedger(self.db, hindsight_summarizer=broken_summary)
        result = ledger.record_failure("infrastructure", "authorization bearer secret-value", now=5)
        self.assertTrue(result["allowed"])
        self.assertEqual(result["hindsightSummary"], "unavailable")
        self.assertNotIn("secret-value", str(seen))
        self.assertEqual(set(seen[0]), {"failureClass", "fingerprint", "attempt", "escalated", "knownDebt", "releaseFailure"})
        self.assertIsNotNone(ledger.get_incident("infrastructure", result["fingerprint"]))

    def test_invalid_policy_is_rejected(self):
        with self.assertRaises(IncidentLedgerError):
            IncidentLedger(self.db, policies={"release": {"budget": 0}})


if __name__ == "__main__":
    unittest.main()
