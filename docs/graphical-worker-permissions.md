# Graphical worker permissions review (#340)

Implementation: `cezar/packages/cezar/src/server/verification/graphical-container-policy.ts`
(tests alongside). Extends the worker platform (#112/#113/#198, session contract #337/#329); no new scheduler or store.

## Container grants (rootless Podman)

Always: `--cap-drop=all`, `--security-opt=no-new-privileges`, `--read-only`, `--userns=keep-id`,
private IPC/PID, `--network=none` (or session-private slirp4netns without host loopback),
`--cpus`, `--memory` (= swap), `--pids-limit`, size-bounded `noexec` tmpfs for scratch.

Never emitted, and rejected by `assertSafeContainerArgv` if present: `--privileged`, `--cap-add`,
`/dev` or any device other than an allowlisted `/dev/dri/renderD*`, any `--volume`/`--mount`
(host display, Wayland/X11 sockets, `/run/user`, D-Bus, podman/docker sockets), host
network/pid/ipc/userns, unconfined seccomp/label, `--env-host`/`--env-file`, credential-like or
token-shaped env/argv values.

## Deny-by-default session grants

| Grant | Default | Opt-in |
| --- | --- | --- |
| GPU render node | none | worker policy `allowedDevices` |
| Live desktop | off | `liveDesktop: true` |
| Input | off | `inputGrant` and `liveDesktop` |
| Capture | view-only | `capture: none` disables; capture never implies input |

## Limits and fairness

CPU, RAM, disk, PIDs, sessions per worker, FPS, resolution, video seconds and session time are
checked at admission (`GraphicalSessionLedger`) and at runtime (`enforceRuntimeLimits`). Admission
also keeps `host.codingReserve*` free so graphical sessions cannot starve ordinary coding jobs.
Breaches map to the typed `resource_exhausted`/`gpu_unavailable`/`display_collision` reasons.
`release()` is idempotent so cancellation and failure always clean up.

## Redaction

`redactDiagnostics` strips tokens, credentials, clipboard text and host paths and bounds length;
`redactClipboard` reports size only; `boundImageEvidence` drops sensitive or oversized imagery.

## Residual host requirements

Rootless Podman with `slirp4netns`, cgroup v2 delegation for CPU/memory/pids limits, and render-node
ACLs for the worker user. Disk is bounded via tmpfs size; XFS project quotas are not assumed.
Callers must still wire the ledger into the session launcher; unsupported hardware is reported as
unavailable, never silently granted.
