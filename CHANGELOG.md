# Changelog

## [Unreleased]
- Deterministic static workflow graph and policy validator (#764): `scripts/release/workflow_graph_validator.py` builds a graph from resolved workflow definitions (child outcomes, effective guards) and diagnoses unreachable nodes/terminals, missing outcomes, unsafe implicit success, unbounded cycles and self loops (bounded review/repair loops pass), traps, unsatisfiable branches, UNKNOWN (never proven) guards, fork/join deadlocks, event consumers, human gates, privilege escalation/gate bypass and budget inheritance, with byte-identical machine diagnostics (`schemas/workflow-diagnostics.schema.json`) and a dry-run text report. Native `*.workflow.json` definitions block candidate activation; legacy `workflows/*.yaml` are validated report-only (approval require by process, not in-scope for this change).

- Fix promotion activation failure (#779): `factory-investigate` no longer uses a forward `onFail.retry` on its agent step, which the deployed Cezar loader rejects; the local suite now rejects forward retry targets for every workflow step.

- Investigation retries now have a fixed evidence scope and route failed agent steps through a bounded validation handoff; missing or invalid results become an explicit low-confidence outcome after one retry. The adaptive progress evaluator now normalizes duplicate finding metadata independent of row order and keeps the earliest observation on score ties.

- Promotion validation now mounts only the Factory source, Git metadata, and projects volume with SELinux relabeling disabled for the disposable container, preventing validation from changing the live Cezar volume labels. A hermetic fake-Podman test checks the validator's exact mount allowlist and SELinux options.

- Promotion validation now runs the full suite in a disposable init-enabled Cezar container, and the server CLI runs under Tini so orphaned child processes are reaped instead of exhausting the container task limit.
