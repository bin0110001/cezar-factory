"""Engine consumer of Control Center operator actions (#634).

Library only. The Control Center appends audited, locally validated requests to `actions.jsonl`; the engine applies them here
against the durable candidate store, which is the authority: a request is checked again against the store, never trusted because the
service already looked at a snapshot. One decision per request is returned for `action-decisions.jsonl`, so a rerun applies nothing twice.

- `create`: asks the store for a candidate (`CandidateStore.request`, trigger `manual`, idempotent on the request id); a project that already has
  one gets the single pending request instead, exactly like any other trigger.
- `cancel` / `abandon`: ends the named active candidate through `CandidateStore.end`, which fences out the lease holder. Destructive, so the
  request must carry `confirmed`.
- `pause` / `resume` / `retry`: the store has no state for these and only the lease owner may move a candidate, so they are recorded as holds and
  markers that the owning worker reads (`paused_projects`, `retry_requests`); they are never applied by writing candidate state from here.

A request that names a candidate that is not the active one, a terminal candidate, or an action that does not fit the state is rejected with the
reason, never applied to a different candidate.
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable

from scripts.release.release_candidate_store import TERMINAL, CandidateStore, StoreError

DECISIONS_SCHEMA = "action-decision/v1"
ACTIONS = ("create", "pause", "resume", "cancel", "abandon", "retry")
DESTRUCTIVE = ("cancel", "abandon")
# What the engine needs to open a candidate: the project's current dev and stable SHAs and its bound configuration hash.
Context = Callable[[str], "dict[str, str] | None"]


def parse_rows(text: str, key: str) -> list[dict[str, Any]]:
    """JSON lines carrying a string `key`; one damaged line never hides the rest of a log."""
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and isinstance(row.get(key), str):
            rows.append(row)
    return rows


def _decision(req: dict[str, Any], outcome: str, now: float, **extra: Any) -> dict[str, Any]:
    return {"schemaVersion": DECISIONS_SCHEMA, "requestId": req["id"], "action": req.get("action"), "projectId": req.get("projectId"),
            "candidateId": req.get("candidateId"), "outcome": outcome, "decidedAt": now, **extra}


def _reject(req: dict[str, Any], now: float, why: str) -> dict[str, Any]:
    return _decision(req, "rejected", now, reason=why)


def apply(store: CandidateStore, req: dict[str, Any], *, context: Context, now: float) -> dict[str, Any]:
    action, project = req.get("action"), req.get("projectId")
    if action not in ACTIONS or not isinstance(project, str) or not project:
        return _reject(req, now, "unknown action or project")
    if action in DESTRUCTIVE and req.get("confirmed") is not True:
        return _reject(req, now, f"{action} is destructive and the request was not confirmed")
    active = store.active(project)

    if action == "create":
        ctx = context(project)
        if not ctx:
            return _reject(req, now, "the engine has no dev and stable SHAs for this project, so it cannot open a candidate")
        out = store.request(project, trigger="manual", reason=str(req.get("reason") or "operator request"), dev_sha=ctx["devSha"],
                            base_stable_sha=ctx["baseStableSha"], config_hash=ctx["configHash"], now=now, idempotency_key=f"action:{req['id']}")
        return _decision(req, "applied", now, result=out.get("result"), candidateId=out.get("candidateId") or out.get("activeCandidateId"))

    if action == "retry" and not active:
        last = store_last_failed(store, project)
        if not last:
            return _reject(req, now, "there is no active or failed candidate to retry")
        ctx = context(project)
        if not ctx:
            return _reject(req, now, "the engine has no dev and stable SHAs for this project, so it cannot retry")
        out = store.request(project, trigger="retry", reason=f"retry of {last}: {req.get('reason')}", dev_sha=ctx["devSha"],
                            base_stable_sha=ctx["baseStableSha"], config_hash=ctx["configHash"], now=now, idempotency_key=f"action:{req['id']}")
        return _decision(req, "applied", now, result=out.get("result"), candidateId=out.get("candidateId"))

    if not active:
        return _reject(req, now, f"{project} has no active candidate; terminal candidates cannot be changed")
    if req.get("candidateId") != active["id"]:
        return _reject(req, now, f"{req.get('candidateId')} is not the active candidate; the active one is {active['id']}")
    if active["state"] in TERMINAL:
        return _reject(req, now, f"{active['id']} is already {active['state']}")

    if action in DESTRUCTIVE:
        try:
            store.end(active["id"], "canceled" if action == "cancel" else "abandoned", actor="operator", reason=str(req.get("reason")), now=now)
        except StoreError as e:
            return _reject(req, now, str(e))
        return _decision(req, "applied", now, result="ended", to="canceled" if action == "cancel" else "abandoned")
    if action == "retry":
        if active["state"] != "repair-required":
            return _reject(req, now, f"only a candidate that needs repair can be retried; {active['id']} is {active['state']}")
        return _decision(req, "recorded", now, result="retry-marker", note="the lease owner re-validates; the engine never moves the candidate from here")
    return _decision(req, "recorded", now, result="hold" if action == "pause" else "release-hold",
                     note="the owning worker reads the hold; the candidate state is unchanged")


def store_last_failed(store: CandidateStore, project: str) -> str | None:
    """The most recent failed candidate for the project, from its audit log, or None."""
    last: str | None = None
    for row in store.audit_log(project):
        try:
            detail = json.loads(row.get("detail") or "{}")
        except ValueError:
            continue
        if row.get("event") in ("end", "transition") and isinstance(detail, dict) and detail.get("to") == "failed" and row.get("candidate_id"):
            last = str(row["candidate_id"])
    return last


def process(store: CandidateStore, requests_text: str, decided_text: str, *, context: Context, now: float | None = None) -> list[dict[str, Any]]:
    """Decisions for requests not yet decided, oldest first. The caller appends them to `action-decisions.jsonl`."""
    now = time.time() if now is None else now
    done = {r["requestId"] for r in parse_rows(decided_text, "requestId")}
    out: list[dict[str, Any]] = []
    for req in sorted(parse_rows(requests_text, "id"), key=lambda r: str(r.get("at"))):
        if req["id"] in done:
            continue
        done.add(req["id"])
        out.append(apply(store, req, context=context, now=now))
    return out


def paused_projects(decided_text: str) -> set[str]:
    """Projects whose latest recorded pause/resume is a pause. A worker that sees its project here must not start new work."""
    state: dict[str, bool] = {}
    for d in parse_rows(decided_text, "requestId"):
        if d.get("outcome") == "recorded" and d.get("action") in ("pause", "resume") and isinstance(d.get("projectId"), str):
            state[d["projectId"]] = d["action"] == "pause"
    return {p for p, paused in state.items() if paused}


def retry_requests(decided_text: str, *, handled: set[str] | None = None) -> list[dict[str, Any]]:
    """Retry markers the lease owner has not yet handled."""
    seen = handled or set()
    return [d for d in parse_rows(decided_text, "requestId") if d.get("outcome") == "recorded" and d.get("action") == "retry" and d["requestId"] not in seen]
