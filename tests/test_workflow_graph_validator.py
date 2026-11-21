import copy
import json
import pathlib
import re
import tempfile
import unittest

from scripts.release import workflow_graph_validator as wg

FX = pathlib.Path(__file__).parent / "fixtures" / "workflow-graph"


def load(name):
    return json.loads((FX / f"{name}.json").read_text(encoding="utf-8"))


def codes(report, severity="error"):
    return {d["code"] for d in report["diagnostics"] if d["severity"] == severity}


class Negative(unittest.TestCase):
    def check(self, name, code, children=None):
        r = wg.validate(load(name), children)
        self.assertFalse(r["valid"], name)
        self.assertTrue(r["blocking"])
        self.assertIn(code, codes(r), r)
        for d in r["diagnostics"]:
            for key in ("code", "severity", "nodes", "witness", "suggestion", "message", "certainty"):
                self.assertIn(key, d)
        return r

    def test_unreachable_terminal(self):
        r = self.check("invalid-unreachable-terminal", "WG004")
        self.assertIn("orphan", [n for d in r["diagnostics"] for n in d["nodes"]])

    def test_missing_outcome(self):
        r = self.check("invalid-missing-outcome", "WG006")
        self.assertEqual(r["diagnostics"][0]["witness"], ["a:failure"])

    def test_unbounded_review_repair_cycle(self):
        r = self.check("invalid-unbounded-cycle", "WG009")
        self.assertEqual(r["diagnostics"][0]["nodes"], ["repair", "review"])

    def test_self_loop(self):
        self.check("invalid-self-loop", "WG008")

    def test_missing_child(self):
        self.check("invalid-missing-child", "WG003")

    def test_privilege_bypass(self):
        r = self.check("invalid-privilege-bypass", "WG021")
        self.assertIn("WG016", codes(r))
        self.assertEqual([d for d in r["diagnostics"] if d["code"] == "WG021"][0]["witness"], ["a", "merge"])


class Positive(unittest.TestCase):
    def test_bounded_loop_and_human_wait(self):
        for name in ("valid-bounded-loop", "valid-human-wait"):
            r = wg.validate(load(name))
            self.assertTrue(r["valid"], r)
            self.assertFalse(r["blocking"])

    def test_escrow_bound_and_exit_required(self):
        d = load("invalid-unbounded-cycle")
        for e in d["edges"]:
            if e["from"] == "repair" and e["to"] == "review":
                e["bound"] = "escrow"
        self.assertTrue(wg.validate(d)["valid"])


class Guards(unittest.TestCase):
    def test_unknown_guard_is_not_proven(self):
        d = load("valid-bounded-loop")
        d["edges"][0]["guard"] = {"kind": "predicate", "expr": "pr.checks == 'green'"}
        r = wg.validate(d)
        self.assertTrue(r["valid"])
        unk = [x for x in r["diagnostics"] if x["code"] == "WG012"]
        self.assertEqual(len(unk), 1)
        self.assertEqual(unk[0]["certainty"], "unknown")
        self.assertEqual(r["counts"]["unknown"], 1)

    def test_never_guard_is_unsatisfiable_and_not_reachable(self):
        d = load("valid-bounded-loop")
        d["edges"][3]["guard"] = "never"  # review->repair:changes
        r = wg.validate(d)
        self.assertIn("WG011", codes(r, "warning"))
        self.assertIn("WG006", codes(r))  # outcome 'changes' now has no live edge

    def test_trap(self):
        d = {"name": "t", "entry": "a", "budget": {"maxIterations": 3},
             "nodes": [{"id": "a", "outcomes": ["x"]}, {"id": "b", "outcomes": ["x"]}, {"id": "end", "kind": "terminal", "result": "success"}],
             "edges": [{"from": "a", "to": "b", "outcome": "x", "bound": {"max": 1}}, {"from": "b", "to": "a", "outcome": "x", "bound": {"max": 1}}]}
        r = wg.validate(d)
        self.assertIn("WG010", codes(r))
        self.assertIn("WG005", codes(r))


