import os
import tempfile
import unittest
from datetime import datetime, timezone

from scripts.release import release_triggers as rt
from scripts.release.release_candidate_store import CandidateStore

UTC = timezone.utc
TZ = "America/Detroit"
WEEKLY = {"frequency": "weekly", "dayOfWeek": "thursday", "hour": 3, "minute": 0, "timezone": TZ}
DAILY = {"frequency": "daily", "hour": 2, "minute": 30, "timezone": TZ}


def at(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


def dev(**over):
    base = dict(dev_sha="d" * 40, last_accepted_sha="c" * 40, commits_since=0, changed_paths=["src/a.py"], last_candidate_at=None, oldest_unpromoted_at=None)
    base.update(over)
    return rt.DevState(**base)


class Schedules(unittest.TestCase):
    def test_weekly_fires_once_then_waits_for_next_week(self):
        now = at(2026, 11, 16, 12)  # Monday
        d = rt.schedule_decision(WEEKLY, last_fired=None, now=now)
        self.assertEqual(d.action, "request")
        self.assertEqual(datetime.fromtimestamp(d.occurrence, UTC), at(2026, 11, 12, 8))  # Thursday 03:00 EST
        self.assertEqual(rt.schedule_decision(WEEKLY, last_fired=d.occurrence, now=now).action, "skip")
        nxt = rt.schedule_decision(WEEKLY, last_fired=d.occurrence, now=at(2026, 11, 19, 8, 1))
        self.assertEqual(nxt.action, "request")

    def test_daily_spring_forward_gap_fires_once_after_the_gap(self):
        ticks = rt.occurrences(DAILY, at(2026, 3, 7, 12), at(2026, 3, 8, 12))
        self.assertEqual(ticks, [at(2026, 3, 8, 7, 30)])  # 02:30 does not exist; 03:30 EDT
        # local time stays 02:30 on the surrounding days despite the offset change
        before = rt.occurrences(DAILY, at(2026, 3, 6, 12), at(2026, 3, 7, 12))
        after = rt.occurrences(DAILY, at(2026, 3, 8, 12), at(2026, 3, 9, 12))
        self.assertEqual((before, after), ([at(2026, 3, 7, 7, 30)], [at(2026, 3, 9, 6, 30)]))

    def test_daily_fall_back_ambiguous_hour_fires_once(self):
        schedule = {**DAILY, "hour": 1, "minute": 30}
        ticks = rt.occurrences(schedule, at(2026, 10, 31, 12), at(2026, 11, 1, 12))
        self.assertEqual(ticks, [at(2026, 11, 1, 5, 30)])  # first 01:30 only, not also 06:30Z

    def test_missed_ticks_coalesce_or_skip(self):
        now = at(2026, 11, 16, 12)
        last = at(2026, 11, 10, 12).timestamp()
        coalesced = rt.schedule_decision(DAILY, last_fired=last, now=now, missed="coalesce")
        self.assertEqual(coalesced.action, "request")
        self.assertTrue(any("coalesced" in r for r in coalesced.reasons))
        skipped = rt.schedule_decision(DAILY, last_fired=last, now=now, missed="skip", grace_minutes=60)
        self.assertEqual(skipped.action, "skip")
        self.assertIsNotNone(skipped.occurrence)  # the tick is consumed so it is not retried forever
        recent = rt.schedule_decision(DAILY, last_fired=at(2026, 11, 15, 7, 30).timestamp(), now=at(2026, 11, 16, 7, 45), missed="skip", grace_minutes=60)
        self.assertEqual(recent.action, "request")


class ChangeRules(unittest.TestCase):
    NOW = at(2026, 11, 16, 15)

    def decide(self, rules, **d):
        return rt.change_decision({"enabled": True, **rules}, dev(**d), now=self.NOW, default_tz=TZ)

    def test_disabled_unchanged_and_irrelevant_are_no_ops(self):
        self.assertEqual(rt.change_decision({"enabled": False}, dev(), now=self.NOW).action, "skip")
        same = self.decide({"minCommits": 1}, last_accepted_sha="d" * 40, commits_since=9)
        self.assertEqual((same.action, same.reasons), ("skip", ["dev SHA equals the last accepted candidate"]))
        self.assertEqual(self.decide({"paths": ["src/**"]}, changed_paths=["docs/x.md"], commits_since=9).action, "skip")

    def test_thresholds_and_combinator(self):
        self.assertEqual(self.decide({"minCommits": 5}, commits_since=3).action, "skip")
        self.assertEqual(self.decide({"minCommits": 5}, commits_since=5).action, "request")
        both = {"minCommits": 5, "minFiles": 2, "combinator": "all"}
        self.assertEqual(self.decide(both, commits_since=9, changed_paths=["src/a.py"]).action, "skip")
        self.assertEqual(self.decide(both, commits_since=9, changed_paths=["src/a.py", "src/b.py"]).action, "request")
        any_ = {**both, "combinator": "any"}
        self.assertEqual(self.decide(any_, commits_since=9, changed_paths=["src/a.py"]).action, "request")

    def test_elapsed_since_last_candidate_and_risk_signal(self):
        hours = lambda h: self.NOW.timestamp() - h * 3600  # noqa: E731
        self.assertEqual(self.decide({"minElapsedHours": 12}, last_candidate_at=hours(3)).action, "skip")
        self.assertEqual(self.decide({"minElapsedHours": 12}, last_candidate_at=hours(13)).action, "request")
        self.assertEqual(self.decide({"minCommits": 50, "combinator": "any"}, commits_since=1, risk_flag=True).action, "request")

    def test_cooldown_and_quiet_hours_defer_with_a_retry_time(self):
        recent = self.NOW.timestamp() - 600
        cool = self.decide({"minCommits": 1, "cooldownMinutes": 60}, commits_since=3, last_candidate_at=recent)
        self.assertEqual(cool.action, "defer")
        self.assertAlmostEqual(cool.retry_at, recent + 3600)
        quiet = {"minCommits": 1, "quietHours": {"start": 9, "end": 17}}  # 15:00Z is 10:00 Detroit
        d = self.decide(quiet, commits_since=3)
        self.assertEqual(d.action, "defer")
        self.assertEqual(datetime.fromtimestamp(d.retry_at, UTC), at(2026, 11, 16, 22))  # 17:00 EST
        wrap = rt.change_decision({"enabled": True, "minCommits": 1, "quietHours": {"start": 22, "end": 6}}, dev(commits_since=3), now=at(2026, 11, 17, 8), default_tz=TZ)
        self.assertEqual(wrap.action, "defer")  # 03:00 Detroit is inside the wrapping 22-06 window

    def test_max_delay_overrides_thresholds_and_quiet_hours(self):
        old = self.NOW.timestamp() - 80 * 3600
        d = self.decide({"minCommits": 99, "maxDelayHours": 72, "quietHours": {"start": 9, "end": 17}}, commits_since=1, oldest_unpromoted_at=old)
        self.assertEqual(d.action, "request")
        self.assertTrue(any("maxDelayHours" in r for r in d.reasons))


class Admission(unittest.TestCase):
    def test_explains_every_refusal_and_backs_off(self):
        d = rt.admission(fast_checks_passed=False, capacity_available=False, ref_reachable=False, queue_empty=False, require_empty_queue=True)
        self.assertEqual(d.action, "defer")
        self.assertEqual(len(d.reasons), 4)
        self.assertEqual(rt.admission(fast_checks_passed=True, capacity_available=True, ref_reachable=True).action, "request")
        self.assertEqual([rt.backoff_seconds(n) for n in (0, 1, 2, 3)], [0.0, 60.0, 120.0, 240.0])
        self.assertEqual(rt.backoff_seconds(30), 3600.0)


class WithTheStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = CandidateStore(os.path.join(self.tmp.name, "c.db"))
        self.triggers = {"manual": True, "schedule": DAILY, "afterChanges": {"enabled": True, "minCommits": 1}}
        self.now = at(2026, 11, 16, 12)

    def tearDown(self):
        self.tmp.cleanup()

    def sources(self):
        return rt.evaluate(self.triggers, project="p", now=self.now, dev=dev(commits_since=3), last_schedule_fired=None, manual_request="operator", default_tz=TZ)

    def submit_all(self):
        out = []
        for d in self.sources():
            if d.action == "request":
                out.append(rt.submit(self.store, "p", d, dev=dev(commits_since=3), base_stable_sha="b" * 40, config_hash="h", now=self.now.timestamp()))
        return out

    def test_all_sources_firing_yield_one_candidate_and_one_pending_request(self):
        first = self.submit_all()
        self.assertEqual([r["result"] for r in first], ["admitted", "pending", "pending"])
        self.assertEqual(len(self.store.pending_request("p")["history"]), 2)
        self.assertEqual(self.store.active("p")["state"], "requested")

    def test_active_candidate_means_every_source_goes_pending(self):
        self.store.request("p", trigger="manual", reason="first", dev_sha="d" * 40, base_stable_sha="b" * 40, config_hash="h", now=1.0)
        results = self.submit_all()
        self.assertEqual({r["result"] for r in results}, {"pending"})
        self.assertEqual(len(self.store.pending_request("p")["history"]), 3)

    def test_replayed_events_do_not_duplicate(self):
        self.submit_all()
        again = self.submit_all()
        self.assertTrue(all(r.get("replayed") for r in again))
        self.assertEqual(len(self.store.pending_request("p")["history"]), 2)

    def test_priority_orders_decisions_and_disabled_manual_is_refused(self):
        self.triggers["priority"] = ["change", "schedule", "manual"]
        self.assertEqual([d.trigger for d in self.sources()], ["change", "schedule", "manual"])
        self.triggers["manual"] = False
        manual = [d for d in self.sources() if d.trigger == "manual"][0]
        self.assertEqual(manual.action, "skip")

    def test_submit_refuses_non_request_decisions(self):
        with self.assertRaises(ValueError):
            rt.submit(self.store, "p", rt.Decision("skip"), dev=dev(), base_stable_sha="b" * 40, config_hash="h")


if __name__ == "__main__":
    unittest.main()
