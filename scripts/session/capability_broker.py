"""Scoped capability profile and short-lived per-run credentials for session control.

Issue #346. Generic control plane: no project-specific (e.g. Godot) actions.
Standard library only (HMAC-SHA256 signed bearer tokens). Session identity, leases and
fencing stay owned by the session runtime; this module only *checks* the fence it is given.

Capabilities are split: ``observe`` (read-only) and ``control`` (interactive input).
``control`` implies ``observe``. Control is opt-in behind a feature flag.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import time

CAPABILITIES = ("observe", "control")
ACTIONS = {
    "screenshot": "observe", "snapshot": "observe", "read_text": "observe",
    "click": "control", "type": "control", "key": "control", "scroll": "control",
}
FLAG_ENV = "FACTORY_SESSION_CONTROL"
MAX_TTL = 900
DEFAULT_TTL = 300
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_SECRET = re.compile(r"(tok\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+|(?i:bearer)\s+\S+|(?i:token|secret|password)=\S+)")


class Denied(Exception):
    """Request refused. ``reason`` is a stable code, never credential material."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def redact(text):
    return _SECRET.sub("[REDACTED]", str(text))


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def narrow_capabilities(granted, project_config):
    """Project config may only remove capabilities. Unknown or widening scopes are rejected."""
    requested = (project_config or {}).get("capabilities")
    extra = set(project_config or {}) - {"capabilities"}
    if extra:
        raise Denied("config-unknown-key")
    if requested is None:
        return tuple(granted)
    if not isinstance(requested, (list, tuple)):
        raise Denied("config-invalid")
    for cap in requested:
        if cap not in CAPABILITIES:
            raise Denied("config-unknown-scope")
        if cap not in granted:
            raise Denied("config-escalation")
    return tuple(c for c in granted if c in requested)


class CapabilityBroker:
    def __init__(self, secret=None, fence_lookup=None, clock=time.time, env=None):
        self._key = secret or secrets.token_bytes(32)
        self._fence_lookup = fence_lookup or (lambda session: None)
        self._clock = clock
        self._env = env if env is not None else {}
        self._revoked = set()
        self._suspended = set()  # sessions under human takeover

    def _control_enabled(self):
        return str(self._env.get(FLAG_ENV, "")).lower() in ("1", "true", "on")

    def _sign(self, body):
        return _b64(hmac.new(self._key, body.encode(), hashlib.sha256).digest())

    def issue(self, *, project, run, attempt, session, fence, capability="observe",
              ttl=DEFAULT_TTL, project_config=None):
        for v in (project, run, attempt, session):
            if not isinstance(v, str) or not _ID.match(v):
                raise Denied("identity-invalid")
        if not isinstance(fence, int) or isinstance(fence, bool) or fence < 0:
            raise Denied("identity-invalid")
        if capability not in CAPABILITIES:
            raise Denied("unknown-capability")
        if capability == "control" and not self._control_enabled():
            raise Denied("control-disabled")
        if self._fence_lookup(session) != fence:
            raise Denied("stale-fence")
        if capability not in narrow_capabilities(CAPABILITIES, project_config):
            raise Denied("config-narrowed")
        ttl = max(1, min(int(ttl), MAX_TTL))
        now = int(self._clock())
        claims = {"jti": secrets.token_hex(8), "aud": "session-control", "project": project,
                  "run": run, "attempt": attempt, "session": session, "fence": fence,
                  "cap": capability, "iat": now, "exp": now + ttl}
        body = _b64(json.dumps(claims, sort_keys=True).encode())
        return "tok.%s.%s" % (body, self._sign(body))

    def _claims(self, token):
        try:
            prefix, body, sig = token.split(".")
            if prefix != "tok" or not hmac.compare_digest(sig, self._sign(body)):
                raise ValueError
            claims = json.loads(_unb64(body))
        except Exception:
            raise Denied("invalid-token") from None
        if claims.get("aud") != "session-control":
            raise Denied("wrong-audience")
        return claims

    def authorize(self, token, *, action, project, session, target="session"):
        """Return claims when ``action`` on ``session`` is permitted, else raise Denied."""
        claims = self._claims(token)
        if self._clock() >= claims["exp"]:
            raise Denied("expired")
        if claims["jti"] in self._revoked:
            raise Denied("revoked")
        if claims["project"] != project:
            raise Denied("cross-project")
        if claims["session"] != session:
            raise Denied("cross-session")
        if target != "session":  # host desktop, controller, sibling job, anything else
            raise Denied("target-out-of-scope")
        try:
            lookup = self._fence_lookup(session)
        except Exception:
            raise Denied("gateway-unavailable") from None
        if lookup is None or lookup != claims["fence"]:
            raise Denied("stale-fence")
        needed = ACTIONS.get(action)
        if needed is None:
            raise Denied("unknown-action")
        if needed == "control":
            if claims["cap"] != "control":
                raise Denied("capability-insufficient")
            if not self._control_enabled():
                raise Denied("control-disabled")
            if session in self._suspended:
                raise Denied("human-takeover")
        return claims

    def revoke(self, token):
        try:
            self._revoked.add(self._claims(token)["jti"])
        except Denied:
            pass

    def suspend(self, session):
        """Human takeover: agent input stops immediately; resume needs a fresh issue()."""
        self._suspended.add(session)

    def resume(self, session):
        """Clear the takeover; previously issued control tokens stay unusable after a new fence."""
        self._suspended.discard(session)