class Contracts(unittest.TestCase):
    def test_fork_join_deadlock(self):
        d = {"name": "f", "entry": "fork", "budget": {"maxIterations": 3},
             "nodes": [{"id": "fork", "kind": "fork"}, {"id": "a"}, {"id": "b"},
                       {"id": "join", "kind": "join", "joinsFrom": "fork", "expects": 3},
                       {"id": "ok", "kind": "terminal", "result": "success"}, {"id": "bad", "kind": "terminal", "result": "failure"}],
             "edges": [{"from": "fork", "to": "a", "outcome": "branch"}, {"from": "fork", "to": "b", "outcome": "branch"},
                       {"from": "a", "to": "join", "outcome": "success"}, {"from": "a", "to": "bad", "outcome": "failure"},
                       {"from": "b", "to": "ok", "outcome": "success"}, {"from": "b", "to": "bad", "outcome": "failure"},
                       {"from": "join", "to": "ok", "outcome": "success"}, {"from": "join", "to": "bad", "outcome": "failure"}]}
        msgs = [x["message"] for x in wg.validate(d)["diagnostics"] if x["code"] == "WG013"]
        self.assertTrue(any("cannot reach join" in m for m in msgs), msgs)
        self.assertTrue(any("expects 3" in m for m in msgs), msgs)

    def test_event_consumer_without_producer(self):
        d = load("valid-human-wait")
        d["nodes"][0]["waitsFor"] = "pr.merged"
        self.assertIn("WG014", codes(wg.validate(d)))
        d["nodes"][0]["external"] = True
        self.assertNotIn("WG014", codes(wg.validate(d)))

    def test_human_gate_requires_authorized_roles(self):
        d = load("valid-human-wait")
        d["nodes"][1]["humanGate"] = {"authorizedRoles": []}
        self.assertIn("WG015", codes(wg.validate(d)))

    def test_child_budget_and_permissions(self):
        child = {"name": "kid", "entry": "w", "nodes": [{"id": "w", "permissions": ["deploy"]}, {"id": "e", "kind": "terminal", "result": "success"}, {"id": "f", "kind": "terminal", "result": "failure"}],
                 "edges": [{"from": "w", "to": "e", "outcome": "success"}, {"from": "w", "to": "f", "outcome": "failure"}]}
        parent = {"name": "p", "entry": "c", "budget": {"maxCost": 5}, "permissions": {"ceiling": ["read"]},
                  "nodes": [{"id": "c", "kind": "child", "ref": "kid", "budget": {"maxCost": 9}}, {"id": "ok", "kind": "terminal", "result": "success"}, {"id": "no", "kind": "terminal", "result": "failure"}],
                  "edges": [{"from": "c", "to": "ok", "outcome": "success"}, {"from": "c", "to": "no", "outcome": "failure"}]}
        r = wg.validate(parent, {"kid": child})
        msgs = " ".join(x["message"] for x in r["diagnostics"])
        self.assertIn("exceeds the parent", msgs)
        self.assertIn("beyond what the parent grants", msgs)
        parent["nodes"][0] = {"id": "c", "kind": "child", "ref": "kid", "budget": {"maxCost": 2}, "permissions": ["read", "deploy"]}
        parent["permissions"]["ceiling"] = ["read", "deploy"]
        self.assertTrue(wg.validate(parent, {"kid": child})["valid"])
        parent["nodes"][0] = {"id": "c", "kind": "child", "ref": "kid"}
        self.assertIn("WG017", codes(wg.validate(parent, {"kid": child})))

    def test_child_recursion(self):
        a = {"name": "a", "entry": "c", "budget": {"maxCost": 1}, "nodes": [{"id": "c", "kind": "child", "ref": "a", "inherit": True}, {"id": "e", "kind": "terminal", "result": "success"}],
             "edges": [{"from": "c", "to": "e", "outcome": "success"}]}
        self.assertIn("WG018", codes(wg.validate(a, {"a": a})))

    def test_child_unhandled_outcome(self):
        child = {"name": "kid", "entry": "e", "nodes": [{"id": "e", "kind": "terminal", "result": "needs-human-input"}], "edges": []}
        parent = {"name": "p", "entry": "c", "budget": {"maxCost": 5},
                  "nodes": [{"id": "c", "kind": "child", "ref": "kid", "inherit": True}, {"id": "ok", "kind": "terminal", "result": "success"}],
                  "edges": [{"from": "c", "to": "ok", "outcome": "success"}]}
        r = wg.validate(parent, {"kid": child})
        self.assertIn("WG006", codes(r))

    def test_unsafe_implicit_success(self):
        d = load("valid-bounded-loop")
        d["edges"][0].pop("outcome")  # implement->review without outcome
        self.assertIn("WG007", codes(wg.validate(d)))

    def test_dangling_and_entry_and_terminal_edge(self):
        d = load("valid-bounded-loop")
        d["edges"].append({"from": "implement", "to": "ghost", "outcome": "success"})
        d["edges"].append({"from": "done", "to": "review"})
        d["entry"] = "nope"
        c = codes(wg.validate(d))
        self.assertTrue({"WG001", "WG002", "WG019"} <= c, c)


