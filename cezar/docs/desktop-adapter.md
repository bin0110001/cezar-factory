# Desktop adapter

The desktop adapter (`packages/cezar/src/session-control/desktop-adapter.ts`) observes and controls one session's own display, following ADR #344. It is injected with a maintained backend (AT-SPI for semantics, Selkies/X11 for pixels) and owns authorization, limits and cleanup. It adds no scheduler, session authority or evidence store; artifacts go through the existing `saveArtifact` hook.

## Grants

A session is read-only by default: only `accessibilitySnapshot` and `requestStop` work with no grant. Each grant is independent and opt-in:

| Grant | Allows |
| --- | --- |
| `screenshot` | `screenshot` |
| `input` | `invokeElement`, `setElementText`, `projectAction` |
| `clipboard` | `clipboardRead`, `clipboardWrite` |
| `fileTransfer` | `fileUpload`, `fileDownload` (relative session paths only) |
| `recording` | `recordingStart`, `recordingStop` |

The pixel fallback (`pixelClick`, `pixelType`, `pixelKey`) needs both `screenshot` and `input`. A denied request returns `denied_grant` and never reaches the backend.

## Isolation and limits

- The backend's display must equal the session display, and its uid must not be root; otherwise creation fails and the backend is closed.
- Every request is checked for session id, lease validity, a per-minute rate, and a session lifetime. Expiry and a stale lease close the session.
- Screenshot, clipboard, file and recording sizes and the recording duration are capped.
- Trace events hold only the action kind, outcome, error code and run/attempt/session ids. Typed text, clipboard and file contents are never recorded.

## Human takeover

`takeOver(owner)` suspends agent input (`input` actions return `suspended_by_takeover`) at once; one owner at a time. `resume(authorize)` returns to agent control only when the supplied fresh authorization decision returns true.

## Project-native actions

Projects register `DesktopProjectAction`s (name, argument schema, handler); the core has no Godot knowledge. `godot-pilot.ts` registers `create_room` over an injected Godot harness runner as the pilot. `projectAction` needs the `input` grant.

## Cleanup

`requestStop`, cancellation, disconnect and lease loss all call `close()`: grants and project actions are cleared and the backend is closed exactly once.
