#!/usr/bin/env python3
"""Read model and audited change requests for per-project Factory channels.

This module never moves a channel pointer, edits a symlink, or writes into a
project. It reads the controller store, the activation receipts and each
registered project's release diagnostic, and reports configured channel,
effective (observed) SHA and last successful activation as distinct facts.
A channel change is previewed read-only (impact, active pinned tasks, modified
override diff) and may then be *requested*: the request is an append-only,
permission-checked audit record bound to the preview digest. The change itself
is applied by the existing release flow (promotion/activation), which resolves
the new channel only for new tasks; running tasks keep their pinned SHA.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.release.factory_release_controller import SHA_RE, atomic_write, canonical_json, exclusive_lock, utc_now  # noqa: E402

CHANNELS = ("dev", "stable")
SUCCESS_STATES = ("healthy", "active")
REMEDIATION = {
    "unreachable": "Cezar API is unreachable; read state is stale. Check the Cezar container, then re-run detect.",
    "shadow_drift": "Project serves a different SHA than its channel. Run the controller's `repair` dry run, then open or link a drift issue.",
    "failed": "Last activation failed or rolled back. Inspect the receipt, fix the cause, and `revalidate` the quarantined SHA.",
    "incompatible": "Project is incompatible with the channel's release. Upgrade Cezar or stay on the previous channel.",
    "unconfigured": "No channel is recorded for this project; the diagnostic reported none. Reconcile the project.",
}


class ChannelError(Exception):
    pass


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _read_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class ProjectChannels:
    def __init__(self, store: pathlib.Path, registry: pathlib.Path, *, diagnostic=None, now=utc_now):
        """`diagnostic(target)` returns the project's release diagnostic dict or raises; injected for tests."""
        self.store = pathlib.Path(store)
        self.registry = pathlib.Path(registry)
        self.diagnostic = diagnostic or self._http_diagnostic
        self.now = now
        self.audit_dir = self.store / "channel-change-audit"

    # ---- inputs -------------------------------------------------------
    def targets(self) -> list[dict[str, Any]]:
        raw = _read_json(self.registry)
        if not isinstance(raw, list) or not raw:
            raise ChannelError(f"project registry is missing, malformed or empty: {self.registry}")
        out = []
        for item in raw:
            if isinstance(item, dict) and isinstance(item.get("projectId"), str) and isinstance(item.get("apiUrl"), str):
                out.append(item)
        if not out:
            raise ChannelError("project registry has no usable entries")
        return out

    @staticmethod
    def _http_diagnostic(target: dict[str, Any]) -> dict[str, Any]:
        import urllib.request
        url = target["apiUrl"].rstrip("/") + "/api/v1/p/" + target["projectId"] + "/factory-release"
        with urllib.request.urlopen(url, timeout=8) as response:  # noqa: S310 - operator-registered origin
            data = json.loads(response.read(512 * 1024))
        if not isinstance(data, dict):
            raise ChannelError("release diagnostic is malformed")
        return data

    def pointer(self, channel: str) -> dict[str, Any] | None:
        data = _read_json(self.store / "channels" / f"{channel}.json")
        if isinstance(data, dict) and data.get("channel") == channel and isinstance(data.get("currentSha"), str) and SHA_RE.fullmatch(data["currentSha"]):
            return data
        return None

    def quarantined(self, sha: str) -> bool:
        return (self.store / "quarantine" / f"{sha}.json").is_file()

    def receipts(self, project_id: str) -> list[dict[str, Any]]:
        base = self.store / "receipts" / hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:24]
        found = []
        if base.is_dir():
            for path in base.glob("*/*.json"):
                item = _read_json(path)
                if isinstance(item, dict) and item.get("targetId") == project_id:
                    found.append(item)
        return sorted(found, key=lambda r: (str(r.get("requestedAt", "")), int(r.get("activationGeneration") or 0)))

    # ---- read model ---------------------------------------------------
    def project_state(self, target: dict[str, Any]) -> dict[str, Any]:
        project = target["projectId"]
        receipts = self.receipts(project)
        good = [r for r in receipts if r.get("state") in SUCCESS_STATES]
        last = receipts[-1] if receipts else None
        state: dict[str, Any] = {
            "projectId": project,
            "projectType": target.get("projectType", ""),
            "configuredChannel": None,
            "configuredSha": None,
            "effectiveSha": None,
            "observedStatus": None,
            "lastSuccessfulActivation": ({"sha": good[-1].get("desiredSha"), "channel": good[-1].get("channel"), "at": good[-1].get("activatedAt") or good[-1].get("observedAt")} if good else None),
            "lastReceipt": ({"state": last.get("state"), "sha": last.get("desiredSha"), "reasonCode": last.get("reasonCode"), "message": last.get("message")} if last else None),
            "activeTasks": None,
            "compatibility": None,
            "installedPrecedence": None,
            "shadowDiff": None,
            "lastReconcile": None,
            "overrides": [],
            "stale": False,
            "findings": [],
            "remediation": [],
            "readAt": self.now(),
        }
        try:
            diag = self.diagnostic(target)
        except Exception as exc:  # offline/stale: still report the host-side facts
            state["stale"] = True
            state["findings"].append("unreachable")
            state["error"] = str(exc)[:300]
            diag = {}
        channel = diag.get("channel")
        state["configuredChannel"] = channel if channel in CHANNELS else None
        if diag:
            pointer = self.pointer(channel) if channel in CHANNELS else None
            state["configuredSha"] = pointer["currentSha"] if pointer else None
            state["effectiveSha"] = diag.get("sourceSha")
            state["observedStatus"] = diag.get("status")
            state["compatibility"] = diag.get("compatibility", "incompatible" if diag.get("status") == "incompatible" else "compatible")
            state["installedPrecedence"] = diag.get("precedence")  # as reported by the resolver; never recomputed here
            state["lastReconcile"] = diag.get("lastReconcile")
            state["activeTasks"] = diag.get("activeTasks") if isinstance(diag.get("activeTasks"), list) else None
            state["overrides"] = diag.get("overrides") if isinstance(diag.get("overrides"), list) else []
            if channel not in CHANNELS:
                state["findings"].append("unconfigured")
            if state["configuredSha"] and (diag.get("status") != "resolved" or state["effectiveSha"] != state["configuredSha"]):
                state["shadowDiff"] = {"expectedSha": state["configuredSha"], "observedSha": state["effectiveSha"]}
                state["findings"].append("shadow_drift")
            if state["compatibility"] == "incompatible":
                state["findings"].append("incompatible")
        if last and last.get("state") in ("failed", "rolled_back"):
            state["findings"].append("failed")
        state["deployed"] = bool(good) and good[-1].get("desiredSha") == state["effectiveSha"] and state["effectiveSha"] is not None
        state["remediation"] = [{"finding": f, "action": REMEDIATION[f]} for f in state["findings"] if f in REMEDIATION]
        return state

    def overview(self) -> dict[str, Any]:
        projects = [self.project_state(t) for t in self.targets()]
        return {"schemaVersion": "factory-project-channels/v1", "channels": {c: (self.pointer(c) or {}).get("currentSha") for c in CHANNELS}, "projects": projects}

    def detail(self, project_id: str) -> dict[str, Any]:
        target = next((t for t in self.targets() if t["projectId"] == project_id), None)
        if target is None:
            raise ChannelError(f"project {project_id} is not in the registry")
        return self.project_state(target)

    # ---- preview + audited request -------------------------------------
    def _release_file_digest(self, sha: str, rel: str) -> str | None:
        path = self.store / "releases" / sha / rel
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        except OSError:
            return None

    def preview(self, project_id: str, channel: str, actor: str, permitted: set[str] | None = None) -> dict[str, Any]:
        if channel not in CHANNELS:
            raise ChannelError(f"unsupported channel {channel!r}")
        if permitted is not None and actor not in permitted:
            return {"allowed": False, "reason": "permission-denied", "projectId": project_id, "actor": actor}
        state = self.detail(project_id)
        pointer = self.pointer(channel)
        if pointer is None:
            return {"allowed": False, "reason": "channel-unavailable", "projectId": project_id, "channel": channel}
        sha = pointer["currentSha"]
        if self.quarantined(sha):
            return {"allowed": False, "reason": "target-release-quarantined", "projectId": project_id, "channel": channel, "sha": sha}
        tasks = state["activeTasks"]
        diff = []
        for item in state["overrides"]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or ".." in pathlib.PurePosixPath(item["path"]).parts or item["path"].startswith("/"):
                continue
            release = self._release_file_digest(sha, item["path"])
            if item.get("digest") == item.get("baseDigest"):
                status = "unmodified"
            elif release is None:
                status = "override-only"
            elif release != item.get("baseDigest"):
                status = "conflict"  # release changed a file the project has modified
            else:
                status = "preserved"
            diff.append({"path": item["path"], "status": status})
        warnings = []
        if tasks is None:
            warnings.append("active tasks could not be read; assume running tasks exist")
        elif tasks:
            warnings.append(f"{len(tasks)} active task(s) stay pinned to their current SHA; only new tasks resolve {channel}")
        if state["stale"]:
            warnings.append("project state is stale (Cezar unreachable)")
        if any(d["status"] == "conflict" for d in diff):
            warnings.append("modified project overrides conflict with the target release")
        body = {"projectId": project_id, "fromChannel": state["configuredChannel"], "toChannel": channel, "targetSha": sha, "noChange": state["configuredChannel"] == channel,
                "activeTasks": tasks, "pinnedTasksUnaffected": True, "overrideDiff": diff, "warnings": warnings}
        body["token"] = _digest({k: body[k] for k in ("projectId", "fromChannel", "toChannel", "targetSha", "overrideDiff")} | {"tasks": [t.get("id") if isinstance(t, dict) else t for t in (tasks or [])]})
        return {"allowed": True, "readOnly": True, **body}

    def request_change(self, project_id: str, channel: str, actor: str, token: str, permitted: set[str] | None = None) -> dict[str, Any]:
        """Record an audited change request. Refused if the preview went stale (concurrent change). Applies nothing."""
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        with exclusive_lock(self.audit_dir / "audit.lock"):
            preview = self.preview(project_id, channel, actor, permitted)
            if not preview["allowed"]:
                return {"status": "refused", **preview}
            if preview["noChange"]:
                return {"status": "refused", "reason": "already-on-channel", "projectId": project_id}
            if preview["token"] != token:
                return {"status": "refused", "reason": "stale-preview", "currentToken": preview["token"]}
            entry = {"schemaVersion": "factory-channel-change-request/v1", "requestedAt": self.now(), "actor": actor, "projectId": project_id,
                     "fromChannel": preview["fromChannel"], "toChannel": channel, "targetSha": preview["targetSha"], "previewToken": token, "state": "requested"}
            path = self.audit_dir / f"{hashlib.sha256(canonical_json(entry)).hexdigest()[:24]}.json"
            atomic_write(path, canonical_json(entry), mode=0o600)
            return {"status": "requested", "audit": str(path), "applies": "through the release flow; no pointer or symlink was changed", **entry}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=("overview", "detail", "preview", "request"))
    p.add_argument("--store", default=os.environ.get("FACTORY_RELEASE_STORE", "~/.local/share/cezar-factory/release-store"))
    p.add_argument("--registry", default=str(ROOT / "config" / "factory-projects.json"))
    p.add_argument("--project")
    p.add_argument("--channel")
    p.add_argument("--actor", default=os.environ.get("USER", "unknown"))
    p.add_argument("--permit", action="append", help="Actor allowed to change channels (repeatable); omitted means unrestricted")
    p.add_argument("--token")
    args = p.parse_args(argv)
    try:
        svc = ProjectChannels(pathlib.Path(args.store).expanduser(), pathlib.Path(args.registry).expanduser())
        permitted = set(args.permit) if args.permit else None
        if args.command == "overview":
            result = svc.overview()
        elif not args.project:
            raise ChannelError(f"{args.command} requires --project")
        elif args.command == "detail":
            result = svc.detail(args.project)
        elif args.command == "preview":
            result = svc.preview(args.project, args.channel or "", args.actor, permitted)
        else:
            if not args.token:
                raise ChannelError("request requires --token from a preview")
            result = svc.request_change(args.project, args.channel or "", args.actor, args.token, permitted)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (ChannelError, OSError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:2000]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