class Determinism(unittest.TestCase):
    def test_byte_identical_and_order_independent(self):
        d = load("invalid-privilege-bypass")
        e = copy.deepcopy(d)
        e["nodes"].reverse()
        e["edges"].reverse()
        a = wg.canonical_json(wg.validate(d))
        self.assertEqual(a, wg.canonical_json(wg.validate(d)))
        self.assertEqual(a, wg.canonical_json(wg.validate(e)))
        self.assertEqual(wg.render_text(wg.validate(d)), wg.render_text(wg.validate(e)))

    def test_report_matches_schema_keys(self):
        schema = json.loads((pathlib.Path(__file__).parents[1] / "schemas" / "workflow-diagnostics.schema.json").read_text())
        r = wg.validate(load("invalid-self-loop"))
        self.assertEqual(set(schema["required"]), set(r))
        self.assertEqual(set(schema["properties"]["diagnostics"]["items"]["required"]), set(r["diagnostics"][0]))


class Legacy(unittest.TestCase):
    YAML = ("name: demo\nsteps:\n  - id: a\n    name: A\n    command: x\n  - id: b\n    command: y\n    onFail:\n      retry: a\n      max: 1\n"
            "  - id: c\n    command: z\n    continueOnFailure: true\n")

    def test_legacy_yaml_valid_with_bounded_retry(self):
        d = wg.adapt_legacy_yaml(self.YAML)
        r = wg.validate(d, mode="report-only")
        self.assertTrue(r["valid"], r)
        self.assertTrue(any(e.get("bound") for e in d["edges"]))

    def test_legacy_unbounded_retry_reported_not_blocking(self):
        d = wg.adapt_legacy_yaml(self.YAML.replace("      max: 1\n", ""))
        r = wg.validate(d, mode="report-only")
        self.assertFalse(r["valid"])
        self.assertFalse(r["blocking"])

    def test_repository_workflows_report_only(self):
        reports = wg.validate_tree(pathlib.Path(__file__).parents[1])
        self.assertTrue(reports)
        self.assertTrue(all(not r["blocking"] for r in reports))
        self.assertIsNone(wg.blocking_message(reports))

    def test_tree_enforces_native_definitions(self):
        with tempfile.TemporaryDirectory() as t:
            w = pathlib.Path(t) / "workflows"
            w.mkdir()
            (w / "bad.workflow.json").write_text((FX / "invalid-self-loop.json").read_text())
            reports = wg.validate_tree(pathlib.Path(t))
            self.assertIn("invalid-self-loop", wg.blocking_message(reports))


class VersionedLifecycle(unittest.TestCase):
    ROOT = pathlib.Path(__file__).parents[1]

    def test_shared_lifecycle_definitions_pass_the_static_graph_validator(self):
        workflow_dir = self.ROOT / "workflows"
        files = sorted(workflow_dir.glob("lifecycle-*.workflow.json"))
        self.assertGreaterEqual(len(files), 8)
        for path in files:
            report = wg.validate(json.loads(path.read_text(encoding="utf-8")))
            self.assertTrue(report["valid"], f"{path.name}: {report}")

    def test_each_legacy_workflow_exit_maps_to_one_declared_typed_outcome(self):
        lifecycle = json.loads((self.ROOT / "policies" / "lifecycle.json").read_text(encoding="utf-8"))
        mappings = lifecycle["workflowOutcomeMappings"]
        source = (self.ROOT / "cezar" / "packages" / "contract" / "src" / "versioned-workflows.ts").read_text(encoding="utf-8")
        enum = re.search(r"workflowOutcomeSchema = z\.enum\(\[(.*?)\]\)", source, re.S)
        self.assertIsNotNone(enum)
        typed_outcomes = set(re.findall(r"'([a-z_]+)'", enum.group(1)))
        expected: dict[str, set[str]] = {}
        workflow_events = {"intake-result", "plan-result", "implement-result", "review-result", "investigate-result"}
        for profile in lifecycle["profiles"].values():
            for state in profile["states"].values():
                for exit_rule in state.get("exits", []):
                    if exit_rule.get("outcome") and exit_rule.get("on") in workflow_events:
                        expected.setdefault(exit_rule["on"], set()).add(exit_rule["outcome"])
        self.assertEqual(set(mappings), set(expected))
        self.assertEqual({event: set(mapping) for event, mapping in mappings.items()}, expected)
        for event, mapping in mappings.items():
            self.assertTrue(set(mapping.values()) <= typed_outcomes, event)
        stage_files = {
            "intake-result": "lifecycle-intake.workflow.json",
            "plan-result": "lifecycle-planning.workflow.json",
            "implement-result": "lifecycle-implementation.workflow.json",
            "review-result": "lifecycle-review.workflow.json",
            "investigate-result": "lifecycle-investigation.workflow.json",
        }
        for event, file_name in stage_files.items():
            workflow = json.loads((self.ROOT / "workflows" / file_name).read_text(encoding="utf-8"))
            declared = {outcome for node in workflow["nodes"] for outcome in node.get("outcomes", [])}
            self.assertTrue(set(mappings[event].values()) <= declared, f"{event}: {mappings[event]} not declared by {file_name}")


if __name__ == "__main__":
    unittest.main()
