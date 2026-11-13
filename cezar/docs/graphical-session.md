# Linux graphical session (Xvfb + Mesa)

`server/verification/graphical-session.ts` runs a disposable, software-rendered
GUI session for graphical verification jobs (#339, parent #328). It uses the
upstream `Xvfb` X server and Mesa `llvmpipe` (`LIBGL_ALWAYS_SOFTWARE=1`); it is
not a display server or compositor.

## Lifecycle

1. Check the fencing token (#214); a stale token is `fenced` before any work.
2. Lease the lowest free `display::N` from the existing `ResourceLockManager`
   (#112). Parallel sessions therefore get distinct displays; when the pool is
   exhausted the result is `contended` (rejected, never queued).
3. Create a private temp dir, start `Xvfb`, poll until the display answers.
4. Launch the app, require it to survive the settle window, capture a bounded
   screenshot and the GL renderer fingerprint, hand them to `onEvidence`.
5. Kill every process group, remove the temp dir, release the lease.

Every exit path runs step 5. `passed` is returned only if capture finished, the
fence is still current, and cleanup fully succeeded; crash, readiness timeout,
cancel, disconnect, stale fence or cleanup failure are never a pass.

## Host and fixture

`graphical-session-host.ts` is the real Linux host (Xvfb, `xdpyinfo`, ImageMagick
`import`, `glxinfo`). `fixtures/graphical/gui-fixture.py` is a generic non-Godot
Tk window used as the app. Unit tests use a fake host and need no X server.

## Unsupported

Hardware GPU acceleration (#341), Wayland/Xwayland, and non-Linux hosts are out
of scope. `evidence.software` is false when the fingerprint is not a software
renderer, so callers can refuse to treat it as software-render evidence.
