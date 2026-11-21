# Static workflow graph and policy validator (#764)

`scripts/release/workflow_graph_validator.py` is a pure, deterministic library and CLI (no clock, IO beyond reading definitions,
randomness or LLM). It rejects invalid workflows before activation while accepting intentionally bounded review/repair cycles.
It is the *workflow* graph: it shares nothing with the issue dependency graph (#149) except the Tarjan SCC technique.
Runtime loop/liveness detection (#766), the hierarchical runtime (#765), GitHub projection (#767), UI and simulator are out of scope.

## Definition shape (v1 draft)

The #763 schema is consumed through one seam, `adapt_definition`; change it there when #763 finalises field names.
Nodes: `task`, `child` (`ref`, `inherit` or `budget`), `fork`, `join` (`joinsFrom`, `expects`, `mode`), `wait` (`humanGate.authorizedRoles`,
`waitsFor`, `external`) and `terminal` (`result`: success, failure, needs-human-input, cancelled). Edges carry `outcome`, `guard`
(`always`/`never` are decidable; any other expression is UNKNOWN) and `bound` (`{max: N}` or `escrow`). Workflow-level `permissions`
(`ceiling`, `privileged`) and `budget` (`maxCost`, `maxIterations`, `maxWallSeconds`). Child outcomes are the child's terminal results.
Legacy YAML steps are adapted linearly; `onFail.retry`/`max` becomes a bounded failure edge.

## Diagnostics (`schemas/workflow-diagnostics.schema.json`)

Each has `code`, `severity` (error/warning/info), `certainty` (`proven`/`unknown`), `nodes`, `witness` (edges `from->to:outcome` or a node path),
`message` and `suggestion`. Output is sorted and canonical, so identical input is byte-identical.

| Code | Meaning |
| --- | --- |
| WG001/2/3/22 | bad entry / dangling edge / missing child ref / malformed definition |
| WG004/5 | unreachable node / no terminal reachable |
| WG006/7/20 | missing outcome handler / unlabelled edge could treat failure as success / undeclared outcome |
| WG008/9/10 | unbounded self loop / unbounded cycle (a cycle needs a bounded edge, removing bounded edges must leave it acyclic) / trap with no exit |
| WG011/12 | definitely unsatisfiable guard / undecidable guard (UNKNOWN, treated as possibly true, never as proof) |
| WG013/14/15 | fork-join deadlock hazards / event consumer without producer / human gate without authorized roles |
| WG016/21 | permission beyond the ceiling or the parent grant / privileged node reachable without a human gate |
| WG017/18/19 | missing or oversized budget contract / child recursion / terminal with outgoing edge |

## Where it runs

- CLI: `python3 scripts/release/workflow_graph_validator.py [--mode enforce|report-only] [--format json|text] PATH...` (a repo root checks `workflows/`). Exit 1 only for blocking reports.
- Candidate activation (`factory_activation.py` `_validate_candidate`) runs `validate_tree`: native `workflows/*.workflow.json` are enforced; legacy `workflows/*.yaml` are report-only and never block.
- The same function is the entry point for create/edit paths of the hierarchical runtime (#765); a definition with errors is blocking in `enforce` mode.

## Tests

`python3 -B -m unittest tests.test_workflow_graph_validator` (also run by `tests/run-tests.ps1`): fixtures under `tests/fixtures/workflow-graph/`
cover unreachable terminal, missing outcome, unbounded cycle, self loop, missing child, privilege bypass, bounded loop and human wait, plus
determinism, UNKNOWN guards, fork/join, events, budgets and a report-only run over every existing `workflows/*.yaml`.
