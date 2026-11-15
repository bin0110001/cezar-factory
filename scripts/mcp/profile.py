#!/usr/bin/env python3
"""Runner-neutral MCP profile: resolve overlays, adapt per runner, inject, preflight, revoke.

Secrets never enter profiles, Git, prompts or generated files: adapters emit only
environment-variable references; the per-run token travels in the returned env mapping.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

SCHEMA_VERSION = 1
LAYERS = ("global", "projectType", "project", "task")  # merge order, least to most specific
SERVER_FIELDS = {"endpoint", "identity", "tools", "runners", "projects", "required"}
OVERLAY_FIELDS = {"tools", "runners", "projects", "required", "remove"}
RUNNERS = ("claude", "codex")


class ProfileError(Exception):
    """Invalid or escalating profile (a Cezar setup error, raised before any agent starts)."""


class PreflightError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind  # setup | identity | required-tool


def _list(value, where):
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise ProfileError(f"{where} must be a list of non-empty strings")
    return value


def validate_base(doc):
    if not isinstance(doc, dict) or doc.get("schemaVersion") != SCHEMA_VERSION:
        raise ProfileError(f"base profile needs schemaVersion {SCHEMA_VERSION}")
    if not isinstance(doc.get("revision"), str) or not doc["revision"]:
        raise ProfileError("base profile needs a revision")
    servers = doc.get("servers")
    if not isinstance(servers, dict) or not servers:
        raise ProfileError("base profile needs servers")
    for name, s in servers.items():
        extra = set(s) - SERVER_FIELDS
        if extra:
            raise ProfileError(f"server {name}: unknown fields {sorted(extra)}")
        for key in ("endpoint", "identity"):
            if not isinstance(s.get(key), str) or not s[key]:
                raise ProfileError(f"server {name}: {key} required")
        if s["endpoint"].lower().startswith(("http://",)) and "localhost" not in s["endpoint"] and "127.0.0.1" not in s["endpoint"]:
            raise ProfileError(f"server {name}: remote endpoints must be https")
        if "@" in s["endpoint"].split("//", 1)[-1].split("/", 1)[0]:
            raise ProfileError(f"server {name}: credentials must not be embedded in the endpoint")
        _list(s.get("tools"), f"server {name}: tools")
        _list(s.get("runners", ["*"]), f"server {name}: runners")
        _list(s.get("projects", ["*"]), f"server {name}: projects")
    return doc


def _narrow_patterns(parent, child, where):
    """child must be covered by parent; patterns are literals or '*' globs."""
    for c in child:
        if not any(fnmatch.fnmatchcase(c, p) for p in parent):
            raise ProfileError(f"{where}: '{c}' widens the parent grant {parent}")
    return sorted(set(child))


def resolve(base, overlays, runner, project):
    """Return the deterministic effective profile for runner/project, or raise ProfileError."""
    validate_base(base)
    if runner not in RUNNERS:
        raise ProfileError(f"unsupported runner {runner}")
    servers = {n: {**s, "tools": sorted(set(s["tools"])), "runners": sorted(set(s.get("runners", ["*"]))),
                   "projects": sorted(set(s.get("projects", ["*"]))), "required": bool(s.get("required", False))}
               for n, s in base["servers"].items()}
    unknown = set(overlays) - set(LAYERS)
    if unknown:
        raise ProfileError(f"unknown overlay layers {sorted(unknown)}")
    for layer in LAYERS[1:]:
        for name, o in sorted((overlays.get(layer) or {}).items()):
            if name not in servers:
                raise ProfileError(f"{layer} overlay adds unknown server {name}")
            extra = set(o) - OVERLAY_FIELDS
            if extra:
                raise ProfileError(f"{layer}/{name}: unknown or widening fields {sorted(extra)}")
            cur, where = servers[name], f"{layer}/{name}"
            if o.get("remove") is True:
                if cur["required"]:
                    raise ProfileError(f"{where}: cannot remove a required server")
                del servers[name]
                continue
            if "tools" in o:
                cur["tools"] = _narrow_patterns(cur["tools"], _list(o["tools"], where + " tools"), where)
            for key in ("runners", "projects"):
                if key in o:
                    cur[key] = _narrow_patterns(cur[key], _list(o[key], f"{where} {key}"), where)
            if "required" in o:
                if not isinstance(o["required"], bool) or (cur["required"] and not o["required"]):
                    raise ProfileError(f"{where}: required may only be tightened")
                cur["required"] = o["required"]
    out = {}
    for name, s in sorted(servers.items()):
        if any(fnmatch.fnmatchcase(runner, p) for p in s["runners"]) and any(fnmatch.fnmatchcase(project, p) for p in s["projects"]):
            out[name] = {"endpoint": s["endpoint"], "identity": s["identity"], "tools": s["tools"], "required": s["required"]}
        elif s["required"]:
            raise ProfileError(f"{runner} on {project} is not authorized for required server {name}")
    effective = {"schemaVersion": SCHEMA_VERSION, "baseRevision": base["revision"], "runner": runner,
                 "project": project, "servers": out}
    effective["revision"] = hashlib.sha256(json.dumps(effective, sort_keys=True).encode()).hexdigest()[:16]
    return effective


def token_env(server):
    return "CEZ_MCP_TOKEN_" + "".join(c if c.isalnum() else "_" for c in server).upper()


def adapt(effective):
    """Provider config for the effective profile: (relative file name, text, allowed tool ids)."""
    runner, servers = effective["runner"], effective["servers"]
    if runner == "claude":
        cfg = {"mcpServers": {n: {"type": "http", "url": s["endpoint"],
                                  "headers": {"Authorization": "Bearer ${%s}" % token_env(n)}}
                              for n, s in servers.items()}}
        return ".mcp.json", json.dumps(cfg, indent=2, sort_keys=True) + "\n", \
            sorted(f"mcp__{n}__{t}" for n, s in servers.items() for t in s["tools"])
    if runner == "codex":
        lines = []
        for n, s in servers.items():
            lines += [f"[mcp_servers.{json.dumps(n)}]", f"url = {json.dumps(s['endpoint'])}",
                      f"bearer_token_env_var = {json.dumps(token_env(n))}",
                      "enabled_tools = " + json.dumps(s["tools"]), ""]
        return "config.toml", "\n".join(lines), sorted(f"{n}.{t}" for n, s in servers.items() for t in s["tools"])
    raise ProfileError(f"no adapter for {runner}")


def _http(method, url, body=None, token=None, timeout=10):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - gateway URL from policy
        return json.loads(r.read().decode() or "null")


class HttpBroker:
    """Issues and revokes run-bound identities at the gateway (#165/#166 credential boundary)."""

    def __init__(self, url, admin_token):
        self.url, self.admin = url.rstrip("/"), admin_token

    def issue(self, run_id, server, tools):
        r = _http("POST", f"{self.url}/identities", {"run": run_id, "server": server, "tools": tools}, self.admin)
        return r["id"], r["token"]

    def revoke(self, identity_id):
        _http("DELETE", f"{self.url}/identities/{identity_id}", None, self.admin)


def preflight(effective, tokens, lister=None):
    """Fail with a setup error before the agent starts. Optional servers only warn."""
    lister = lister or (lambda s, tok: _http("POST", s["endpoint"], {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, tok))
    warnings = []
    for name, s in effective["servers"].items():
        try:
            reply = lister(s, tokens[name])
            have = {t["name"] for t in reply["result"]["tools"]}
        except urllib.error.HTTPError as e:
            kind = "identity" if e.code in (401, 403) else "setup"
            err = PreflightError(kind, f"{name}: gateway answered {e.code}")
        except Exception as e:  # unreachable gateway, malformed reply
            err = PreflightError("setup", f"{name}: gateway unreachable or invalid ({type(e).__name__})")
        else:
            missing = sorted(set(s["tools"]) - have)
            if not missing:
                continue
            err = PreflightError("required-tool", f"{name}: missing tools {missing}")
        if s["required"]:
            raise err
        warnings.append(f"optional server {name} degraded: {err}")
    return warnings


def _state_path(runtime_dir):
    return Path(runtime_dir) / "mcp-state.json"


def prepare(base, overlays, runner, project, run_id, runtime_dir, broker, lister=None):
    """Resolve, issue identities (reused on retry), write 0600 config outside Git, preflight."""
    effective = resolve(base, overlays, runner, project)
    runtime = Path(runtime_dir)
    runtime.mkdir(parents=True, exist_ok=True)
    state = {}
    if _state_path(runtime).exists():
        state = json.loads(_state_path(runtime).read_text())
        if state["revision"] != effective["revision"] or state["run"] != run_id:
            raise ProfileError("retry must keep the run identity and profile revision; start a new run")
    ids = state.get("ids", {})
    tokens = {}
    try:
        for name, s in effective["servers"].items():
            if name in ids:  # retry: identity is retained and its token re-read from the environment
                tokens[name] = os.environ.get(token_env(name), "")
                continue
            ids[name], tokens[name] = broker.issue(run_id, name, s["tools"])
        fname, text, allowed = adapt(effective)
        _state_path(runtime).write_text(json.dumps({"run": run_id, "revision": effective["revision"], "ids": ids,
                                                     "files": [fname]}, sort_keys=True))
        os.chmod(_state_path(runtime), stat.S_IRUSR | stat.S_IWUSR)
        target = runtime / fname
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        warnings = preflight(effective, tokens, lister)
    except Exception:
        cleanup(runtime, broker)
        raise
    env = {token_env(n): t for n, t in tokens.items()}
    return {"revision": effective["revision"], "config": str(target), "allowedTools": allowed,
            "warnings": warnings, "env": env}


def cleanup(runtime_dir, broker):
    """Cancellation and completion: revoke every run identity, then delete runtime files."""
    runtime = Path(runtime_dir)
    path = _state_path(runtime)
    if not path.exists():
        return
    state = json.loads(path.read_text())
    failed = []
    for name, ident in sorted(state.get("ids", {}).items()):
        try:
            broker.revoke(ident)
        except Exception:
            failed.append(name)
    if failed:  # keep state so a later cleanup retries revocation; never leave silent live identities
        raise ProfileError(f"revocation failed for {failed}; state kept for retry")
    for f in state.get("files", []):
        (runtime / f).unlink(missing_ok=True)
    path.unlink()


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve")
    r.add_argument("--base", required=True)
    r.add_argument("--overlays", default="")
    r.add_argument("--runner", required=True)
    r.add_argument("--project", required=True)
    a = p.parse_args(argv)
    base = json.loads(Path(a.base).read_text())
    overlays = json.loads(Path(a.overlays).read_text()) if a.overlays else {}
    try:
        print(json.dumps(resolve(base, overlays, a.runner, a.project), indent=2, sort_keys=True))
    except ProfileError as e:
        print(f"MCP profile setup error: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
