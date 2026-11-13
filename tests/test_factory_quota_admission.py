import importlib.util
import random
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parents[1]
CAP = ROOT / "scripts" / "capacity"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, CAP / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ct = _load("capacity_telemetry")
qa = _load("quota_admission")
NOW = datetime(2026, 11, 7, 10, 30, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


class Fixed(ct.CapacityAdapter):
    """Capacity provider stub: per-window remaining (None = unknown), mutable."""

    def __init__(self, provider, clock, **remaining):
        self.provider, self.clock, self.remaining, self.reset = provider, clock, remaining, {}

    def snapshot(self, window, now=None):
        rem = self.remaining.get(window)
        if rem is None:
            return ct.unknown_snapshot(self.provider, window, "unknown")
        return ct.CapacitySnapshot(self.provider, window, "manual", "estimated", self.clock.now, rem, 100.0,
                                   "messages", self.reset.get(window), 3600)


def make(clock, a=None, b=None, **kw):
    ads = {"a": [Fixed("a", clock, **(a if a is not None else {"5h": 10, "weekly": 100}))],
           "b": [Fixed("b", clock, **(b if b is not None else {"5h": 10, "weekly": 100}))]}
    kw.setdefault("rng", random.Random(1))
    return qa.AdmissionController(ads, clock=clock, **kw), ads


def cands(*providers, cost=1.0):
    return [qa.Candidate(p, {"5h": cost, "weekly": cost}) for p in providers]


class AdmissionTests(unittest.TestCase):
    def test_exhausted_primary_falls_back(self):
        c = Clock()
        ctl, _ = make(c, a={"5h": 0, "weekly": 100})
        d = ctl.admit("j1", cands("a", "b"))
        self.assertEqual((d.status, d.provider, d.fallback), (qa.ADMITTED, "b", True))

    def test_any_window_exhausted_blocks(self):
        c = Clock()
        ctl, _ = make(c, a={"5h": 10, "weekly": 0})
        self.assertEqual(ctl.admit("j1", cands("a")).status, qa.DEFERRED)

    def test_all_exhausted_defers_with_reason_and_retry(self):
        c = Clock()
        ctl, ads = make(c, a={"5h": 0, "weekly": 0}, b={"5h": 0, "weekly": 0})
        ads["a"][0].reset["5h"] = NOW + timedelta(hours=2)
        d = ctl.admit("j1", cands("a", "b"))
        self.assertEqual(d.status, qa.DEFERRED)
        self.assertIn("exhausted", d.reason)
        self.assertGreater(d.retry_at, NOW)
        self.assertEqual(ctl.next_retry(), d.retry_at)

    def test_reserve_blocks_beyond_effective_capacity(self):
        c = Clock()
        ctl, _ = make(c, a={"5h": 3, "weekly": 100}, reserve={"5h": 1})
        got = [ctl.admit(f"j{i}", cands("a", cost=1)).status for i in range(4)]
        self.assertEqual(got, [qa.ADMITTED, qa.ADMITTED, qa.DEFERRED, qa.DEFERRED])

    def test_concurrent_admission_never_overcommits_or_duplicates(self):
        c = Clock()
        ctl, _ = make(c, a={"5h": 5, "weekly": 100}, b={"5h": 0, "weekly": 0})
        results = []
        barrier = threading.Barrier(20)

        def worker(i):
            barrier.wait()
            results.append(ctl.admit(f"job{i % 10}", cands("a")))  # 10 jobs, each raced twice

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(len(ctl.leases), 5)
        self.assertEqual(sum(l.cost["5h"] for l in ctl.leases.values()), 5)
        fresh = [r for r in results if r.status == qa.ADMITTED and not r.duplicate]
        self.assertEqual(len({r.job_id for r in fresh}), len(fresh))  # no job dispatched twice

    def test_duplicate_admit_is_idempotent(self):
        c = Clock()
        ctl, _ = make(c)
        self.assertFalse(ctl.admit("j", cands("a")).duplicate)
        self.assertTrue(ctl.admit("j", cands("a")).duplicate)
        self.assertEqual(len(ctl.leases), 1)

    def test_concurrency_limit(self):
        c = Clock()
        ctl, _ = make(c, concurrency={"a": 1})
        self.assertEqual(ctl.admit("j1", cands("a")).status, qa.ADMITTED)
        d = ctl.admit("j2", cands("a"))
        self.assertEqual(d.status, qa.DEFERRED)
        self.assertIn("concurrency", d.reason)
        ctl.complete("j1")
        c.advance(hours=1)
        self.assertEqual([x.job_id for x in ctl.reevaluate()], ["j2"])

    def test_crash_lease_expires_and_releases_capacity(self):
        c = Clock()
        ctl, _ = make(c, a={"5h": 1, "weekly": 100}, lease_seconds=60)
        ctl.admit("j1", cands("a"))
        self.assertEqual(ctl.admit("j2", cands("a")).status, qa.DEFERRED)
        c.advance(seconds=61)  # worker j1 died silently
        self.assertEqual(ctl.expire(), ["j1"])
        self.assertEqual([x.job_id for x in ctl.reevaluate(force=True)], ["j2"])

    def test_heartbeat_extends_lease_and_release_frees(self):
        c = Clock()
        ctl, _ = make(c, lease_seconds=60)
        ctl.admit("j1", cands("a"))
        c.advance(seconds=50)
        self.assertTrue(ctl.heartbeat("j1"))
        c.advance(seconds=50)
        self.assertEqual(ctl.expire(), [])
        self.assertTrue(ctl.release("j1"))
        self.assertFalse(ctl.release("j1"))

    def test_rate_limit_sets_bounded_cooldown_with_jitter(self):
        c = Clock()
        ctl, _ = make(c, base_backoff=10, max_backoff=100, jitter=0.2)
        ctl.admit("j1", cands("a"))
        until = ctl.report_rate_limit("j1", "a", "5h", retry_after=50)
        secs = (until - NOW).total_seconds()
        self.assertTrue(50 <= secs <= 60, secs)
        self.assertNotIn("j1", ctl.leases)
        self.assertEqual(ctl.admit("j2", cands("a")).status, qa.DEFERRED)
        for _ in range(10):  # repeated failures never exceed the cap
            until = ctl.report_rate_limit("jx", "a", "5h", retry_after=10_000)
        self.assertLessEqual((until - NOW).total_seconds(), 100)

    def test_rate_limit_falls_back_then_resumes_after_cooldown(self):
        c = Clock()
        ctl, _ = make(c)
        ctl.report_rate_limit("old", "a", "5h", retry_after=300)
        self.assertEqual(ctl.admit("j1", cands("a", "b")).provider, "b")
        d = ctl.admit("j2", cands("a"))
        self.assertEqual(d.status, qa.DEFERRED)
        c.advance(seconds=3600)
        self.assertEqual(ctl.admit("j2", cands("a")).provider, "a")

    def test_retry_storm_guard_backoff_grows_and_skips_early_reevaluation(self):
        c = Clock()
        ctl, _ = make(c, a={"5h": 0, "weekly": 0}, base_backoff=10, max_backoff=80, jitter=0)
        waits = []
        for _ in range(6):
            d = ctl.admit("j", cands("a"))
            waits.append((d.retry_at - c.now).total_seconds())
        self.assertEqual(waits, [10, 20, 40, 80, 80, 80])
        self.assertEqual(ctl.reevaluate(), [])  # inside backoff: not even tried
        self.assertEqual(ctl.deferred["j"].attempts, 6)

    def test_reset_readmits_deferred_automatically(self):
        c = Clock()
        ctl, ads = make(c, a={"5h": 0, "weekly": 100})
        self.assertEqual(ctl.admit("j", cands("a")).status, qa.DEFERRED)
        ads["a"][0].remaining["5h"] = 10  # window reset / telemetry refresh
        self.assertEqual([d.provider for d in ctl.reevaluate(force=True)], ["a"])
        self.assertEqual(ctl.deferred, {})

    def test_aging_prevents_starvation(self):
        c = Clock()
        ctl, ads = make(c, a={"5h": 0, "weekly": 100}, aging_per_hour=2.0, base_backoff=1, jitter=0)
        ctl.admit("old", cands("a"), priority=0)
        c.advance(hours=10)
        ctl.admit("new", cands("a"), priority=5)  # higher base priority, but old has aged to 20
        ads["a"][0].remaining["5h"] = 1  # only one slot
        self.assertEqual([d.job_id for d in ctl.reevaluate(force=True)], ["old"])

    def test_unknown_capacity_modes(self):
        c = Clock()
        cons, _ = make(c, a={}, unknown_mode=qa.CONSERVATIVE)
        d = cons.admit("j", cands("a"))
        self.assertEqual(d.status, qa.DEFERRED)
        self.assertIn("unknown", d.reason)
        opt, _ = make(c, a={}, unknown_mode=qa.OPTIMISTIC, optimistic_unknown_limit=1)
        self.assertEqual(opt.admit("j1", cands("a")).status, qa.ADMITTED)
        self.assertEqual(opt.admit("j2", cands("a")).status, qa.DEFERRED)  # probe limit
        with self.assertRaises(ValueError):
            make(c, unknown_mode="bogus")

    def test_adapter_failure_counts_as_unknown_not_crash(self):
        c = Clock()

        class Bad(ct.CapacityAdapter):
            provider = "a"

            def snapshot(self, window, now=None):
                raise RuntimeError("boom")

        ctl = qa.AdmissionController({"a": [Bad()]}, clock=c)
        self.assertEqual(ctl.admit("j", cands("a")).status, qa.DEFERRED)

    def test_real_observed_tracker_blocks_admission(self):
        c = Clock()
        tracker = ct.ObservedCooldownTracker("a")
        tracker.record_rate_limit("5h", 600, NOW)
        ctl = qa.AdmissionController({"a": [Fixed("a", c, **{"5h": 10, "weekly": 10}), tracker]}, clock=c)
        d = ctl.admit("j", cands("a"))
        self.assertEqual(d.status, qa.DEFERRED)
        self.assertIn("rate limited", d.reason)
        c.advance(seconds=700)
        self.assertEqual(ctl.admit("j", cands("a")).status, qa.ADMITTED)


if __name__ == "__main__":
    unittest.main()
