"""Run one quality-gate stage for a project with the operator controls applied (#603, #634).

Library only. This is the caller `quality_stage_gate.evaluate_stage` was waiting for. For one project and stage it:

1. honors an operator pause (`holds.json`, written by `release_inbox_step`): a paused project is not evaluated and returns `held`, so no new gate
   work starts for it and nothing is reported as passed;
2. passes the project's unexpired operator-granted waivers (`release_inbox_step.granted_suppressions`) to the gate, so a waiver an operator
   requested through the Control Center takes effect, and an expired one stops applying;
3. returns the gate's redacted receipt unchanged, so `allowed` stays the gate's decision, never this module's.

It does not write candidate state, promote, or fetch. A missing or unreadable holds file means no pause; an unreadable waiver log means no waivers
(fail closed: findings then block as they would without a waiver).
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

from scripts.release import quality_stage_gate as sg
from scripts.release import release_inbox_step as inbox


def paused(release_dir: pathlib.Path) -> set[str]:
    try:
        doc = json.loads((release_dir / "holds.json").read_text(encoding="utf8"))
    except (OSError, ValueError):
        return set()
    items = doc.get("paused") if isinstance(doc, dict) else None
    return {p for p in items if isinstance(p, str)} if isinstance(items, list) else set()


def run_stage(release_dir: pathlib.Path, *, doc: dict[str, Any], project: str, repo_type: str | None, stage: str, changed_paths: list[str],
              checks: dict[str, dict[str, Any]], findings: list[dict[str, Any]], baseline: list[dict[str, Any]], now: float,
              **gate_options: Any) -> dict[str, Any]:
    if project in paused(release_dir):
        return {"schemaVersion": "quality-stage-run/v1", "project": project, "stage": stage, "status": "held", "allowed": False,
                "reason": "an operator paused this project; no gate was evaluated and nothing is reported as passed"}
    try:
        suppressions = inbox.granted_suppressions(release_dir, project, now=now)
    except Exception:  # an unreadable log grants nothing
        suppressions = []
    receipt = sg.evaluate_stage(doc=doc, project=project, repo_type=repo_type, stage=stage, changed_paths=changed_paths, checks=checks,
                                findings=findings, baseline=baseline, suppressions=suppressions, now=now, **gate_options)
    return {**receipt, "status": "evaluated", "appliedWaivers": len(suppressions)}
