"""Engine consumer of Control Center waiver requests (#603).

Library only. The Control Center appends audited requests to `waivers.jsonl`; the engine reads them here, checks each against the
effective quality policy (`quality_findings.suppression_problems`: only grantors the policy allows, a reason, an expiry within the policy
maximum, a named fingerprint or advisory, never blanket), and records one decision per request in `waiver-decisions.jsonl`. A valid request
becomes an operator-granted suppression with an exception receipt; an invalid one is rejected with the reasons. Requests already decided are
skipped, so running the inbox twice records nothing twice. Nothing here mutates candidate state; the stage gate reads the granted suppressions.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any

from scripts.release import quality_findings as qf

DECISIONS_SCHEMA = "waiver-decision/v1"


def _ts(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_rows(text: str, key: str) -> list[dict[str, Any]]:
    """JSON lines that carry a string `key`. One damaged line never hides the rest of the log."""
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


def to_suppression(req: dict[str, Any], *, receipt_id: str) -> dict[str, Any]:
    scope: dict[str, Any] = {"project": req.get("projectId"), "stages": req.get("stages") or []}
    if req.get("pathGlob"):
        scope["pathGlob"] = req["pathGlob"]
    sup: dict[str, Any] = {
        "scope": scope, "grantedByKind": req.get("reviewerKind"), "grantedBy": req.get("actor"),
        "grantedAt": _ts(req.get("at")), "expiresAt": _ts(req.get("expiresAt")), "reason": req.get("reason"), "receiptId": receipt_id,
    }
    if req.get("fingerprint"):
        sup["fingerprint"] = req["fingerprint"]
    if req.get("advisoryId"):
        sup["advisoryId"] = req["advisoryId"]
    return sup


def decide(req: dict[str, Any], *, policy_waivers: dict[str, Any], now: float) -> dict[str, Any]:
    """One decision. A request with an unreadable time or no expiry is rejected, never granted."""
    sup = to_suppression(req, receipt_id=f"exc-{req['id']}")
    problems: list[str] = []
    if sup["grantedAt"] is None:
        problems.append("the request has no readable time")
    if sup["expiresAt"] is None:
        problems.append("a waiver must expire")
    if not problems:
        problems = qf.suppression_problems(sup, policy_waivers, now=now)
    base = {"schemaVersion": DECISIONS_SCHEMA, "requestId": req["id"], "projectId": req.get("projectId"), "decidedAt": now}
    if problems:
        return {**base, "outcome": "rejected", "problems": problems}
    return {**base, "outcome": "granted", "problems": [], "suppression": sup, "receipt": qf.exception_receipt(sup)}


def process(requests_text: str, decided_text: str, *, policy_waivers: dict[str, Any], now: float | None = None) -> list[dict[str, Any]]:
    """Decisions for requests not yet decided, in log order. The caller appends them to `waiver-decisions.jsonl`."""
    now = time.time() if now is None else now
    done = {r["requestId"] for r in parse_rows(decided_text, "requestId")}
    out: list[dict[str, Any]] = []
    for req in parse_rows(requests_text, "id"):
        if req["id"] in done:
            continue
        done.add(req["id"])
        out.append(decide(req, policy_waivers=policy_waivers, now=now))
    return out


def active_suppressions(decided_text: str, *, project: str, now: float) -> list[dict[str, Any]]:
    """Granted, unexpired suppressions for one project: what the stage gate evaluates findings against."""
    return [d["suppression"] for d in parse_rows(decided_text, "requestId")
            if d.get("outcome") == "granted" and d.get("projectId") == project and isinstance(d.get("suppression"), dict)
            and now < (d["suppression"].get("expiresAt") or 0)]
