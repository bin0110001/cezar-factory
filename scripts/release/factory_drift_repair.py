#!/usr/bin/env python3
"""Read-only release drift probes and bounded, idempotent repairs."""

from __future__ import annotations

import hashlib
import json
import pathlib
from typing import Any

from scripts.release.factory_activation import ActivationCoordinator, ActivationError
from scripts.release.factory_incident_ledger import IncidentLedger, failure_fingerprint
from scripts.release.factory_release_controller import ControllerError, ReleaseController, SHA_RE, canonical_json, utc_now


class DriftRepair:
    def __init__(self, controller: ReleaseController, coordinator: ActivationCoordinator):
        self.controller = controller
        self.coordinator = coordinator
        self.receipt_dir = controller.store / "repair-receipts"

    @staticmethod
    def _finding(failure_class: str, key: str, summary: str, evidence: dict[str, Any]) -> dict[str, Any]:
        return {"failureClass": failure_class, "key": key, "summary": summary[:500], "evidence": evidence}

    def detect(self) -> dict[str, Any]:
        findings: list[dict[str, Any]] = []
        pointer_path = self.controller.channels / f"{self.controller.channel}.json"
        pointer: dict[str, Any] | None = None
        try:
            pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
            sha = pointer.get("currentSha")
            if pointer.get("schemaVersion") != "factory-release-channel-pointer/v1" or pointer.get("channel") != self.controller.channel:
                raise ControllerError("channel pointer schema or channel mismatch")
            if not isinstance(sha, str):
                raise ControllerError("channel pointer has no current SHA")
            if pathlib.Path(pointer.get("currentPath", "")).resolve() != (self.controller.releases / sha).resolve():
                raise ControllerError("channel pointer path does not match its current SHA")
            integrity = self.controller.verify_release(self.controller.releases / sha, expected_sha=sha)
            last_good = pointer.get("lastGoodSha")
            if not isinstance(last_good, str) or not SHA_RE.fullmatch(last_good):
                raise ControllerError("channel pointer has no valid last-good SHA")
            if pathlib.Path(pointer.get("lastGoodPath", "")).resolve() != (self.controller.releases / last_good).resolve():
                raise ControllerError("channel pointer path does not match its last-good SHA")
            self.controller.verify_release(self.controller.releases / last_good, expected_sha=last_good)
        except (OSError, ValueError, ControllerError, TypeError) as exc:
            findings.append(self._finding("release", "store-pointer", f"channel pointer or staged release is invalid: {exc}", {"channel": self.controller.channel}))
            integrity = None
        if pointer and integrity:
            indexed_sha = None
            if self.controller.db_path.is_file():
                with self.controller._db() as db:
                    row = db.execute("SELECT current_sha FROM channel_pointers WHERE channel=?", (self.controller.channel,)).fetchone()
                    indexed_sha = row["current_sha"] if row else None
            if indexed_sha != pointer["currentSha"]:
                findings.append(self._finding("release", "pointer-checkpoint", "channel pointer and SQLite checkpoint disagree", {"pointerSha": pointer["currentSha"], "lastGoodSha": pointer.get("lastGoodSha", pointer["currentSha"]), "checkpointSha": indexed_sha}))

        if pointer and integrity:
            desired_sha = pointer["currentSha"]
            root = self.controller.releases / desired_sha
            try:
                targets = self.coordinator.load_targets()
            except (ActivationError, OSError, ValueError) as exc:
                findings.append(self._finding("infrastructure", "target-registry", f"explicit target registry could not be read: {exc}", {"channel": self.controller.channel}))
                targets = []
            for target in targets:
                project = target["projectId"]
                try:
                    diagnostic = self.coordinator._diagnostic(target)
                    target_channel = diagnostic.get("channel")
                    if target_channel not in ("dev", "stable"):
                        findings.append(self._finding("compatibility", f"{project}:channel", "registered project reports an unsupported release channel", {"projectId": project, "channel": target_channel}))
                        continue
                    if target_channel != self.controller.channel:
                        continue
                    if diagnostic.get("status") != "resolved" or diagnostic.get("sourceSha") != desired_sha:
                        findings.append(self._finding("shadow_drift", f"{project}:release", "registered project does not serve the channel pointer SHA", {"projectId": project, "expectedSha": desired_sha, "observedSha": diagnostic.get("sourceSha"), "status": diagnostic.get("status")}))
                    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
                    desired = self.coordinator._desired_automations(root, target)
                    rows = self.coordinator._list_automations(target)
                    live: dict[str, dict[str, Any]] = {}
                    for row in rows:
                        name = row.get("name")
                        if isinstance(name, str) and name.startswith("[factory]"):
                            automation_id = row.get("id")
                            if not isinstance(automation_id, str):
                                raise ActivationError(f"{project} Factory automation has no id")
                            live[name] = self.coordinator._get_automation(target, automation_id)
                    mismatches = sorted(name for name, item in desired.items() if name not in live or not self.coordinator._deep_subset(item, live[name]))
                    extras = sorted(set(live) - set(desired))
                    if mismatches or extras:
                        findings.append(self._finding("automation", f"{project}:automations", "registered project's Factory automation definitions differ from the verified release", {"projectId": project, "desiredSha": desired_sha, "missingOrChanged": mismatches[:50], "extra": extras[:50]}))
                    required = manifest.get("compatibility", {}).get("requiredCapabilities", [])
                    if not isinstance(required, list) or diagnostic.get("status") == "incompatible":
                        findings.append(self._finding("compatibility", f"{project}:compatibility", "registered project is incompatible with the verified release", {"projectId": project, "desiredSha": desired_sha}))
                except (ActivationError, OSError, ValueError, TypeError, KeyError) as exc:
                    failure_class = "compatibility" if "incompatible-release" in str(exc) else "infrastructure"
                    findings.append(self._finding(failure_class, f"{project}:probe", f"registered project probe failed: {exc}", {"projectId": project}))

        failed = []
        if self.controller.db_path.is_file():
            with self.controller._db() as db:
                latest = db.execute("SELECT id,reason,source_sha,finished_at,status FROM attempts WHERE channel=? ORDER BY started_at DESC LIMIT 1", (self.controller.channel,)).fetchone()
                if latest and latest["status"] == "failed" and "fetch failed" in str(latest["reason"] or ""):
                    failed = [latest]
        for row in failed:
            findings.append(self._finding("failed_refetch", str(row["id"]), "a bounded controller refetch attempt failed", {"sourceSha": row["source_sha"], "finishedAt": row["finished_at"], "reason": str(row["reason"] or "")[:300]}))
        return {"status": "drift" if findings else "ok", "channel": self.controller.channel, "findings": findings}

    def repair(self, *, apply: bool = False) -> dict[str, Any]:
        report = self.detect()
        results: list[dict[str, Any]] = []
        if apply and not report["findings"]:
            if self.receipt_dir.is_dir():
                for path in self.receipt_dir.glob("*-*.json"):
                    try:
                        receipt = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        continue
                    if receipt.get("schemaVersion") == "factory-drift-repair-receipt/v1" and receipt.get("channel") == self.controller.channel and receipt.get("state") == "fixed":
                        receipt["state"] = "unchanged"
                        receipt["updatedAt"] = utc_now()
                        path.write_bytes(canonical_json(receipt))
                        results.append({"failureClass": receipt["failureClass"], "fingerprint": receipt["fingerprint"], "status": "unchanged", "receipt": str(path)})
            return {"status": "unchanged", "dryRun": False, "results": results}
        ledger = IncidentLedger(self.controller.store / "incidents.sqlite3") if apply else None
        for finding in report["findings"]:
            failure_class = finding["failureClass"]
            fingerprint = failure_fingerprint(failure_class, finding["summary"])
            admission = ledger.record_failure(failure_class, finding["summary"], causal_evidence={"source": "factory-release-controller", "stage": "drift-repair"}) if ledger else {"allowed": True}
            result: dict[str, Any] = {"failureClass": failure_class, "fingerprint": fingerprint, "status": "dry-run" if not apply else "skipped", "reason": None}
            if not admission.get("allowed"):
                result.update(status="skipped", reason=admission.get("reason"))
            elif apply and finding["key"] == "pointer-checkpoint":
                try:
                    with self.controller._db() as db:
                        db.execute("INSERT INTO channel_pointers(channel,current_sha,last_good_sha,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel) DO UPDATE SET current_sha=excluded.current_sha,last_good_sha=excluded.last_good_sha,updated_at=excluded.updated_at",
                                   (self.controller.channel, finding["evidence"]["pointerSha"], finding["evidence"]["lastGoodSha"], utc_now()))
                    result["status"] = "applied"
                except Exception as exc:  # keep a durable failed repair result
                    result.update(status="failed", reason=str(exc)[:300])
            elif apply and finding["failureClass"] == "automation" and finding["evidence"].get("desiredSha"):
                try:
                    sha = finding["evidence"]["desiredSha"]
                    marker = self.coordinator._load_quarantine(sha)
                    if marker:
                        result.update(status="skipped", reason="desired release is quarantined")
                    else:
                        target = next(item for item in self.coordinator.load_targets() if item["projectId"] == finding["evidence"]["projectId"])
                        root = self.controller.releases / sha
                        self.controller.verify_release(root, expected_sha=sha)
                        self.coordinator._reconcile(root, target)
                        result["status"] = "applied"
                except Exception as exc:
                    result.update(status="failed", reason=str(exc)[:300])
            elif apply and finding["failureClass"] == "failed_refetch":
                try:
                    self.controller.stage_current()
                    result["status"] = "applied"
                except Exception as exc:
                    result.update(status="failed", reason=str(exc)[:300])
            elif apply:
                result["reason"] = "no safe automatic repair is defined for this probe"
            if apply:
                followup = next((item for item in self.detect()["findings"] if item["key"] == finding["key"]), None) if result["status"] == "applied" else finding
                passed = followup is None
                receipt = {"schemaVersion": "factory-drift-repair-receipt/v1", "channel": self.controller.channel, "key": finding["key"], "failureClass": failure_class, "fingerprint": fingerprint, "probePassed": passed, "state": "fixed" if passed else "open", "updatedAt": utc_now()}
                self.receipt_dir.mkdir(parents=True, exist_ok=True)
                receipt_path = self.receipt_dir / f"{hashlib.sha256(finding['key'].encode()).hexdigest()[:16]}-{fingerprint[:16]}.json"
                receipt_path.write_bytes(canonical_json(receipt))
                result["receipt"] = str(receipt_path)
                if not passed and result["status"] == "applied":
                    result["status"] = "failed"
                    result["reason"] = "original probe did not pass after repair"
            results.append(result)
        status = "repaired" if any(item["status"] == "applied" for item in results) else report["status"]
        return {"status": status, "dryRun": not apply, "results": results}
