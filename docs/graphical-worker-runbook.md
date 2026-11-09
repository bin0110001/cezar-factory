# Graphical worker runbook (#328)

Operator guide for the opt-in `graphicalSession` execution mode on the existing worker platform
(parent #213; leases #112/#215, fencing #214). Status: **the runtime has not landed on `dev` at the time of
writing** (see `docs/graphical-worker-evidence.md`). Sections describe the required contract and operating
rules; each item is a requirement to verify once the runtime merges, not a statement that it works today.

## 1. Feature flag
- The graphical mode is **OFF by default**. A worker or project enables it explicitly in its own policy.
- With the flag off, `graphicalSession` requests are rejected, and existing local-only execution is unchanged.

## 2. Enrollment and probing
- Workers are probed at enrollment and periodically for: OS, driver/adapter, graphics APIs, actual
  rendering backend, virtual-display support, GPUs/VRAM (when detectable), screen capture, maximum safe sessions
  and application runtimes.
- Each capability is reported as `validated`, `unknown` or `failed` with a reason code, and published via #215.
  A stale or unknown capability makes the worker ineligible; it is never treated as supported.

## 3. Linux software path (Xvfb + Mesa)
- Baseline: a maintained Xvfb plus Mesa software rendering (llvmpipe) for compatible software/OpenGL workloads.
- Xvfb alone does **not** provide Vulkan or GPU acceleration. Never infer GPU support from a working Xvfb.
- Each parallel session gets its own display; collisions are rejected deterministically.
- Rendering without a visible display is not Godot `--headless`, which disables rendering.

## 4. GPU pilot (separately gated)
- GPU rendering is a separate gate, marked supported only after a real Vulkan/OpenGL execution is proven on that
  hardware. Unproven hardware is an explicit coverage gap, not a pass.
- GPU/display resources are exclusive and reserved through #112 leases; contention is serialized or rejected.

## 5. Windows
- Windows is **unsupported and unschedulable** for graphical sessions until a genuinely supported isolated
  interactive-session path is proven. An unsupported backend yields a distinct status, never a fake rendered pass.

## 6. Rootless Podman constraints
- Run rootless where feasible. Do not use `--privileged`, unrestricted `/dev` mounts, host display or session
  sockets, broad host D-Bus, or exposed container engine sockets. Device grants follow worker policy.

## 7. Limits
- Per-session CPU/GPU/RAM/disk, sessions per worker, FPS, resolution, video duration, session time and network
  scope are bounded. Local coding capacity and verification fairness (#198) are protected.

## 8. Cleanup and recovery
- On completion, crash or cancel: terminate the full process tree, release the lease, remove temp state.
- After a worker reconnect or restart, #214 fencing rejects stale sessions; orphaned sessions are reaped.
- Distinct statuses are required for: missing display server, unsupported renderer, stale capability, GPU
  unavailable/reset, startup timeout, orphaned child, hung app, display collision, stale lease, cancel/reconnect
  and resource exhaustion. None may report success.

## 9. Security defaults
- Live desktop access is **OFF** by default; there are no anonymous desktop endpoints.
- View-only capture grants are separate from input grants (#329).
- Logs, paths, clipboard content and sensitive images are redacted where policy requires; no tokens in process
  arguments or diagnostics.
