"""Deterministic static workflow graph and policy validator (#764, parent #761).

Pure library plus a small CLI: no clock, network, randomness or LLM judgement. Output for identical input is
byte-identical (sorted traversal, sorted diagnostics, canonical JSON). This is the *workflow* graph; it is not the
issue dependency graph of #149 (only the Tarjan SCC algorithm is shared in spirit, re-implemented here so the two
graphs never share data or code paths). See docs/workflow-graph-validator.md.

Definition shape (v1 draft, isolated behind `adapt_definition` so the #763 schema can be consumed by changing one
function):
  {"schemaVersion": 1, "name": str, "entry": nodeId,
   "permissions": {"ceiling": [..], "privileged": [..]}, "budget": {"maxCost"|"maxIterations"|"maxWallSeconds": n},
   "nodes": [{"id", "kind": task|child|fork|join|wait|terminal, "outcomes": [..], "result": terminal result,
              "ref": child name, "permissions": [..], "budget": {..}, "inherit": bool,
              "humanGate": {"authorizedRoles": [..]}, "waitsFor": event, "emits": [event..], "external": bool,
              "joinsFrom": forkId, "expects": int}],
   "edges": [{"from", "to", "outcome", "guard": "always"|"never"|{"kind","expr"}|str, "bound": {"max": n}|"escrow"}]}
Legacy `workflows/*.yaml` (linear steps with onFail.retry) are adapted into the same graph and validated report-only.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from typing import Any

SCHEMA_VERSION = 1
SEVERITY_RANK = {"error": 0, "warning": 1, "info": 2}
TERMINAL_RESULTS = ("success", "failure", "needs-human-input", "cancelled")
FAILURE_OUTCOMES = {"failure", "error", "failed", "timeout"}
BUDGET_KEYS = ("maxCost", "maxIterations", "maxWallSeconds")
DEFAULT_OUTCOMES = {"task": ["success", "failure"], "wait": ["approved", "rejected"], "fork": ["branch"],
                    "join": ["success", "failure"], "child": []}

CODES = {
    "WG001": "entry node missing or unknown", "WG002": "dangling edge", "WG003": "missing child reference",
    "WG004": "unreachable node", "WG005": "no terminal reachable", "WG006": "missing outcome handler",
    "WG007": "unsafe implicit success", "WG008": "unbounded self loop", "WG009": "unbounded cycle",
    "WG010": "unconditional trap", "WG011": "unsatisfiable branch", "WG012": "undecidable guard (UNKNOWN)",
    "WG013": "fork/join deadlock hazard", "WG014": "event consumer without producer",
    "WG015": "human gate not authorized", "WG016": "privilege escalation", "WG017": "budget contract violation",
    "WG018": "child recursion", "WG019": "terminal has outgoing edge", "WG020": "unknown outcome on edge",
    "WG021": "privileged node bypasses human gate", "WG022": "malformed definition",
}


def _diag(code: str, severity: str, nodes: list[str], message: str, suggestion: str,
          witness: list[str] | None = None, certainty: str = "proven") -> dict[str, Any]:
    return {"code": code, "severity": severity, "certainty": certainty, "title": CODES[code],
            "nodes": sorted(set(nodes)), "witness": list(witness or []), "message": message, "suggestion": suggestion}


# ---------------------------------------------------------------------------------------------- adapters
def _legacy_steps(text: str) -> tuple[str, list[dict[str, Any]]]:
    """Extract name/steps(id, onFail.retry/max, continueOnFailure) from legacy workflow YAML without PyYAML."""
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text)
        steps = []
        for s in data.get("steps") or []:
            on = s.get("onFail") or {}
            steps.append({"id": str(s.get("id")), "retry": on.get("retry"), "max": on.get("max"),
                          "continue": bool(s.get("continueOnFailure"))})
        return str(data.get("name") or ""), steps
    except ImportError:
        pass
    name = ""
    steps: list[dict[str, Any]] = []
    in_onfail = False
    for line in text.splitlines():
        if not name and (m := re.match(r"^name:\s*(\S.*?)\s*$", line)):
            name = m.group(1).strip("'\"")
        if m := re.match(r"^  - id:\s*(\S+)\s*$", line):
            steps.append({"id": m.group(1).strip("'\""), "retry": None, "max": None, "continue": False})
            in_onfail = False
        elif steps:
            if re.match(r"^    onFail:\s*$", line):
                in_onfail = True
            elif in_onfail and (m := re.match(r"^      retry:\s*(\S+)\s*$", line)):
                steps[-1]["retry"] = m.group(1).strip("'\"")
            elif in_onfail and (m := re.match(r"^      max:\s*(\d+)\s*$", line)):
                steps[-1]["max"] = int(m.group(1))
            elif re.match(r"^    continueOnFailure:\s*true\s*$", line):
                steps[-1]["continue"] = True
            elif re.match(r"^    \S", line) and not line.startswith("      "):
                in_onfail = False
    return name, steps


def adapt_legacy_yaml(text: str, fallback_name: str = "legacy") -> dict[str, Any]:
    name, steps = _legacy_steps(text)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    ids = [s["id"] for s in steps]
    for i, s in enumerate(steps):
        nodes.append({"id": s["id"], "kind": "task", "outcomes": ["success", "failure"]})
        nxt = ids[i + 1] if i + 1 < len(ids) else "$success"
        edges.append({"from": s["id"], "to": nxt, "outcome": "success"})
        if s["retry"]:
            edges.append({"from": s["id"], "to": s["retry"], "outcome": "failure",
                          "bound": {"max": s["max"]} if s["max"] else None})
        elif s["continue"]:
            edges.append({"from": s["id"], "to": nxt, "outcome": "failure"})
        else:
            edges.append({"from": s["id"], "to": "$failed", "outcome": "failure"})
    nodes.append({"id": "$success", "kind": "terminal", "result": "success"})
    nodes.append({"id": "$failed", "kind": "terminal", "result": "failure"})
    for e in edges:
        if e.get("bound") is None:
            e.pop("bound", None)
    return {"schemaVersion": SCHEMA_VERSION, "name": name or fallback_name, "entry": ids[0] if ids else "",
            "nodes": nodes, "edges": edges, "legacy": True}


def adapt_definition(raw: Any) -> dict[str, Any]:
    """Single seam for the #763 schema: normalise a resolved definition into the internal graph model."""
    if not isinstance(raw, dict):
        raise ValueError("workflow definition must be an object")
    if raw.get("contract") == "cezar.workflow":
        source_nodes = raw.get("nodes")
        transitions = raw.get("transitions")
        terminals = raw.get("terminals")
        if not isinstance(source_nodes, list) or not isinstance(transitions, list) or not isinstance(terminals, list):
            raise ValueError("versioned workflow definition requires nodes, transitions and terminals arrays")
        terminal_ids = set(terminals)
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        retry_bounds: dict[str, dict[str, Any]] = {}
        for node in source_nodes:
            if not isinstance(node, dict) or not isinstance(node.get("id"), str):
                raise ValueError("versioned workflow node requires a string id")
            node_id = node["id"]
            outcomes = node.get("outcomes") or (["passed"] if node.get("kind") == "wait" else [])
            if node_id in terminal_ids:
                # The Cezar contract declares terminal-capable nodes; each declared result becomes
                # an explicit graph terminal so static reachability proves every typed exit.
                nodes.append({"id": node_id, "kind": "task", "outcomes": outcomes})
                for outcome in outcomes:
                    suffix = re.sub(r"[^A-Za-z0-9_.-]", "_", str(outcome))
                    result = ("success" if outcome in {"passed", "ready", "split", "not_reproducible"}
                              else "needs-human-input" if outcome in {"needs_input", "needs_research", "investigate"}
                              else "failure" if outcome in {"changes_required", "blocked", "skipped", "unknown", "interrupted", "exhausted"}
                              else "cancelled")
                    terminal_id = f"__terminal__{node_id}__{suffix}"
                    nodes.append({"id": terminal_id, "kind": "terminal", "result": result})
                    edges.append({"from": node_id, "outcome": outcome, "to": terminal_id})
            else:
                kind = "child" if node.get("kind") == "child_workflow" else "wait" if node.get("kind") == "wait" else "task"
                normalized = {"id": node_id, "kind": kind, "outcomes": outcomes}
                if kind == "child":
                    normalized["ref"] = f"{node.get('workflow')}@{node.get('version')}"
                if node.get("retry"):
                    retry_bounds[node_id] = {"max": node["retry"].get("maxAttempts", 1)}
                nodes.append(normalized)
        for transition in transitions:
            if not isinstance(transition, dict):
                raise ValueError("versioned workflow transition must be an object")
            edge = {"from": transition.get("from"), "outcome": transition.get("outcome"), "to": transition.get("to")}
            if transition.get("when") is not None:
                edge["guard"] = {"expr": "versioned-guard"}
            if transition.get("from") in retry_bounds and transition.get("outcome") in next(
                    (node.get("retry", {}).get("on", []) for node in source_nodes if isinstance(node, dict) and node.get("id") == transition.get("from")), []):
                edge["bound"] = retry_bounds[transition["from"]]
            edges.append(edge)
        return {"name": f"{raw.get('id', '')}@{raw.get('version', '')}", "entry": raw.get("entry"),
                "nodes": nodes, "edges": edges, "permissions": {}, "budget": raw.get("budget") or {}, "legacy": False}
    nodes = raw.get("nodes")
    edges = raw.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("workflow definition requires nodes and edges arrays")
    return {"name": str(raw.get("name") or ""), "entry": raw.get("entry"), "nodes": nodes, "edges": edges,
            "permissions": raw.get("permissions") or {}, "budget": raw.get("budget") or {},
            "legacy": bool(raw.get("legacy"))}


