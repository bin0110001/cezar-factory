import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("scenario_orchestrator", ROOT / "scripts" / "scenario" / "scenario_orchestrator.py")
so = importlib.util.module_from_spec(SPEC)
sys.modules["scenario_orchestrator"] = so
SPEC.loader.exec_module(so)


def manifest(**over):
    m = {"schemaVersion": 1, "name": "echo", "roles": [
        {"name": "server", "capabilities": ["net"]},
        {"name": "client", "count": 2, "capabilities": ["net", "display"]}],
        "topology": {"hostPolicy": "distinct-physical"}, "network": {"zone": "lab"},
        "barriers": [{"name": "up", "roles": ["server", "client"]}]}
    m.update(over)
    return m


def workers(n=3, online=True):
    caps = [frozenset({"net"})] + [frozenset({"net", "display"})] * 2
    return [so.Worker(f"w{i}", f"host{i}", caps[i] if i < 3 else frozenset({"net"}), "lab", online) for i in range(n)]


class Echo(so.Adapter):
    """Non-Godot fixture: a plain network echo with logs per role."""
    def __init__(self, **faults):
        self.faults, self.log = faults, []
    def provision(self, inst, topology):
        self.log.append(("provision", inst.key))
        f = self.faults.get("provision")
        return so.Fault(f, inst.key) if f and inst.role == "client" and inst.index == 1 else None
    def execute(self, inst, ctx):
        self.log.append(("execute", inst.key))
        if self.faults.get("crash") == inst.role:
            raise RuntimeError("boom")
        return {"checkpoints": ["up"], "assertions": [{"name": "echo", "ok": True}], "artifacts": [f"{inst.key}.png"]}
    def collect(self, inst): return {"logs": [f"{inst.key}.log"]}
    def teardown(self, inst): self.log.append(("teardown", inst.key))


