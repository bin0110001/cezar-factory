#!/usr/bin/env python3
"""Activate one verified Factory SHA with recoverable project reconciliation.

The release controller only stages immutable bytes. This coordinator snapshots
each explicitly registered Cezar project's Factory automations, swaps the
channel pointer, reconciles definitions, and verifies the effective SHA and
workflow catalog. Any failed step restores the saved automation definitions and
the previous channel pointer. A durable journal lets the next invocation finish
that compensation after a process or host restart.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.release.factory_release_controller import (  # noqa: E402
    ControllerError,
    ReleaseController,
    atomic_write,
    canonical_json,
    digest,
    exclusive_lock,
)

FACTORY_PREFIX = "[factory] "
EDITABLE_FIELDS = ("name", "description", "kind", "events", "intervalSeconds", "filters", "trackerTrigger", "schedule", "task")
MAX_RESPONSE_BYTES = 512 * 1024
MAX_AUTOMATION_BYTES = 64 * 1024
SHA_RE = re.compile(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")


class ActivationError(ControllerError):
    pass


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def jcs_sha(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value)).hexdigest()


def subset_equal(wanted: Any, current: Any) -> bool:
    if isinstance(wanted, dict):
        return isinstance(current, dict) and all(key in current and subset_equal(value, current[key]) for key, value in wanted.items())
    if isinstance(wanted, list):
        return isinstance(current, list) and len(wanted) == len(current) and all(subset_equal(a, b) for a, b in zip(wanted, current))
    return wanted == current


def clean_target(raw: Any, index: int) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ActivationError(f"target registry entry {index} must be an object")
    project_id = raw.get("projectId")
    api_url = raw.get("apiUrl")
    project_type = raw.get("projectType", "")
    if not isinstance(project_id, str) or not project_id.strip() or len(project_id) > 256:
        raise ActivationError(f"target registry entry {index} has an invalid projectId")
    if not isinstance(api_url, str) or not api_url.strip():
        raise ActivationError(f"target {project_id} has no apiUrl")
    parsed = urllib.parse.urlsplit(api_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ActivationError(f"target {project_id} apiUrl must be an HTTP(S) origin/path without credentials, query, or fragment")
    if not isinstance(project_type, str) or len(project_type) > 128:
        raise ActivationError(f"target {project_id} has an invalid projectType")
    return {"projectId": project_id.strip(), "apiUrl": api_url.rstrip("/"), "projectType": project_type.strip()}


class ActivationCoordinator:
    def __init__(
        self,
        controller: ReleaseController,
        registry_path: pathlib.Path,
        *,
        api_override: str = "",
        timeout_seconds: int = 8,
        request: Callable[[str, str, Any | None], Any] | None = None,
    ):
        self.controller = controller
        self.store = controller.store
        self.registry_path = registry_path
        self.api_override = api_override.rstrip("/")
        self.timeout_seconds = max(1, min(timeout_seconds, 30))
        self.request = request or self._http_request
        self.journal_dir = self.store / "activations"
        self.receipt_dir = self.store / "receipts"
        self.quarantine_dir = self.store / "quarantine"
        for directory in (self.journal_dir, self.receipt_dir, self.quarantine_dir):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                os.chmod(directory, 0o700)
            except OSError:
                pass

    def _http_request(self, method: str, url: str, body: Any | None = None) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method, headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data is not None else {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as response:
                payload = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(2048).decode("utf-8", "replace")
            except OSError:
                detail = ""
            raise ActivationError(f"Cezar API {method} {urllib.parse.urlsplit(url).path} returned HTTP {exc.code}: {detail[:500]}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ActivationError(f"Cezar API {method} {urllib.parse.urlsplit(url).path} failed: {exc}") from exc
        if len(payload) > MAX_RESPONSE_BYTES:
            raise ActivationError(f"Cezar API {method} {urllib.parse.urlsplit(url).path} exceeded {MAX_RESPONSE_BYTES} bytes")
        if not payload:
            return None
        try:
            return json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ActivationError(f"Cezar API {method} {urllib.parse.urlsplit(url).path} returned invalid JSON") from exc

    def _url(self, target: dict[str, str], suffix: str) -> str:
        base = self.api_override or target["apiUrl"]
        project = urllib.parse.quote(target["projectId"], safe="")
        return f"{base}/api/v1/p/{project}{suffix}"

    def _api(self, target: dict[str, str], method: str, suffix: str, body: Any | None = None) -> Any:
        return self.request(method, self._url(target, suffix), body)

    def load_targets(self) -> list[dict[str, str]]:
        if not self.registry_path.is_file():
            raise ActivationError(f"target registry is missing: {self.registry_path}")
        try:
            raw = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ActivationError(f"target registry is unreadable or malformed: {exc}") from exc
        if not isinstance(raw, list) or not raw:
            raise ActivationError("target registry must contain at least one explicitly configured project")
        targets = [clean_target(item, index) for index, item in enumerate(raw)]
        ids = [item["projectId"] for item in targets]
        if len(ids) != len(set(ids)):
            raise ActivationError("target registry contains duplicate projectId entries")
        return targets

    def _diagnostic(self, target: dict[str, str]) -> dict[str, Any]:
        result = self._api(target, "GET", "/factory-release")
        if not isinstance(result, dict):
            raise ActivationError(f"{target['projectId']} release diagnostic is malformed")
        return result

    def _list_automations(self, target: dict[str, str]) -> list[dict[str, Any]]:
        result = self._api(target, "GET", "/automations")
        if not isinstance(result, dict):
            raise ActivationError(f"{target['projectId']} automation list is malformed")
        if result.get("available") is False:
            raise ActivationError(f"{target['projectId']} automations are unavailable: {result.get('reason', 'no reason provided')}")
        rows = result.get("automations")
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ActivationError(f"{target['projectId']} automation list has an invalid shape")
        return rows

    def _get_automation(self, target: dict[str, str], automation_id: str) -> dict[str, Any]:
        encoded = urllib.parse.quote(automation_id, safe="")
        result = self._api(target, "GET", f"/automations/{encoded}")
        automation = result.get("automation") if isinstance(result, dict) else None
        if not isinstance(automation, dict):
            raise ActivationError(f"{target['projectId']} automation {automation_id} could not be read")
        return automation

    @staticmethod
    def _editable(automation: dict[str, Any]) -> dict[str, Any]:
        result = {key: automation[key] for key in EDITABLE_FIELDS if key in automation}
        if not isinstance(result.get("name"), str) or not isinstance(result.get("task"), dict):
            raise ActivationError("Factory automation definition must include name and task")
        return result

    def _snapshot(self, target: dict[str, str], diagnostic: dict[str, Any]) -> dict[str, Any]:
        rows = self._list_automations(target)
        snapshot: list[dict[str, Any]] = []
        for row in rows:
            if not str(row.get("name", "")).startswith(FACTORY_PREFIX):
                continue
            automation_id = row.get("id")
            if not isinstance(automation_id, str) or not automation_id:
                raise ActivationError(f"{target['projectId']} factory automation has no id")
            item = self._get_automation(target, automation_id)
            snapshot.append({
                "id": automation_id,
                "revision": item.get("revision"),
                "enabled": item.get("enabled") is True,
                "editable": self._editable(item),
            })
        return {
            "target": target,
            "before": diagnostic,
            "automations": snapshot,
        }

    def _desired_automations(self, release_root: pathlib.Path, target: dict[str, str]) -> dict[str, dict[str, Any]]:
        directory = release_root / "automations"
        result: dict[str, dict[str, Any]] = {}
        version_path = release_root / "VERSION"
        version = version_path.read_text(encoding="utf-8").strip() if version_path.is_file() else "unknown"
        if directory.is_dir():
            for path in sorted(directory.glob("*.json")):
                if path.stat().st_size > MAX_AUTOMATION_BYTES:
                    raise ActivationError(f"automation definition is too large: {path.name}")
                try:
                    item = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ActivationError(f"automation definition is malformed: {path.name}: {exc}") from exc
                if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].startswith(FACTORY_PREFIX):
                    raise ActivationError(f"automation {path.name} must have a '{FACTORY_PREFIX}' name")
                requirement = item.pop("factoryRequires", None)
                required_type = requirement.get("projectType") if isinstance(requirement, dict) else None
                if required_type and required_type != target["projectType"]:
                    continue
                description = str(item.get("description", ""))
                item["description"] = f"{description} [cezar-factory {version}]".strip()
                editable = self._editable(item)
                name = editable["name"]
                if name in result:
                    raise ActivationError(f"duplicate Factory automation name: {name}")
                result[name] = editable
        return result

    @staticmethod
    def _deep_subset(wanted: Any, current: Any) -> bool:
        if isinstance(wanted, dict):
            return isinstance(current, dict) and all(key in current and ActivationCoordinator._deep_subset(value, current[key]) for key, value in wanted.items())
        if isinstance(wanted, list):
            return isinstance(current, list) and len(wanted) == len(current) and all(ActivationCoordinator._deep_subset(a, b) for a, b in zip(wanted, current))
        return wanted == current

    def _put(self, target: dict[str, str], item: dict[str, Any], editable: dict[str, Any], enabled: bool) -> dict[str, Any]:
        automation_id = urllib.parse.quote(str(item.get("id", "")), safe="")
        revision = item.get("revision")
        if not automation_id or not isinstance(revision, int) or revision < 1:
            raise ActivationError(f"{target['projectId']} automation revision is missing")
        body = dict(editable)
        body["enabled"] = enabled
        body["expectedRevision"] = revision
        result = self._api(target, "PUT", f"/automations/{automation_id}", body)
        automation = result.get("automation") if isinstance(result, dict) else None
        if not isinstance(automation, dict):
            raise ActivationError(f"{target['projectId']} automation update returned no automation")
        return automation

    def _reconcile(self, release_root: pathlib.Path, target: dict[str, str]) -> None:
        desired = self._desired_automations(release_root, target)
        rows = self._list_automations(target)
        existing_rows = {str(row.get("name")): row for row in rows if str(row.get("name", "")).startswith(FACTORY_PREFIX)}
        current_by_name: dict[str, dict[str, Any]] = {}
        for name, summary in existing_rows.items():
            automation_id = summary.get("id")
            if isinstance(automation_id, str):
                current_by_name[name] = self._get_automation(target, automation_id)
        for name in sorted(desired):
            definition = desired[name]
            current = current_by_name.get(name)
            if current is None:
                self._api(target, "POST", "/automations", definition)
                continue
            if self._deep_subset(definition, current):
                continue
            self._put(target, current, definition, current.get("enabled") is True)
        for name in sorted(current_by_name.keys() - desired.keys()):
            current = current_by_name[name]
            if current.get("enabled") is True:
                self._put(target, current, self._editable(current), False)

        # Read the server's final definitions back; HTTP acceptance alone is not a healthy receipt.
        verified_rows = self._list_automations(target)
        verified = {str(row.get("name")): row for row in verified_rows if str(row.get("name", "")).startswith(FACTORY_PREFIX)}
        if not set(desired).issubset(verified):
            raise ActivationError(f"{target['projectId']} automation reconciliation missed desired definitions")
        for name, definition in desired.items():
            automation_id = verified[name].get("id")
            if not isinstance(automation_id, str) or not self._deep_subset(definition, self._get_automation(target, automation_id)):
                raise ActivationError(f"{target['projectId']} automation did not converge: {name}")

    def _restore(self, saved: dict[str, Any]) -> None:
        target = saved["target"]
        original = saved["automations"]
        original_by_id = {item["id"]: item for item in original}
        rows = self._list_automations(target)
        failures: list[str] = []
        # Remove only Factory automations created after the snapshot.
        for row in rows:
            automation_id = row.get("id")
            if not str(row.get("name", "")).startswith(FACTORY_PREFIX) or not isinstance(automation_id, str) or automation_id in original_by_id:
                continue
            try:
                self._api(target, "DELETE", f"/automations/{urllib.parse.quote(automation_id, safe='')}")
            except Exception as exc:  # continue compensation for all definitions
                failures.append(f"delete {automation_id}: {exc}")
        # Restore every captured definition, including its enabled state.
        for old in original:
            try:
                live = self._get_automation(target, old["id"])
            except ActivationError as exc:
                if "HTTP 404" not in str(exc):
                    failures.append(f"read {old['id']}: {exc}")
                    continue
                try:
                    body = dict(old["editable"])
                    body["enable"] = old["enabled"]
                    self._api(target, "POST", "/automations", body)
                except Exception as exc:
                    failures.append(f"recreate {old['id']}: {exc}")
                continue
            try:
                if not self._deep_subset(old["editable"], live) or live.get("enabled") is not old["enabled"]:
                    self._put(target, live, old["editable"], old["enabled"])
            except Exception as exc:
                failures.append(f"restore {old['id']}: {exc}")
        # Confirm compensation by names, definitions, and enabled state.
        try:
            after = self._list_automations(target)
            after_by_name = {str(row.get("name")): row for row in after if str(row.get("name", "")).startswith(FACTORY_PREFIX)}
            for old in original:
                name = old["editable"]["name"]
                row = after_by_name.get(name)
                if row is None:
                    failures.append(f"verification missing {name}")
                    continue
                live = self._get_automation(target, str(row["id"]))
                if not self._deep_subset(old["editable"], live) or live.get("enabled") is not old["enabled"]:
                    failures.append(f"verification mismatch {name}")
            expected_names = {old["editable"]["name"] for old in original}
            unexpected = set(after_by_name) - expected_names
            if unexpected:
                failures.append(f"verification found new definitions: {', '.join(sorted(unexpected))}")
        except Exception as exc:
            failures.append(f"verification request failed: {exc}")
        if failures:
            raise ActivationError("automation compensation incomplete: " + "; ".join(failures)[:1800])

    def _discover_and_smoke(self, target: dict[str, str], sha: str, channel: str, desired_workflows: set[str]) -> dict[str, Any]:
        diagnostic = self._diagnostic(target)
        if diagnostic.get("status") != "resolved" or diagnostic.get("channel") != channel or diagnostic.get("sourceSha") != sha:
            raise ActivationError(f"{target['projectId']} reports {diagnostic.get('status')} {diagnostic.get('channel')} {diagnostic.get('sourceSha')}; expected resolved {channel} {sha}")
        if not isinstance(diagnostic.get("manifestDigest"), str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", diagnostic["manifestDigest"]):
            raise ActivationError(f"{target['projectId']} release diagnostic has no valid manifest digest")
        workflows_response = self._api(target, "GET", "/workflows")
        workflows = workflows_response.get("workflows") if isinstance(workflows_response, dict) else None
        if not isinstance(workflows, list) or any(not isinstance(item, dict) for item in workflows):
            raise ActivationError(f"{target['projectId']} workflow discovery response is malformed")
        available = {item.get("name") for item in workflows if isinstance(item.get("name"), str)}
        missing = desired_workflows - available
        if missing:
            raise ActivationError(f"{target['projectId']} could not discover required workflows: {', '.join(sorted(missing))}")
        if "quick-task" not in available:
            raise ActivationError(f"{target['projectId']} workflow catalog omitted built-in quick-task")
        self._list_automations(target)
        return diagnostic

    def _desired_workflow_names(self, release_root: pathlib.Path, target: dict[str, str]) -> set[str]:
        names: set[str] = {"quick-task"}
        for definition in self._desired_automations(release_root, target).values():
            workflow = definition.get("task", {}).get("workflow", "quick-task")
            if not isinstance(workflow, str) or not workflow:
                raise ActivationError(f"automation {definition['name']} has an invalid workflow name")
            names.add(workflow)
        return names

    def _load_quarantine(self, sha: str) -> pathlib.Path | None:
        path = self.controller.store / "quarantine" / f"{sha}.json"
        return path if path.is_file() else None

    def _append_receipt(self, journal: dict[str, Any], target_result: dict[str, Any]) -> pathlib.Path:
        target = target_result["target"]
        project_id = target["projectId"]
        generation = int(journal["generation"])
        receipt_id = target_result.setdefault("receiptId", str(uuid.uuid4()))
        receipt = {
            "schemaVersion": "factory-deployment-receipt/v1",
            "receiptId": receipt_id,
            "targetId": project_id,
            "channel": journal["channel"],
            "desiredSha": journal["desiredSha"],
            "actualSha": target_result.get("actualSha"),
            "observedSha": target_result.get("observedSha"),
            "artifactDigest": journal["artifactDigest"],
            "idempotencyKey": jcs_sha([project_id, journal["channel"], journal["desiredSha"], generation]),
            "activationGeneration": generation,
            "attempt": generation,
            "state": target_result["state"],
            "requestedAt": journal["requestedAt"],
            **({"stagedAt": journal["stagedAt"]} if journal.get("stagedAt") else {}),
            **({"activatedAt": journal["activatedAt"]} if journal.get("activatedAt") else {}),
            **({"observedAt": target_result.get("observedAt")} if target_result.get("observedAt") else {}),
            **({"compatibility": target_result["compatibility"]} if target_result.get("compatibility") else {}),
            **({"reasonCode": target_result["reasonCode"]} if target_result.get("reasonCode") else {}),
            **({"message": str(target_result["message"])[:2000]} if target_result.get("message") else {}),
        }
        digest_value = receipt["idempotencyKey"]
        path = self.receipt_dir / hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:24] / journal["channel"] / f"{receipt_id}.json"
        atomic_write(path, canonical_json(receipt), mode=0o600)
        target_result["receiptPath"] = str(path.relative_to(self.store))
        target_result["idempotencyKey"] = digest_value
        return path

    def _persist_journal(self, path: pathlib.Path, journal: dict[str, Any]) -> None:
        journal["updatedAt"] = now()
        atomic_write(path, canonical_json(journal), mode=0o600)

    def _journal_generation(self, channel: str, sha: str) -> int:
        maximum = 0
        for path in self.journal_dir.glob(f"{channel}-*-*.json"):
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if saved.get("channel") == channel and saved.get("desiredSha") == sha:
                maximum = max(maximum, int(saved.get("generation", 0)))
        return maximum + 1

    def _quarantine(self, sha: str, code: str, message: str) -> None:
        marker = {"schemaVersion": "factory-release-quarantine/v1", "sourceSha": sha, "reasonCode": code, "reason": message[:2000], "updatedAt": now()}
        atomic_write(self.quarantine_dir / f"{sha}.json", canonical_json(marker), mode=0o600)

    def _release_root(self, sha: str) -> pathlib.Path:
        path = self.controller.releases / sha
        self.controller.verify_release(path, expected_sha=sha)
        return path

    def _extract_candidate(self, sha: str, temp_parent: pathlib.Path) -> pathlib.Path:
        # The controller verifier has already checked every archive member and digest.
        from scripts.release.factory_release_controller import extract_archive

        release_root = self._release_root(sha)
        tree = temp_parent / "tree"
        entries = extract_archive(release_root / "artifact.tar", tree, "release/")
        manifest = json.loads((release_root / "manifest.json").read_text(encoding="utf-8"))
        if entries != manifest.get("files"):
            raise ActivationError("candidate archive entries differ from the verified manifest")
        return tree

    def _rollback_journal(self, journal_path: pathlib.Path, journal: dict[str, Any], *, recovered: bool = False) -> None:
        failures: list[str] = []
        for saved in journal.get("projects", []):
            try:
                self._restore(saved)
                saved["compensation"] = "restored"
            except Exception as exc:
                saved["compensation"] = "failed"
                saved["compensationError"] = str(exc)[:1500]
                failures.append(f"{saved['target']['projectId']}: {exc}")
        pointer = self.controller.channels / f"{journal['channel']}.json"
        current_sha = None
        try:
            current = json.loads(pointer.read_text(encoding="utf-8"))
            current_sha = current.get("currentSha")
        except (OSError, json.JSONDecodeError):
            failures.append("channel pointer is unreadable")
        rollback_sha = journal.get("rollbackSha") or journal.get("previousSha")
        was_active = current_sha == journal.get("desiredSha")
        if was_active and rollback_sha:
            try:
                self.controller._pointer(rollback_sha, rollback_sha)
            except Exception as exc:
                failures.append(f"channel pointer rollback: {exc}")
        elif current_sha not in (rollback_sha, None):
            failures.append(f"channel pointer moved unexpectedly to {current_sha}")
        for saved in journal.get("projects", []):
            target = saved["target"]
            previous_sha = saved.get("before", {}).get("sourceSha")
            restored = saved.get("compensation") == "restored"
            journal["targetResults"][target["projectId"]] = {
                "target": target,
                "state": "rolled_back" if restored and not failures else "failed",
                "actualSha": journal["desiredSha"] if (journal.get("pointerSwapped") or was_active) else previous_sha,
                "observedSha": rollback_sha if rollback_sha else previous_sha,
                "observedAt": now(),
                "reasonCode": "activation-recovered" if recovered else "activation-rolled-back",
                "message": "Activation was compensated after an interrupted run." if recovered else (journal.get("failure") or "Activation failed and the prior state was restored."),
            }
        for result in journal["targetResults"].values():
            self._append_receipt(journal, result)
        if failures:
            journal["state"] = "recovery_required"
            journal["failure"] = (journal.get("failure", "activation failed") + "; compensation incomplete: " + "; ".join(failures))[:2000]
        else:
            journal["state"] = "rolled_back"
            self._quarantine(journal["desiredSha"], "activation-failed", journal.get("failure", "activation did not pass project smoke tests"))
        journal["phase"] = "compensated" if not failures else "compensation-incomplete"
        journal["finishedAt"] = now()
        self._persist_journal(journal_path, journal)
        if failures:
            raise ActivationError(journal["failure"])

    def recover_incomplete(self) -> int:
        recovered = 0
        for path in sorted(self.journal_dir.glob("*.json")):
            try:
                journal = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ActivationError(f"activation journal is corrupt; refusing new activation: {path.name}: {exc}") from exc
            if journal.get("state") not in ("activating", "recovery_required"):
                continue
            journal["failure"] = journal.get("failure") or "interrupted activation recovered on startup"
            self._rollback_journal(path, journal, recovered=True)
            recovered += 1
        return recovered

    def _validate_candidate(self, tree: pathlib.Path) -> None:
        automation_dir = tree / "automations"
        if automation_dir.is_dir():
            for path in automation_dir.glob("*.json"):
                if path.stat().st_size > MAX_AUTOMATION_BYTES:
                    raise ActivationError(f"automation definition is too large: {path.name}")
                try:
                    item = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ActivationError(f"automation definition is malformed: {path.name}: {exc}") from exc
                if not isinstance(item, dict) or not isinstance(item.get("task"), dict):
                    raise ActivationError(f"automation definition has no task object: {path.name}")
        workflow_dir = tree / "workflows"
        if not workflow_dir.is_dir():
            raise ActivationError("candidate artifact has no workflows directory")
        if not any(workflow_dir.glob("*.yaml")) and not any(workflow_dir.glob("*.yml")):
            raise ActivationError("candidate artifact has no discoverable workflow files")

    def _write_failure_receipts(self, journal: dict[str, Any], error: str) -> None:
        for saved in journal.get("projects", []):
            target = saved["target"]
            project_id = target["projectId"]
            if project_id in journal.get("targetResults", {}):
                continue
            previous_sha = saved.get("before", {}).get("sourceSha")
            journal["targetResults"][project_id] = {
                "target": target, "state": "failed", "actualSha": previous_sha,
                "observedSha": previous_sha, "reasonCode": "activation-failed", "message": error[:2000],
            }
        for result in journal.get("targetResults", {}).values():
            if "receiptPath" not in result:
                self._append_receipt(journal, result)

    def activate(self, sha: str | None = None) -> dict[str, Any]:
        with exclusive_lock(self.store / "controller.lock"):
            self.recover_incomplete()
            if sha is None:
                staged = self.controller.stage_current()
                sha = staged["sourceSha"]
            if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
                raise ActivationError("activation requires a full lowercase SHA")
            if self._load_quarantine(sha):
                raise ActivationError(f"release {sha} is quarantined; run explicit revalidation before retrying")
            release_root = self._release_root(sha)
            channel = self.controller.channel
            pointer_path = self.controller.channels / f"{channel}.json"
            previous_sha = None
            rollback_sha = None
            if pointer_path.is_file():
                pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
                if pointer.get("schemaVersion") != "factory-release-channel-pointer/v1" or pointer.get("channel") != channel:
                    raise ActivationError(f"{channel} channel pointer is malformed")
                previous_sha = pointer.get("currentSha")
                rollback_sha = pointer.get("lastGoodSha") or previous_sha
                if previous_sha and previous_sha != sha:
                    result = subprocess.run(["git", "-C", str(self.controller.repo), "merge-base", "--is-ancestor", previous_sha, sha], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                    if result.returncode != 0:
                        raise ActivationError(f"refusing to activate non-descendant SHA {sha} over {previous_sha}")
            else:
                raise ActivationError("cannot activate before a verified channel pointer exists")
            if sha == previous_sha:
                # An already healthy artifact is idempotent; incomplete activation is recovered above.
                latest = self._latest_healthy(channel, sha)
                if latest:
                    return {"status": "unchanged", "channel": channel, "sourceSha": sha, "activationId": latest.get("activationId")}

            targets = self.load_targets()
            manifest = json.loads((release_root / "manifest.json").read_text(encoding="utf-8"))
            requested = now()
            with tempfile.TemporaryDirectory(prefix="factory-activation-") as tmp:
                tree = self._extract_candidate(sha, pathlib.Path(tmp))
                self._validate_candidate(tree)
                selected: list[dict[str, Any]] = []
                for target in targets:
                    diagnostic = self._diagnostic(target)
                    if diagnostic.get("status") != "resolved":
                        raise ActivationError(f"{target['projectId']} has no verified current Factory release: {diagnostic.get('error') or diagnostic.get('status')}")
                    target_channel = diagnostic.get("channel")
                    if target_channel not in ("dev", "stable"):
                        raise ActivationError(f"{target['projectId']} reports an unsupported channel")
                    if target_channel != channel:
                        continue
                    if diagnostic.get("sourceSha") != previous_sha:
                        raise ActivationError(f"{target['projectId']} effective SHA {diagnostic.get('sourceSha')} disagrees with {channel} pointer {previous_sha}")
                    selected.append(self._snapshot(target, diagnostic))
                if not selected:
                    raise ActivationError(f"no registered project currently selects {channel}; refusing unobserved activation")

                activation_id = str(uuid.uuid4())
                generation = self._journal_generation(channel, sha)
                journal = {
                    "schemaVersion": "factory-activation-journal/v1",
                    "activationId": activation_id,
                    "channel": channel,
                    "desiredSha": sha,
                    "previousSha": previous_sha,
                    "rollbackSha": rollback_sha,
                    "artifactDigest": manifest["artifact"]["sha256"],
                    "manifestDigest": manifest["manifestDigest"],
                    "generation": generation,
                    "state": "activating",
                    "phase": "prepared",
                    "requestedAt": requested,
                    "stagedAt": now(),
                    "projects": selected,
                    "targetResults": {},
                    "pointerSwapped": False,
                }
                journal_path = self.journal_dir / f"{channel}-{sha}-{activation_id}.json"
                self._persist_journal(journal_path, journal)
                try:
                    self.controller._pointer(sha, previous_sha)
                    journal["pointerSwapped"] = True
                    journal["activatedAt"] = now()
                    journal["phase"] = "pointer-swapped"
                    self._persist_journal(journal_path, journal)

                    for saved in selected:
                        target = saved["target"]
                        desired_workflows = self._desired_workflow_names(tree, target)
                        self._reconcile(tree, target)
                        diagnostic = self._discover_and_smoke(target, sha, channel, desired_workflows)
                        journal["targetResults"][target["projectId"]] = {
                            "target": target,
                            "state": "active",
                            "actualSha": sha,
                            "observedSha": diagnostic["sourceSha"],
                            "observedAt": now(),
                            "compatibility": {"status": "compatible", "capabilities": manifest["compatibility"]["requiredCapabilities"]},
                        }
                        journal["phase"] = f"project-verified:{target['projectId']}"
                        self._persist_journal(journal_path, journal)

                    journal["state"] = "healthy"
                    journal["phase"] = "healthy"
                    journal["finishedAt"] = now()
                    for result in journal["targetResults"].values():
                        self._append_receipt(journal, result)
                    self._persist_journal(journal_path, journal)
                    removed = self.controller._retention()
                    return {"status": "healthy", "channel": channel, "sourceSha": sha, "activationId": activation_id, "targetCount": len(selected), "retainedReleasesRemoved": removed}
                except Exception as exc:
                    journal["failure"] = str(exc)[:2000]
                    journal["phase"] = "compensating"
                    self._persist_journal(journal_path, journal)
                    try:
                        self._rollback_journal(journal_path, journal)
                    except Exception as rollback_error:
                        raise ActivationError(f"activation failed: {exc}; rollback requires recovery: {rollback_error}") from exc
                    raise ActivationError(f"activation rolled back: {exc}") from exc

    def _latest_healthy(self, channel: str, sha: str) -> dict[str, Any] | None:
        journals: list[dict[str, Any]] = []
        for path in self.journal_dir.glob(f"{channel}-{sha}-*.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if value.get("state") == "healthy":
                    journals.append(value)
            except (OSError, json.JSONDecodeError):
                continue
        return max(journals, key=lambda value: value.get("updatedAt", ""), default=None)

    def revalidate(self, sha: str) -> dict[str, Any]:
        if not SHA_RE.fullmatch(sha):
            raise ActivationError("revalidation requires a full lowercase SHA")
        root = self._release_root(sha)
        with tempfile.TemporaryDirectory(prefix="factory-revalidate-") as tmp:
            tree = self._extract_candidate(sha, pathlib.Path(tmp))
            self._validate_candidate(tree)
            for target in self.load_targets():
                self._desired_automations(tree, target)
        marker = self._load_quarantine(sha)
        if marker:
            marker.unlink()
        return {"status": "revalidated", "sourceSha": sha}

    def rollback(self, sha: str) -> dict[str, Any]:
        if not SHA_RE.fullmatch(sha):
            raise ActivationError("rollback requires a full lowercase SHA")
        current_pointer = self.controller.channels / f"{self.controller.channel}.json"
        pointer = json.loads(current_pointer.read_text(encoding="utf-8"))
        current_sha = pointer.get("currentSha")
        if current_sha == sha:
            return {"status": "unchanged", "channel": self.controller.channel, "sourceSha": sha}
        journal_path = None
        journal = None
        for path in sorted(self.journal_dir.glob(f"{self.controller.channel}-{current_sha}-*.json"), reverse=True):
            try:
                candidate = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if candidate.get("state") == "healthy" and candidate.get("previousSha") == sha:
                journal_path, journal = path, candidate
                break
        if journal is None or journal_path is None:
            raise ActivationError("no healthy activation snapshot exists for this rollback; channel was not changed")
        self.controller.verify_release(self.controller.releases / sha, expected_sha=sha)
        failures: list[str] = []
        for saved in journal["projects"]:
            try:
                self._restore(saved)
            except Exception as exc:
                failures.append(f"{saved['target']['projectId']}: {exc}")
        if failures:
            raise ActivationError("rollback automation restoration failed; pointer remains unchanged: " + "; ".join(failures)[:1800])
        self.controller._pointer(sha, sha)
        for saved in journal["projects"]:
            target = saved["target"]
            result = {
                "target": target, "state": "rolled_back", "actualSha": current_sha,
                "observedSha": sha, "observedAt": now(), "reasonCode": "operator-rollback",
                "message": "Automation definitions and channel pointer restored from the saved activation snapshot.",
            }
            self._append_receipt(journal, result)
        journal["state"] = "rolled_back"
        journal["phase"] = "operator-rollback"
        journal["finishedAt"] = now()
        self._persist_journal(journal_path, journal)
        return {"status": "rolled_back", "channel": self.controller.channel, "sourceSha": sha, "targetCount": len(journal["projects"])}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=("activate", "rollback", "revalidate", "recover"))
    p.add_argument("--repo", default=os.environ.get("FACTORY_CONTROLLER_REPO", "~/cezar-factory"))
    p.add_argument("--store", default=os.environ.get("FACTORY_RELEASE_STORE", "~/.local/share/cezar-factory/release-store"))
    p.add_argument("--registry", default="")
    p.add_argument("--api-url", default="")
    p.add_argument("--remote", default="origin")
    p.add_argument("--channel", default="stable")
    p.add_argument("--sha", default=None)
    p.add_argument("--timeout-seconds", type=int, default=8)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        repo = pathlib.Path(args.repo).expanduser()
        registry = pathlib.Path(args.registry).expanduser() if args.registry else repo / "config" / "factory-projects.json"
        controller = ReleaseController(repo, pathlib.Path(args.store).expanduser(), args.remote, args.channel, 3, 30, 4)
        coordinator = ActivationCoordinator(controller, registry, api_override=args.api_url, timeout_seconds=args.timeout_seconds)
        if args.command == "activate":
            result = coordinator.activate(args.sha)
        elif args.command == "rollback":
            with exclusive_lock(controller.store / "controller.lock"):
                coordinator.recover_incomplete()
                result = coordinator.rollback(args.sha or "")
        elif args.command == "revalidate":
            result = coordinator.revalidate(args.sha or "")
        else:
            with exclusive_lock(controller.store / "controller.lock"):
                result = {"status": "recovered", "count": coordinator.recover_incomplete()}
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (ActivationError, ControllerError, OSError, sqlite3.Error, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:2000]}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
