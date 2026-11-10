# Session-control contract

The shared contract in `@open-mercato/cezar-contract` defines version 1 of adapter-neutral
session-control requests and responses. It describes metadata and screenshot observation,
accessibility snapshots, navigation, click/type/key/scroll actions, bounded condition waits, and
stop requests. It does not start sessions or execute actions.

The caller supplies the capability grant from authenticated session state to
`sessionControlActionAllowed`; capability must never be trusted from an agent request. `observe`
permits metadata, screenshot, accessibility snapshot, and condition wait only. Navigation, input,
scroll, and stop require `control`.

Requests are capped at 16 KiB. Responses are capped at 256 KiB, accessibility snapshots at 500
nodes, screenshot artifacts at 4 MiB, text input at 4 KiB, and condition waits at 30 seconds. The
adapter applies a per-session rolling limit of 60 requests per minute using the trusted session
identity and reports `rate_limited` with a bounded optional retry delay. Screenshot responses carry
an artifact reference and digest rather than binary content. Errors use stable typed codes and a
512-character message bound.
