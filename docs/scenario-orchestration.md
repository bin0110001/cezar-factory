# Multi-worker scenario orchestration (#217)

`scripts/scenario/scenario_orchestrator.py` is a framework-independent core for running one
scenario across several workers. Server, client and observer are only example role names; the core
has no application roles. Project adapters (a Godot dedicated server, a browser, a plain TCP echo)
supply provisioning, readiness, execution and teardown. The tests use a non-Godot echo fixture.

## Manifest (`schemaVersion: 1`)
Named `roles` (`count`, `capabilities`, optional `graphicalSession {required, controls}`),
`topology.hostPolicy` (`distinct-physical` by default, or `same-host-allowed`), `network.zone`,
`barriers` (name plus roles), `timeouts`, and `retry {safe, maxAttempts}`. Scenario and attempt IDs
are hashes of the manifest and attempt number, so a replay maps to the same IDs.

## Behaviour
- **Placement** is deterministic. Offline, wrong-zone or under-capable workers are not candidates.
  `distinct-physical` never downgrades to one host; a graphical role keeps its display/GPU controls
  as required capabilities. If no assignment exists the outcome is `unschedulable`, never a pass.
- **Reservation** is all-or-none through a lease store with TTL and fencing tokens. A busy worker
  means nothing is held, so there is no partial claim and no deadlock; expiry frees a dead owner.
  The in-memory `LeaseStore` documents the four-method contract that the #112 workspace lease
  registry implements; there is no second persistent store.
- **Coordinator** moves `prepare, provision, ready, execute, collect, teardown, terminal`.
  Barriers check that every named role reported the checkpoint, so nothing depends on clock sync.
  Results carry the role's fence; a stale fence or a conflicting replay is rejected.
- **Faults** (worker lost, connectivity, port conflict, crash, partial start, timeout, cancel,
  display/GPU/control-grant loss) always collect evidence, tear down every started role in reverse
  order, release the leases and report the leftover count (`orphanLeases`, expected 0). Infra faults
  yield `infra`; a retry runs only when the manifest says `retry.safe`, only for infra faults, and
  at most `maxAttempts` times. A real failure is never retried.

## Not built here
Authenticated rendezvous transport, the real #112 store adapter, the Godot server plus two GUI
clients pilot, and #330 screenshot correlation depend on the transport, graphical-session and
evidence issues and attach to the role and attempt identity defined here.

Tests: `python3 -B -m unittest tests.test_factory_scenario_orchestrator`.