# ---------------------------------------------------------------------------------------------- graph
def _guard(edge: dict[str, Any]) -> tuple[str, str]:
    """Return (state, text): state is true|false|unknown. Only literal guards are decidable."""
    g = edge.get("guard")
    if g is None:
        return "true", ""
    expr = g.get("expr", g.get("kind")) if isinstance(g, dict) else g
    text = str(expr).strip().lower()
    if text in ("always", "true"):
        return "true", text
    if text in ("never", "false"):
        return "false", text
    return "unknown", str(expr)


def sccs(adj: dict[str, list[str]]) -> list[list[str]]:
    """Iterative Tarjan over sorted nodes; deterministic component order."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    onstack: set[str] = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = 0
    for root in sorted(adj):
        if root in index:
            continue
        work = [(root, iter(sorted(adj[root])))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        onstack.add(root)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in adj:
                    continue
                if w not in index:
                    index[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    onstack.add(w)
                    work.append((w, iter(sorted(adj[w]))))
                    advanced = True
                    break
                if w in onstack:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    onstack.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(sorted(comp))
    return sorted(out)


def _reach(start: list[str], adj: dict[str, list[str]], blocked: set[str] | None = None) -> dict[str, str | None]:
    """BFS reachability returning parent map (for witnesses)."""
    seen: dict[str, str | None] = {}
    queue = [s for s in sorted(start) if not blocked or s not in blocked]
    for s in queue:
        seen[s] = None
    while queue:
        v = queue.pop(0)
        for w in sorted(adj.get(v, [])):
            if w in seen or (blocked and w in blocked) or w not in adj:
                continue
            seen[w] = v
            queue.append(w)
    return seen


def _path(parents: dict[str, str | None], end: str) -> list[str]:
    p = [end]
    while parents.get(p[-1]) is not None:
        p.append(parents[p[-1]])  # type: ignore[arg-type]
    return list(reversed(p))


def _edge_label(e: dict[str, Any]) -> str:
    return f"{e['from']}->{e['to']}" + (f":{e['outcome']}" if e.get("outcome") else "")


def _bounded(e: dict[str, Any]) -> bool:
    b = e.get("bound")
    if b == "escrow" or (isinstance(b, dict) and b.get("escrow")):
        return True
    return isinstance(b, dict) and isinstance(b.get("max"), int) and not isinstance(b.get("max"), bool) and b["max"] >= 1


def validate_definition(raw: Any, children: dict[str, Any] | None = None, _stack: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    """Return the unsorted diagnostics for one resolved definition (children resolved via `children`)."""
    children = children or {}
    try:
        wf = adapt_definition(raw)
    except ValueError as exc:
        return [_diag("WG022", "error", [], str(exc), "Provide nodes and edges arrays in the workflow definition.")]
    d: list[dict[str, Any]] = []
    nodes: dict[str, dict[str, Any]] = {}
    for n in wf["nodes"]:
        if not isinstance(n, dict) or not isinstance(n.get("id"), str):
            d.append(_diag("WG022", "error", [], "node without a string id", "Give every node a unique string id."))
            continue
        if n["id"] in nodes:
            d.append(_diag("WG022", "error", [n["id"]], f"duplicate node id {n['id']}", "Node ids must be unique."))
        nodes[n["id"]] = n
    edges = [e for e in wf["edges"] if isinstance(e, dict)]
    entry = wf["entry"]
    name = wf["name"] or "<unnamed>"

    if not isinstance(entry, str) or entry not in nodes:
        d.append(_diag("WG001", "error", [str(entry)] if entry else [], f"{name}: entry {entry!r} is not a node",
                       "Set `entry` to an existing node id."))

    # child resolution and outcomes
    node_outcomes: dict[str, list[str]] = {}
    child_defs: dict[str, dict[str, Any]] = {}
    for nid, n in sorted(nodes.items()):
        kind = n.get("kind", "task")
        outs = n.get("outcomes")
        if kind == "terminal":
            res = n.get("result")
            if res not in TERMINAL_RESULTS:
                d.append(_diag("WG022", "error", [nid], f"terminal {nid} has invalid result {res!r}",
                               f"Use one of {', '.join(TERMINAL_RESULTS)}."))
            node_outcomes[nid] = []
            continue
        if kind == "child":
            ref = n.get("ref")
            cdef = children.get(ref) if isinstance(ref, str) else None
            if cdef is None:
                d.append(_diag("WG003", "error", [nid], f"child node {nid} references unknown workflow {ref!r}",
                               "Define the child workflow or fix the `ref` name."))
                node_outcomes[nid] = list(outs or [])
                continue
            if ref in _stack or ref == wf["name"]:
                d.append(_diag("WG018", "error", [nid], f"child {ref!r} recursively contains itself",
                               "Break the recursive child reference; child workflows must form a DAG.",
                               witness=list(_stack) + [str(ref)]))
                node_outcomes[nid] = list(outs or [])
                continue
            child_defs[nid] = cdef
            child_graph = adapt_definition(cdef)
            results = sorted({x.get("result") for x in child_graph["nodes"] if isinstance(x, dict) and x.get("kind") == "terminal" and x.get("result")})
            node_outcomes[nid] = sorted(set(results) | set(outs or []))
            for cd in validate_definition(cdef, children, _stack + (wf["name"],)):
                if cd["severity"] == "error":
                    d.append(_diag("WG003", "error", [nid], f"child {ref!r} of {nid} is itself invalid: {cd['code']} {cd['message']}",
                                   "Fix the child workflow first.", witness=[f"{ref}:{cd['code']}"]))
            continue
        node_outcomes[nid] = list(outs) if isinstance(outs, list) and outs else list(DEFAULT_OUTCOMES.get(kind, ["success", "failure"]))

    # edges
    valid_edges: list[dict[str, Any]] = []
    for e in sorted(edges, key=lambda x: (str(x.get("from")), str(x.get("to")), str(x.get("outcome")))):
        src, dst = e.get("from"), e.get("to")
        if src not in nodes or dst not in nodes:
            d.append(_diag("WG002", "error", [str(x) for x in (src, dst) if x in nodes],
                           f"edge {src}->{dst} references an unknown node", "Remove the edge or define the missing node.",
                           witness=[f"{src}->{dst}"]))
            continue
        valid_edges.append(e)
        if nodes[src].get("kind") == "terminal":
            d.append(_diag("WG019", "error", [src], f"terminal {src} has an outgoing edge to {dst}",
                           "Terminals must end the workflow; remove the edge.", witness=[_edge_label(e)]))
            continue
        outs = node_outcomes[src]
        oc = e.get("outcome")
        if oc is None:
            if len(outs) > 1 or any(o in FAILURE_OUTCOMES for o in outs):
                d.append(_diag("WG007", "error", [src, dst], f"edge {src}->{dst} has no outcome but {src} can end in {sorted(outs)}",
                               "Label the edge with an explicit outcome so failure never flows as success.", witness=[_edge_label(e)]))
        elif oc not in outs and not (nodes[src].get("kind") == "child" and src not in child_defs):
            d.append(_diag("WG020", "error", [src], f"edge {_edge_label(e)} uses outcome {oc!r} not declared by {src} ({sorted(outs)})",
                           "Declare the outcome on the node or fix the edge label.", witness=[_edge_label(e)]))
        state, text = _guard(e)
        if state == "false":
            d.append(_diag("WG011", "warning", [src, dst], f"edge {_edge_label(e)} has a definitely unsatisfiable guard",
                           "Remove the dead branch or fix its guard.", witness=[_edge_label(e)]))
        elif state == "unknown":
            d.append(_diag("WG012", "info", [src, dst], f"guard {text!r} on {_edge_label(e)} is undecidable statically",
                           "Treated as possibly true; not proven. Add a bound or a guard-free exit to make termination provable.",
                           witness=[_edge_label(e)], certainty="unknown"))

    live = [e for e in valid_edges if nodes[e["from"]].get("kind") != "terminal" and _guard(e)[0] != "false"]
    adj: dict[str, list[str]] = {n: [] for n in nodes}
    for e in live:
        adj[e["from"]].append(e["to"])

    # missing outcomes
    for nid in sorted(nodes):
        if nodes[nid].get("kind") == "terminal":
            continue
        handled = {e.get("outcome") for e in live if e["from"] == nid}
        for oc in sorted(node_outcomes[nid]):
            if oc not in handled and None not in handled:
                d.append(_diag("WG006", "error", [nid], f"node {nid} does not handle outcome {oc!r}",
                               f"Add an edge from {nid} for outcome {oc!r} (to a repair node or a terminal).", witness=[f"{nid}:{oc}"]))
        if not node_outcomes[nid] and not any(e["from"] == nid for e in live):
            d.append(_diag("WG006", "error", [nid], f"node {nid} has no outgoing edge", "Add an outgoing edge or make it a terminal."))

    # reachability
    reach = _reach([entry], adj) if isinstance(entry, str) and entry in nodes else {}
    terminals = sorted(n for n, x in nodes.items() if x.get("kind") == "terminal")
    for nid in sorted(nodes):
        if nid not in reach and isinstance(entry, str) and entry in nodes:
            d.append(_diag("WG004", "error", [nid], f"node {nid} is unreachable from entry {entry}",
                           "Connect it from a reachable node or remove it."))
    if isinstance(entry, str) and entry in nodes and not any(t in reach for t in terminals):
        d.append(_diag("WG005", "error", terminals or [entry], f"{name}: no terminal is reachable from entry {entry}",
                       "Add a path from the entry to at least one terminal.", witness=[f"{entry}->(no terminal)"]))

    # SCC / loops
    for comp in sccs(adj):
        cset = set(comp)
        internal = [e for e in live if e["from"] in cset and e["to"] in cset]
        if len(comp) == 1 and not any(e["from"] == e["to"] for e in internal):
            continue
        if comp[0] not in reach and isinstance(entry, str):
            continue
        exits = [e for e in live if e["from"] in cset and e["to"] not in cset]
        has_terminal = any(nodes[n].get("kind") == "terminal" for n in comp)
        if not exits and not has_terminal:
            d.append(_diag("WG010", "error", comp, f"nodes {comp} form a trap: no edge leaves the cycle",
                           "Add an exit edge (e.g. to a needs-human-input terminal) from one of the nodes.",
                           witness=[_edge_label(e) for e in internal]))
        unbounded = [e for e in internal if not _bounded(e)]
        sub: dict[str, list[str]] = {n: [] for n in comp}
        for e in unbounded:
            sub[e["from"]].append(e["to"])
        for sc in sccs(sub):
            if len(sc) == 1 and sc[0] not in sub[sc[0]]:
                continue
            w = [_edge_label(e) for e in unbounded if e["from"] in sc and e["to"] in sc]
            if len(sc) == 1:
                d.append(_diag("WG008", "error", sc, f"self loop on {sc[0]} has no bound", "Add `bound: {max: N}` to the loop edge or remove it.", witness=w))
            else:
                d.append(_diag("WG009", "error", sc, f"cycle over {sc} has no bounded edge",
                               "Put `bound: {max: N}` (or `escrow`) on one edge of the review/repair cycle and keep an exit edge.", witness=w))

    # fork / join
    fan_in: dict[str, list[str]] = {}
    for e in live:
        fan_in.setdefault(e["to"], []).append(e["from"])
    for nid, n in sorted(nodes.items()):
        if n.get("kind") == "fork":
            branches = sorted(e["to"] for e in live if e["from"] == nid)
            if len(branches) < 2:
                d.append(_diag("WG013", "warning", [nid], f"fork {nid} has fewer than two branches", "Use a plain edge or add branches."))
            joins = sorted(j for j, x in nodes.items() if x.get("kind") == "join" and x.get("joinsFrom") == nid)
            if not joins:
                d.append(_diag("WG013", "error", [nid], f"fork {nid} has no join; branches can finish out of order or leak",
                               "Add a join node with `joinsFrom` set to this fork."))
            for j in joins:
                mode = nodes[j].get("mode", "all")
                for b in branches:
                    if j not in _reach([b], adj, blocked=None):
                        d.append(_diag("WG013", "error", [nid, j, b], f"branch {b} of fork {nid} cannot reach join {j}; join waits forever",
                                       "Route every branch to the join or set mode `any`.", witness=[f"{nid}->{b}", f"{j}:waits"]))
                exp = nodes[j].get("expects")
                inbound = len(set(fan_in.get(j, [])))
                if isinstance(exp, int) and exp > inbound and mode == "all":
                    d.append(_diag("WG013", "error", [j], f"join {j} expects {exp} inputs but only {inbound} edges arrive",
                                   "Lower `expects` or add the missing inbound edges."))
        if n.get("kind") == "join" and not n.get("joinsFrom"):
            d.append(_diag("WG013", "warning", [nid], f"join {nid} names no fork", "Set `joinsFrom` to the owning fork id."))

    # events
    producers = {str(ev) for n in nodes.values() for ev in (n.get("emits") or [])}
    for nid, n in sorted(nodes.items()):
        ev = n.get("waitsFor") or n.get("consumes")
        if ev and ev not in producers and not n.get("external"):
            d.append(_diag("WG014", "error", [nid], f"node {nid} waits for event {ev!r} that no node emits",
                           "Add an emitting node, or mark the wait `external: true` with a timeout exit.", witness=[f"{nid}:waits:{ev}"]))

    # human gates
    gates = {nid for nid, n in nodes.items() if (n.get("humanGate") or {}).get("authorizedRoles")}
    for nid, n in sorted(nodes.items()):
        needs = n.get("kind") == "wait" or "humanGate" in n
        if needs and nid not in gates:
            d.append(_diag("WG015", "error", [nid], f"human gate {nid} names no authorized roles",
                           "Set humanGate.authorizedRoles to the roles allowed to answer."))
        if n.get("kind") == "terminal" and n.get("result") == "needs-human-input":
            # must be reachable via something (a wait or failure path); no additional constraint
            continue

    # privileges
    perms = wf["permissions"]
    ceiling = set(perms.get("ceiling") or [])
    privileged = set(perms.get("privileged") or [])
    for nid, n in sorted(nodes.items()):
        want = set(n.get("permissions") or [])
        over = sorted(want - ceiling) if "ceiling" in perms else []
        if over:
            d.append(_diag("WG016", "error", [nid], f"node {nid} requests {over} beyond the workflow ceiling",
                           "Remove the permission or raise the ceiling through the policy owner.", witness=[f"{nid}:{p}" for p in over]))
        if nid in child_defs:
            grant = want or ceiling
            cperm = set((child_defs[nid].get("permissions") or {}).get("ceiling") or [])
            for cn in child_defs[nid].get("nodes", []):
                if isinstance(cn, dict):
                    cperm |= set(cn.get("permissions") or [])
            esc = sorted(cperm - grant) if ("ceiling" in perms or want) else []
            if esc:
                d.append(_diag("WG016", "error", [nid], f"child {n.get('ref')} of {nid} uses {esc} beyond what the parent grants",
                               "Narrow the child permissions or grant them explicitly on the parent node.", witness=[f"{nid}:{p}" for p in esc]))
        if want & privileged and nid in reach:
            rp = _reach([entry], adj, blocked=gates)
            if nid in rp:
                d.append(_diag("WG021", "error", [nid], f"privileged node {nid} ({sorted(want & privileged)}) is reachable without a human gate",
                               "Route every path to it through an authorized human gate node.", witness=_path(rp, nid)))

    # budgets
    budget = wf["budget"]
    has_budget = any(isinstance(budget.get(k), (int, float)) for k in BUDGET_KEYS)
    has_bound = any(_bounded(e) for e in valid_edges)
    if not wf["legacy"]:
        if not has_budget:
            d.append(_diag("WG017", "error" if has_bound or child_defs else "warning", [],
                           f"{name}: no budget (maxCost/maxIterations/maxWallSeconds) defines a termination contract",
                           "Declare a workflow budget so bounded loops and children terminate."))
        for nid in sorted(child_defs):
            n = nodes[nid]
            nb = n.get("budget") or {}
            if not n.get("inherit") and not nb:
                d.append(_diag("WG017", "error", [nid], f"child node {nid} neither inherits nor sets a budget",
                               "Set `inherit: true` or an explicit budget no larger than the parent's."))
            for k in BUDGET_KEYS:
                if isinstance(nb.get(k), (int, float)) and isinstance(budget.get(k), (int, float)) and nb[k] > budget[k]:
                    d.append(_diag("WG017", "error", [nid], f"child {nid} budget {k}={nb[k]} exceeds the parent's {budget[k]}",
                                   "Child budgets may only tighten the parent's.", witness=[f"{nid}:{k}"]))
    return d


def _sort_key(x: dict[str, Any]) -> tuple:
    return (SEVERITY_RANK[x["severity"]], x["code"], x["nodes"], x["witness"], x["message"])


def build_report(name: str, diagnostics: list[dict[str, Any]], mode: str = "enforce") -> dict[str, Any]:
    ds = sorted(diagnostics, key=_sort_key)
    errors = sum(1 for x in ds if x["severity"] == "error")
    return {"schemaVersion": SCHEMA_VERSION, "workflow": name, "mode": mode, "valid": errors == 0,
            "blocking": errors > 0 and mode == "enforce",
            "counts": {"error": errors, "warning": sum(1 for x in ds if x["severity"] == "warning"),
                       "info": sum(1 for x in ds if x["severity"] == "info"),
                       "unknown": sum(1 for x in ds if x["certainty"] == "unknown")},
            "diagnostics": ds}


def validate(raw: Any, children: dict[str, Any] | None = None, mode: str = "enforce", name: str | None = None) -> dict[str, Any]:
    label = name or (raw.get("name") if isinstance(raw, dict) else None) or "<unnamed>"
    return build_report(str(label), validate_definition(raw, children), mode)


def render_text(report: dict[str, Any]) -> str:
    c = report["counts"]
    lines = [f"Workflow {report['workflow']} [{report['mode']}]: {'VALID' if report['valid'] else 'INVALID'}"
             f"{' (blocking)' if report['blocking'] else ''} - {c['error']} error, {c['warning']} warning, {c['info']} info, {c['unknown']} UNKNOWN"]
    for x in report["diagnostics"]:
        tag = "UNKNOWN" if x["certainty"] == "unknown" else x["severity"].upper()
        lines.append(f"  [{tag}] {x['code']} {x['title']}: {x['message']}")
        if x["nodes"]:
            lines.append(f"      nodes: {', '.join(x['nodes'])}")
        if x["witness"]:
            lines.append(f"      witness: {' | '.join(x['witness'])}")
        lines.append(f"      fix: {x['suggestion']}")
    return "\n".join(lines) + "\n"


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------------------------- tree entry points
def _load(path: pathlib.Path) -> tuple[Any, bool]:
    """Return (definition, legacy)."""
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        return json.loads(text), False
    return adapt_legacy_yaml(text, path.stem), True


def validate_tree(root: pathlib.Path, mode_for_native: str = "enforce") -> list[dict[str, Any]]:
    """Validate workflows/*.workflow.json (enforced) and legacy workflows/*.yaml (always report-only)."""
    wdir = pathlib.Path(root) / "workflows"
    native: dict[str, Any] = {}
    reports: list[dict[str, Any]] = []
    files = sorted(wdir.glob("*.workflow.json"))
    for p in files:
        try:
            native[p.name.removesuffix(".workflow.json")] = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            reports.append(build_report(p.name, [_diag("WG022", "error", [], f"unreadable definition: {exc}", "Fix the JSON.")], mode_for_native))
    by_name: dict[str, Any] = {}
    for k, value in native.items():
        if not isinstance(value, dict):
            continue
        by_name[str(value.get("name") or k)] = value
        if value.get("contract") == "cezar.workflow" and isinstance(value.get("id"), str) and isinstance(value.get("version"), str):
            by_name[value["id"]] = value
            by_name[f"{value['id']}@{value['version']}"] = value
    for k, v in sorted(native.items()):
        reports.append(validate(v, by_name, mode_for_native, name=v.get("name", k) if isinstance(v, dict) else k))
    for p in sorted(list(wdir.glob("*.yaml")) + list(wdir.glob("*.yml"))):
        try:
            defn, _ = _load(p)
        except (OSError, UnicodeDecodeError) as exc:
            reports.append(build_report(p.name, [_diag("WG022", "error", [], f"unreadable workflow: {exc}", "Fix the file.")], "report-only"))
            continue
        reports.append(validate(defn, None, "report-only", name=p.name))
    return reports


def blocking_message(reports: list[dict[str, Any]]) -> str | None:
    bad = [r for r in reports if r["blocking"]]
    if not bad:
        return None
    return "; ".join(f"{r['workflow']}: " + ", ".join(f"{x['code']} {x['message']}" for x in r["diagnostics"] if x["severity"] == "error")[:400] for r in bad)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Validate workflow graphs statically (#764).")
    ap.add_argument("paths", nargs="+", help="workflow definition files (.json native, .yaml legacy) or a repo root with workflows/")
    ap.add_argument("--mode", choices=("enforce", "report-only"), default="enforce")
    ap.add_argument("--format", choices=("json", "text"), default="text")
    ap.add_argument("--children", help="directory of *.json child workflow definitions (by name)")
    a = ap.parse_args(argv)
    children: dict[str, Any] = {}
    if a.children:
        for p in sorted(pathlib.Path(a.children).glob("*.json")):
            c = json.loads(p.read_text(encoding="utf-8"))
            children[c.get("name", p.stem)] = c
    reports: list[dict[str, Any]] = []
    for raw in a.paths:
        p = pathlib.Path(raw)
        if p.is_dir():
            reports.extend(validate_tree(p))
            continue
        defn, legacy = _load(p)
        if isinstance(defn, dict) and defn.get("name"):
            children.setdefault(defn["name"], defn)
        reports.append(validate(defn, children, "report-only" if legacy else a.mode, name=p.name))
    out = [canonical_json(r) if a.format == "json" else render_text(r) for r in reports]
    sys.stdout.write("".join(out))
    return 1 if any(r["blocking"] for r in reports) else 0


if __name__ == "__main__":
    sys.exit(main())