class ScenarioTests(unittest.TestCase):
    def test_manifest_validation(self):
        self.assertEqual(so.validate_manifest(manifest()), [])
        bad = manifest(schemaVersion=2, barriers=[{"name": "x", "roles": ["ghost"]}])
        self.assertEqual(len(so.validate_manifest(bad)), 2)

    def test_ids_deterministic(self):
        self.assertEqual(so.scenario_id(manifest()), so.scenario_id(manifest()))
        self.assertNotEqual(so.attempt_id(manifest(), 1), so.attempt_id(manifest(), 2))

    def test_three_workers_one_result_per_role_logs(self):
        store = so.LeaseStore()
        r = so.Coordinator(store, Echo()).run(manifest(), workers())
        self.assertEqual(r.outcome, "passed")
        self.assertEqual(r.states, list(so.STATES))
        self.assertEqual(len({v["host"] for v in r.roles.values()}), 3)
        self.assertTrue(all(v["logs"] for v in r.roles.values()))
        self.assertEqual((r.orphan_leases, store.held(0)), (0, {}))

    def test_missing_worker_is_unschedulable_never_pass(self):
        ad = Echo()
        r = so.Coordinator(so.LeaseStore(), ad).run(manifest(), workers(2))
        self.assertEqual(r.outcome, "unschedulable")
        self.assertEqual(ad.log, [])

    def test_offline_worker_unschedulable(self):
        w = workers(); w[2] = so.Worker("w2", "host2", w[2].capabilities, "lab", False)
        self.assertEqual(so.Coordinator(so.LeaseStore(), Echo()).run(manifest(), w).outcome, "unschedulable")

    def test_distinct_host_never_downgrades_but_same_host_when_permitted(self):
        same = [so.Worker(f"w{i}", "one", frozenset({"net", "display"}), "lab") for i in range(3)]
        self.assertEqual(so.Coordinator(so.LeaseStore(), Echo()).run(manifest(), same).outcome, "unschedulable")
        ok = manifest(topology={"hostPolicy": "same-host-allowed"})
        self.assertEqual(so.Coordinator(so.LeaseStore(), Echo()).run(ok, same).outcome, "passed")

    def test_graphical_role_needs_display_control(self):
        m = manifest(roles=[{"name": "server", "capabilities": ["net"]},
                            {"name": "client", "graphicalSession": {"required": True, "controls": ["display", "gpu"]}}])
        w = [so.Worker("a", "h1", frozenset({"net"}), "lab"), so.Worker("b", "h2", frozenset({"display"}), "lab")]
        self.assertEqual(so.Coordinator(so.LeaseStore(), Echo()).run(m, w).outcome, "unschedulable")

    def test_wrong_zone_unschedulable(self):
        w = [so.Worker(x.id, x.host, x.capabilities, "other") for x in workers()]
        self.assertEqual(so.Coordinator(so.LeaseStore(), Echo()).run(manifest(), w).outcome, "unschedulable")

    def test_all_or_none_reservation(self):
        store = so.LeaseStore()
        self.assertIsNotNone(store.acquire_all("a", ["w1"], 0, 100))
        self.assertIsNone(store.acquire_all("b", ["w0", "w1"], 1, 100))
        self.assertNotIn("w0", store.held(1))           # no partial claim left behind
        self.assertIsNotNone(store.acquire_all("b", ["w0", "w1"], 101, 100))   # TTL expiry frees it

    def test_busy_workers_leave_scenario_queued(self):
        store = so.LeaseStore()
        store.acquire_all("other", ["w1"], 0, 100)
        r = so.Coordinator(store, Echo()).run(manifest(), workers())
        self.assertEqual(r.outcome, "unschedulable")

    def test_role_crash_tears_down_everything_and_keeps_logs(self):
        ad, store = Echo(crash="server"), so.LeaseStore()
        r = so.Coordinator(store, ad).run(manifest(), workers())
        self.assertEqual(r.outcome, "failed")
        self.assertEqual({k for k, v in ad.log if k == "teardown"}, {"teardown"})
        self.assertEqual(sum(1 for k, _ in ad.log if k == "teardown"), 3)
        self.assertTrue(all(v["logs"] for v in r.roles.values()))
        self.assertEqual((r.orphan_leases, store.held(0)), (0, {}))

    def test_partial_provision_cancels_started_roles_without_downgrade(self):
        ad = Echo(provision="display_failed")
        r = so.Coordinator(so.LeaseStore(), ad).run(manifest(), workers())
        self.assertEqual(r.outcome, "infra")
        self.assertEqual(sum(1 for k, _ in ad.log if k == "teardown"), 3)
        self.assertFalse(any(k == "execute" for k, _ in ad.log))

    def test_retry_only_when_safe_and_infra(self):
        ad = Echo(provision="port_conflict")
        r = so.Coordinator(so.LeaseStore(), ad).run(manifest(), workers())
        self.assertEqual(r.attempts, 1)
        safe = manifest(retry={"safe": True, "maxAttempts": 3})
        r = so.Coordinator(so.LeaseStore(), Echo(provision="port_conflict")).run(safe, workers())
        self.assertEqual((r.attempts, r.outcome), (3, "infra"))
        r = so.Coordinator(so.LeaseStore(), Echo(crash="server")).run(safe, workers())
        self.assertEqual(r.attempts, 1)             # a real failure is never retried

    def test_missed_barrier_fails(self):
        class NoBarrier(Echo):
            def execute(self, inst, ctx):
                r = super().execute(inst, ctx)
                if inst.role == "client" and inst.index == 0:
                    r["checkpoints"] = []
                return r
        r = so.Coordinator(so.LeaseStore(), NoBarrier()).run(manifest(), workers())
        self.assertNotEqual(r.outcome, "passed")

    def test_failed_assertion_fails(self):
        class Bad(Echo):
            def execute(self, inst, ctx):
                r = super().execute(inst, ctx)
                r["assertions"] = [{"name": "sync", "ok": False}]
                return r
        self.assertEqual(so.Coordinator(so.LeaseStore(), Bad()).run(manifest(), workers()).outcome, "failed")

    def test_cancellation_cleans_up(self):
        store = so.LeaseStore()
        r = so.Coordinator(store, Echo(), cancelled=lambda: True).run(manifest(), workers())
        self.assertEqual(r.outcome, "cancelled")
        self.assertEqual(store.held(0), {})

    def test_stale_fence_result_rejected(self):
        class Stale(Echo):
            def execute(self, inst, ctx):
                r = super().execute(inst, ctx); r["fence"] = -1; return r
        r = so.Coordinator(so.LeaseStore(), Stale()).run(manifest(), workers())
        self.assertEqual(r.faults[0]["kind"], "stale_fence")

    def test_expired_lease_mid_run_is_stale(self):
        t = [0.0]
        class Slow(Echo):
            def provision(self, inst, topology):
                t[0] = 10_000; return None
        r = so.Coordinator(so.LeaseStore(), Slow(), clock=lambda: t[0]).run(manifest(), workers())
        self.assertEqual(r.faults[0]["kind"], "stale_fence")

    def test_replayed_conflicting_result_rejected(self):
        c = so.Coordinator(so.LeaseStore(), Echo())
        r = c.run(manifest(), workers())
        self.assertEqual(r.outcome, "passed")
        class Diff(Echo):
            def execute(self, inst, ctx):
                r = super().execute(inst, ctx); r["artifacts"] = ["other"]; return r
        c.adapter = Diff()
        r2 = c.run(manifest(), workers())      # same attempt id -> replay with different content
        self.assertEqual(r2.faults[0]["kind"], "replayed_result")

    def test_invalid_manifest_never_runs(self):
        r = so.Coordinator(so.LeaseStore(), Echo()).run({"name": "x"}, workers())
        self.assertEqual(r.outcome, "failed")


if __name__ == "__main__":
    unittest.main()
