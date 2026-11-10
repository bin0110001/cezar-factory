# ADR: Graphical agent-control tooling

- **Status:** Proposed
- **Issue:** #344
- **Date:** 2026-11-09

## Context

Factory agents need to observe and act in browser and native application sessions. Those sessions must remain scoped to one authorized run and worker. Launching or rendering an application, interacting with it, and deciding whether its behavior is correct are separate responsibilities. Existing project-native test actions and assertions remain authoritative where they exist.

The control path must not grant access to a shared browser profile, the operator's desktop, another project, or the worker host. A tool's own host or origin filters are defense in depth; the worker boundary and network policy enforce authorization.

## Decision

Use the narrowest semantic interface available, in this order:

1. **Project-native actions and assertions.** Use the project's test harness or explicit action API for deterministic setup and checks. Keep project-specific actions in project-owned tools.
2. **Playwright locators for web applications.** Run Playwright in the existing authorized worker/session, with a fresh browser context and storage state for each attempt. Prefer role, label, and other semantic locators. Keep navigation and network access under worker policy.
3. **Accessibility actions for native applications.** On Linux, use AT-SPI actions and properties where the application exposes them. Accessibility support is platform and toolkit dependent; report missing or stale elements clearly.
4. **Session-local pixels and input.** Use a maintained display adapter such as Selkies only when semantic actions cannot reach the required control and the run explicitly has interactive permission. Bind it to the session's own display. Keep view-only mode enforced by the server. Selkies uses pixelflux for display capture and encoding; pixelflux is a media pipeline component, not an authorization or input-control boundary. Keep capture and input scoped to the same isolated Linux session.

Prefer direct Playwright scripting through the run's existing executor for the browser adapter. Playwright MCP may be offered as an integration when the provisioned MCP profile is already scoped to the run. It is a tool transport, not an authorization boundary. Do not expose the arbitrary-code execution capability to an untrusted agent; Microsoft documents it as equivalent to remote code execution in the Playwright server process. Origin allowlists also do not stop redirects, so they do not replace worker egress controls.

Do not build a second scheduler, session authority, or evidence store. The session runtime owns session identity and lifecycle. Existing run and verification artifacts own evidence references. The generic control plane exposes typed, bounded actions and does not include Godot-specific operations.

## Options considered

| Option | Strengths | Costs and limits | Decision |
| --- | --- | --- | --- |
| Project-native test actions | Deterministic, fast, and closest to application state | Requires a project-owned harness; not a general UI surface | First choice when available |
| Direct Playwright | Browser contexts provide isolated cookies and storage; semantic locators work without a virtual desktop; supports browser traces and screenshots | Browser-only; scripts still need a constrained executor and network policy | Default web adapter |
| Playwright MCP | Reuses an MCP tool surface and provides structured browser operations | Adds a server/process and tool provisioning; some capabilities execute arbitrary code; server filters are not a security boundary | Optional transport only inside an already scoped profile |
| Linux AT-SPI | Semantic native controls and accessible properties avoid coordinate-based actions | Linux desktop only; coverage varies by toolkit and application; accessibility trees can be incomplete or stale | Preferred native semantic adapter when supported |
| Selkies with pixelflux | Selkies supplies the Linux display session and input path; pixelflux captures and encodes X11/Wayland display changes | Pixel actions are less stable; capture and session streaming increase attack and data-transfer surface; pixelflux itself is not an input or authorization boundary; not a Windows desktop adapter | Conditional Linux fallback, separately authorized |

## Platform support

- **Web:** Playwright runs in the worker's supported browser environment on Windows and Linux. Use the same session contract and per-attempt context isolation on both.
- **Native Linux desktop:** AT-SPI is the semantic path when the target toolkit exposes usable controls. Selkies is the visual/input fallback inside an isolated Linux session.
- **Native Windows desktop:** This ADR does not select a Windows accessibility or display/input library. Do not reach into the host desktop or claim parity with the Linux adapter. Add a separately reviewed adapter decision when a Windows native fixture and session contract are available.

## Threat model and required controls

### Isolation and identity

- Bind every tool request to the authorized project, run, attempt, session, and worker identity. Reject missing, mismatched, expired, or fenced identities before dispatch.
- Create an isolated browser context and storage state per attempt. Never attach to the operator's browser or a shared project context.
- Run the application and adapter as a low-privilege session user. Do not mount host credentials, arbitrary host paths, or sibling sessions into the session.
- Revoke the agent's input grant when a session expires, is cancelled, changes owner, or enters human takeover. A stale agent cannot regain control by replaying an earlier request.

### Untrusted pages and applications

- Treat page text, accessibility labels, screenshots, downloads, and application output as untrusted data, not instructions or authorization.
- Validate typed action arguments and bound text length, action rate, wait duration, response size, and capture size. Do not provide general shell or arbitrary JavaScript as a browser action.
- Apply network egress policy outside the browser tool. Deny unapproved destinations, including loopback, link-local, private control-plane, metadata, and sibling-project endpoints. Re-check destination after redirects and before downloads.
- Do not place tokens, secrets, or raw page content in prompts, traces, or issue comments. Record only sanitized action metadata and artifact references under existing retention and access policy.

### Desktop input and data transfer

- Default sessions to read-only. The server rejects input from view-only identities even if a client sends keyboard or pointer messages.
- Grant click/type/key/scroll separately from screenshot observation. Pixel input requires explicit session permission and a session-local display.
- Disable clipboard synchronization and file transfer by default. If a task needs either direction, grant that direction for the session, cap size and duration, audit the transfer metadata, and revoke it at teardown.
- Keep recording and screenshots bounded, access-controlled, and redacted where required. Never treat an image as a passing test assertion.

### Lifecycle and operator control

- Stop requests are idempotent. Cancellation, lease loss, adapter failure, and worker disconnect revoke actions and clean up the browser context or display session.
- Human takeover pauses agent input and has one clear owner. Resume requires a fresh authorization decision.
- Emit action time, action kind, sanitized parameters, result, and immutable run/attempt/session references. Do not persist credentials, typed secret values, clipboard contents, or unbounded screenshots in the action trace.

## Consequences

This keeps browser and desktop interaction behind the existing worker/session model and permits headless browser runs without a virtual desktop. Projects with native test hooks avoid fragile UI control. Linux desktop-only applications can use accessibility semantics before pixels. Native Windows interaction remains unsupported until a separate adapter is reviewed and tested.

## References

- [Playwright browser contexts and isolation](https://playwright.dev/docs/browser-contexts)
- [Playwright MCP security notes and configuration](https://github.com/microsoft/playwright-mcp)
- [Selkies project and session capabilities](https://github.com/selkies-project/selkies)
- [pixelflux capture and encoding pipeline](https://github.com/selkies-project/pixelflux)
- [GNOME accessibility guidance](https://developer.gnome.org/documentation/guidelines/accessibility.html)
- [AT-SPI API reference](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/index.html)
- [Parent issue #329](https://github.com/bin0110001/cezar-factory/issues/329)
