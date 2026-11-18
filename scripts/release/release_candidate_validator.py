"""Candidate validation step for the release engine (#588).

Library only. For one candidate that is `validating` or `revalidating`, the lease owner calls `validate_candidate` with the test outcome for the
current revision and the quality inputs (check results, findings, baseline). It runs the `candidate` gate stage through `release_stage_runner` (so
operator pauses and granted waivers apply), records one immutable result for the current revision, and moves the candidate:

- tests passed and the gate allows it: result `passed`, candidate -> `ready`;
- anything else (a failed or incomplete test run, a blocking gate result): result `failed`, candidate -> `repair-required`.

It never reports green for a paused project: that returns `held` and records nothing, so the candidate stays where it is. Every write goes through
`CandidateStore` with the owner's fencing token, so a stale owner, an obsolete revision or an expired lease is refused. The result evidence is the gate's
redacted receipt, never raw scanner output. It does not promote, push or deploy.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
from typing import Any

from scripts.release import release_stage_runner as runner
from scripts.release.release_candidate_store import CandidateStore, StoreError

VALIDATING = ("validating", "revalidating")
TEST_STATUSES = ("passed", "failed", "no-tests", "unknown", "infrastructure-error")


def run_id_for(cid: str, revision: int, tests: str, receipt: dict[str, Any]) -> str:
    """Stable for the same inputs, so replaying a finished validation is refused by the store instead of recording a second verdict."""
    digest = hashlib.sha256(json.dumps({"tests": tests, "receipt": receipt}, sort_keys=True, default=str).encode()).hexdigest()[:12]
    return f"val-{cid}-r{revision}-{digest}"


def validate_candidate(store: CandidateStore, cid: str, *, owner: str, ttl: float, now: float, release_dir: pathlib.Path, policy_doc: dict[str, Any],
                       test_status: str, checks: dict[str, dict[str, Any]], findings: list[dict[str, Any]], baseline: list[dict[str, Any]],
                       repo_type: str | None = None, changed_paths: list[str] | None = None, **gate_options: Any) -> dict[str, Any]:
    if test_status not in TEST_STATUSES:
        raise StoreError(f"unknown test status {test_status!r}")
    cand = store.get(cid)
    if cand["state"] not in VALIDATING:
        raise StoreError(f"{cid} is {cand['state']}; only a validating or revalidating candidate can be validated")
    project = cand["project_id"]

    # An operator pause comes first: no lease is taken and nothing is recorded, so the candidate stays exactly as it was.
    if project in runner.paused(release_dir):
        return {"status": "held", "candidateId": cid, "reason": "an operator paused this project; nothing was validated or recorded"}

    fencing = store.acquire(cid, owner, now=now, ttl=ttl)
    cand = store.get(cid)
    receipt = runner.run_stage(release_dir, doc=policy_doc, project=project, repo_type=repo_type, stage="candidate", changed_paths=changed_paths or [],
                               checks=checks, findings=findings, baseline=baseline, now=now, **gate_options)
    green = test_status == "passed" and receipt.get("status") == "evaluated" and receipt.get("allowed") is True
    rid = run_id_for(cid, cand["revision"], test_status, receipt)
    store.record_result(cid, revision=cand["revision"], run_id=rid, status="passed" if green else "failed",
                        evidence={"tests": test_status, "gate": receipt}, fencing=fencing, now=now)
    moved = store.transition(cid, "ready" if green else "repair-required", fencing=fencing, version=cand["version"], now=now, actor=owner)
    return {"status": "ready" if green else "repair-required", "candidateId": cid, "revision": cand["revision"], "runId": rid, "state": moved["state"],
            "blockers": [] if green else _why(test_status, receipt)}


def _why(test_status: str, receipt: dict[str, Any]) -> list[str]:
    out = [] if test_status == "passed" else [f"tests: {test_status}"]
    out += [f"{b['category']}: {b['status']} ({b['why']})" for b in receipt.get("blockers") or []]
    if (receipt.get("findings") or {}).get("blocked"):
        out.append("a new or worsened finding blocks this stage")
    return out
