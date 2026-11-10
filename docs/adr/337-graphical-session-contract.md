# ADR 337: Versioned graphical-session execution contract

## Status

Accepted for contract work. Graphical execution remains disabled by default until
the worker/session adapters and their capability probes are available.

## Decision

Represent an optional rendered-session request as a strict, versioned contract
attached to existing execution requests. Omitting `graphicalSession` preserves
the current local-only/headless behavior. The contract is project-neutral: project
adapters own application launch details, while the generic core handles mode,
display/renderer requirements, timeout, evidence permissions, and typed outcomes.

The modes have distinct meanings:

- `headless`: the application does not create a rendering context.
- `offscreen-rendered`: the application renders without a session display.
- `displayed`: the session owns a private display described by the request.

This avoids treating an offscreen renderer as equivalent to an application's
headless test mode. The request never chooses an arbitrary host display or adds
project-specific fields such as Godot flags.

Only trusted server configuration can enable the feature. `CEZ_GRAPHICAL_SESSIONS`
is off unless its value is exactly `1`; project configuration and task input cannot
turn it on. Capability discovery and enforcement remain server responsibilities.

## Backend support matrix

| Request | Contract | Runtime availability in this change |
| --- | --- | --- |
| Existing execution without a graphical request | Preserved | Existing executor path |
| Headless | Supported | Existing executor path; no graphical session is created |
| Offscreen-rendered, software/OpenGL/Vulkan | Valid only with explicit renderer requirement | Not certified; capability probe and worker adapter required |
| Displayed, X11/Wayland/native private display | Valid only with explicit per-session display bounds | Not certified; Xvfb/Mesa and isolation work remain prerequisites |
| Direct host desktop/display access | Not supported | Never exposed through this contract |

The request expresses requirements; it does not claim hardware support. Worker
capability discovery must reject unsupported combinations before execution. GPU
support is reported only after a render proof and pinned runtime fingerprint.

## Outcomes and compatibility

Session outcomes use explicit statuses and bounded reason codes for missing display,
unsupported renderer, stale capability, GPU unavailable/reset, startup timeout,
orphaned child, hung application, display collision, stale lease, disconnect,
cancellation, and resource exhaustion. Callers can distinguish infrastructure
failure from application test failure without guessing from log text.

Unknown schema versions and unknown fields are rejected. Existing runs that omit
the graphical request remain valid and retain their current behavior.

## Security

The feature switch is a trusted server capability, not request data. Display and
renderer values are bounded. Application entry points must be project-relative.
The contract does not grant clipboard, file transfer, input, host display, or GPU
access; those require separate explicit session grants and worker isolation.
