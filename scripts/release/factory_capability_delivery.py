#!/usr/bin/env python3
"""Deliver the approved gateway (MCP) policy and skill-catalog references.

The policy travels inside the pinned Factory release (``policies/capability-policy.json``),
so it is reviewed, promoted and rolled back with the same dev/stable semantics as every
other managed asset. This module only *activates* one verified policy per channel:

* stage   - validate and write an immutable, content-addressed snapshot (idempotent);
* verify  - ask the gateway what it actually serves and compare with the snapshot;
* swap    - move one atomic ``active.json`` pointer; nothing is enabled until then;
* recover - after an interrupted activation, re-verify and fall back to the last good one;
* pin     - a task's first resolution copies the policy into ``pins/<task>.json``;
            retries and later channel changes read the pin, never the pointer.

Secrets are never stored: a policy that carries token-like keys or values is refused.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
from typing import Any, Callable

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.release.factory_release_controller import (  # noqa: E402
    ControllerError,
    atomic_write,
    canonical_json,
    digest,
    exclusive_lock,
    utc_now,
)

POLICY_RELATIVE = pathlib.Path("policies") / "capability-policy.json"
SCHEMA = "factory-capability-policy/v1"
CHANNELS = ("dev", "stable")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
HASH_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
SECRET_KEY_RE = re.compile(r"token|secret|password|api[-_]?key|credential|authorization", re.I)
SECRET_VALUE_RE = re.compile(r"(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|Bearer\s+\S|-----BEGIN)")

Probe = Callable[[dict[str, Any]], dict[str, str]]


class DeliveryError(ControllerError):
    pass


def _scan_secrets(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if SECRET_KEY_RE.search(str(key)):
                raise DeliveryError(f"policy must not carry credentials ({path}.{key})")
            _scan_secrets(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _scan_secrets(item, f"{path}[{index}]")
    elif isinstance(value, str) and SECRET_VALUE_RE.search(value):
        raise DeliveryError(f"policy value looks like a credential at {path}")


def validate_policy(policy: Any) -> dict[str, Any]:
    if not isinstance(policy, dict) or policy.get("schemaVersion") != SCHEMA:
        raise DeliveryError(f"capability policy must be an object with schemaVersion {SCHEMA}")
    _scan_secrets(policy)
    gateway = policy.get("gateway")
    if not isinstance(gateway, dict) or not isinstance(gateway.get("profile"), str) or not ID_RE.fullmatch(gateway["profile"]):
        raise DeliveryError("policy.gateway.profile is required")
    seen: set[str] = set()
    entries = policy.get("catalog")
    if not isinstance(entries, list):
        raise DeliveryError("policy.catalog must be a list")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not ID_RE.fullmatch(entry["id"]):
            raise DeliveryError("every catalog entry needs a valid id")
        if entry["id"] in seen:
            raise DeliveryError(f"duplicate catalog id {entry['id']}")
        seen.add(entry["id"])
        if entry.get("approved") is not True:
            raise DeliveryError(f"catalog entry {entry['id']} is not approved; remove it instead of listing it")
        if not isinstance(entry.get("ref"), str) or not entry["ref"] or not HASH_RE.fullmatch(str(entry.get("sha256", ""))):
            raise DeliveryError(f"catalog entry {entry['id']} needs a ref and a sha256 content hash")
    return policy


def policy_digest(policy: dict[str, Any]) -> str:
    return digest(canonical_json(policy))


def read_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DeliveryError(f"{path.name} is unreadable: {exc}") from exc


class CapabilityDelivery:
    def __init__(self, store: pathlib.Path, channel: str, probe: Probe):
        if channel not in CHANNELS:
            raise DeliveryError(f"unknown channel {channel}")
        self.channel = channel
        self.probe = probe
        self.base = pathlib.Path(store) / "capability" / channel
        self.snapshots = self.base / "snapshots"
        self.pins = self.base.parent / "pins"
        for directory in (self.snapshots, self.pins):
            directory.mkdir(parents=True, exist_ok=True, mode=0o750)

    # -- evidence (no secrets: ids, digests, outcomes only) ---------------------------------
    def _evidence(self, event: str, **fields: Any) -> dict[str, Any]:
        record = {"at": utc_now(), "channel": self.channel, "event": event, **fields}
        with (self.base / "evidence.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
        return record

    def _pointer_path(self) -> pathlib.Path:
        return self.base / "active.json"

    def pointer(self) -> dict[str, Any] | None:
        path = self._pointer_path()
        return read_json(path) if path.exists() else None

    def _snapshot_policy(self, digest_value: str) -> dict[str, Any]:
        path = self.snapshots / digest_value.replace(":", "-") / "policy.json"
        policy = validate_policy(read_json(path))
        if policy_digest(policy) != digest_value:
            raise DeliveryError(f"snapshot {digest_value} does not match its content hash")
        return policy

    # -- stage ------------------------------------------------------------------------------
    def stage(self, release_dir: pathlib.Path, sha: str) -> str:
        policy = validate_policy(read_json(pathlib.Path(release_dir) / POLICY_RELATIVE))
        value = policy_digest(policy)
        target = self.snapshots / value.replace(":", "-")
        if (target / "policy.json").exists():
            return value  # idempotent: same bytes, same snapshot
        tmp = self.snapshots / f".tmp-{os.getpid()}-{value[7:19]}"
        tmp.mkdir(parents=True, exist_ok=True)
        atomic_write(tmp / "policy.json", canonical_json(policy))
        atomic_write(tmp / "source.json", canonical_json({"releaseSha": sha, "stagedAt": utc_now()}))
        if target.exists():  # stale partial directory from an interrupted stage
            for child in target.iterdir():
                child.unlink()
            target.rmdir()
        os.replace(tmp, target)
        return value

    # -- verify -----------------------------------------------------------------------------
    def verify(self, policy: dict[str, Any]) -> dict[str, Any]:
        """Compare what the gateway serves to the policy. Raises on any mismatch."""
        try:
            observed = self.probe(policy)
        except Exception as exc:  # Obot down/restarting: never treat as success
            raise DeliveryError(f"gateway unavailable: {type(exc).__name__}") from exc
        wanted = {entry["id"]: entry["sha256"] for entry in policy["catalog"]}
        extra = sorted(set(observed) - set(wanted))
        missing = sorted(set(wanted) - set(observed))
        changed = sorted(key for key in wanted if key in observed and observed[key] != wanted[key])
        report = {"extra": extra, "missing": missing, "changed": changed}
        if extra or missing or changed:
            raise DeliveryError(f"gateway does not match policy: {json.dumps(report, sort_keys=True)}")
        return report

    def drift(self) -> dict[str, Any]:
        pointer = self.pointer()
        if not pointer:
            return {"status": "no-active-policy"}
        policy = self._snapshot_policy(pointer["policyDigest"])
        try:
            self.verify(policy)
        except DeliveryError as exc:
            return {"status": "drift", "policyDigest": pointer["policyDigest"], "detail": str(exc)}
        return {"status": "in-sync", "policyDigest": pointer["policyDigest"]}

    # -- activate / rollback / recover --------------------------------------------------------
    def activate(self, release_dir: pathlib.Path, sha: str, approved_by: str | None = None) -> dict[str, Any]:
        if self.channel == "stable" and not approved_by:
            raise DeliveryError("stable activation requires a reviewed promotion (approved_by)")
        with exclusive_lock(self.base / "delivery.lock"):
            self._recover_locked()
            previous = self.pointer()
            journal = self.base / "journal.json"
            try:
                value = self.stage(release_dir, sha)
                atomic_write(journal, canonical_json({"phase": "verifying", "policyDigest": value, "releaseSha": sha, "previous": previous and previous["policyDigest"]}))
                self.verify(self._snapshot_policy(value))
            except DeliveryError as exc:
                # The pointer was never moved, so no unapproved capability was enabled.
                journal.unlink(missing_ok=True)
                self._evidence("activation-failed", releaseSha=sha, reason=str(exc), active=previous and previous["policyDigest"])
                raise
            if previous and previous["policyDigest"] == value:
                journal.unlink(missing_ok=True)
                self._evidence("unchanged", releaseSha=sha, policyDigest=value)
                return previous
            record = {"schemaVersion": "factory-capability-pointer/v1", "channel": self.channel, "policyDigest": value,
                      "releaseSha": sha, "lastGoodDigest": previous["policyDigest"] if previous else value,
                      "approvedBy": approved_by, "updatedAt": utc_now()}
            atomic_write(self._pointer_path(), canonical_json(record))
            journal.unlink(missing_ok=True)
            self._evidence("activated", releaseSha=sha, policyDigest=value, previous=previous and previous["policyDigest"])
            return record

    def rollback(self) -> dict[str, Any]:
        with exclusive_lock(self.base / "delivery.lock"):
            return self._rollback_locked("manual")

    def _rollback_locked(self, reason: str) -> dict[str, Any]:
        pointer = self.pointer()
        if not pointer or pointer["lastGoodDigest"] == pointer["policyDigest"]:
            raise DeliveryError("no earlier verified policy to roll back to")
        good = self._snapshot_policy(pointer["lastGoodDigest"])
        self.verify(good)
        record = {**pointer, "policyDigest": pointer["lastGoodDigest"], "updatedAt": utc_now()}
        atomic_write(self._pointer_path(), canonical_json(record))
        self._evidence("rolled-back", reason=reason, from_=pointer["policyDigest"], to=record["policyDigest"])
        return record

    def recover(self) -> str:
        with exclusive_lock(self.base / "delivery.lock"):
            return self._recover_locked()

    def _recover_locked(self) -> str:
        """Finish or undo an interrupted activation; leave the verified policy active."""
        journal = self.base / "journal.json"
        if not journal.exists():
            return "clean"
        journal.unlink()
        pointer = self.pointer()
        if pointer:
            try:
                self.verify(self._snapshot_policy(pointer["policyDigest"]))
            except DeliveryError:
                try:
                    self._rollback_locked("interrupted-activation")
                    return "rolled-back"
                except DeliveryError:
                    self._evidence("recovery-held", reason="no verified policy; capability delivery paused")
                    return "held"
        self._evidence("recovered", active=pointer and pointer["policyDigest"])
        return "recovered"

    # -- task pinning ------------------------------------------------------------------------
    def resolve_for_task(self, task_id: str, project: dict[str, Any] | None = None) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", task_id):
            raise DeliveryError("invalid task id")
        pin_path = self.pins / f"{task_id}.json"
        if pin_path.exists():
            return read_json(pin_path)  # active and retried runs never see a newer policy
        pointer = self.pointer()
        if not pointer:
            raise DeliveryError("no active capability policy for this channel")
        policy = self._snapshot_policy(pointer["policyDigest"])
        enabled = {entry["id"] for entry in policy["catalog"] if entry.get("default", True)}
        notes: list[str] = []
        for wanted in (project or {}).get("optIn", []):
            if wanted in {entry["id"] for entry in policy["catalog"]}:
                enabled.add(wanted)
            else:
                notes.append(f"ignored unapproved opt-in {wanted}")
        required = {entry["id"] for entry in policy["catalog"] if entry.get("required")}
        for dropped in (project or {}).get("optOut", []):
            if dropped in required:
                notes.append(f"opt-out of required {dropped} refused")
            else:
                enabled.discard(dropped)
        pin = {"taskId": task_id, "channel": self.channel, "policyDigest": pointer["policyDigest"],
               "gatewayProfile": policy["gateway"]["profile"], "pinnedAt": utc_now(),
               "skills": [e for e in policy["catalog"] if e["id"] in enabled], "precedence": "policy>project", "notes": notes}
        atomic_write(pin_path, canonical_json(pin))
        return pin


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=("activate", "rollback", "recover", "drift"))
    p.add_argument("--store", required=True, type=pathlib.Path)
    p.add_argument("--channel", required=True, choices=CHANNELS)
    p.add_argument("--release-dir", type=pathlib.Path)
    p.add_argument("--sha")
    p.add_argument("--approved-by")
    p.add_argument("--observed", type=pathlib.Path, help="JSON file of {catalogId: sha256} reported by the gateway")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)

    def probe(_policy: dict[str, Any]) -> dict[str, str]:
        if not args.observed:
            raise DeliveryError("no gateway observation supplied")
        return read_json(args.observed)

    delivery = CapabilityDelivery(args.store, args.channel, probe)
    try:
        if args.action == "activate":
            if not args.release_dir or not args.sha:
                raise DeliveryError("activate needs --release-dir and --sha")
            result: Any = delivery.activate(args.release_dir, args.sha, args.approved_by)
        elif args.action == "rollback":
            result = delivery.rollback()
        elif args.action == "recover":
            result = {"status": delivery.recover()}
        else:
            result = delivery.drift()
    except ControllerError as exc:
        print(json.dumps({"status": "failed", "reason": str(exc)}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
