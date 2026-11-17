"""Shadow (dry-run) candidate selection and effective schedule reporting (#641).

Library only. Given a project's release-pipeline configuration and its current state, it computes what the new engine WOULD do
(trigger decisions, no-change suppression, admission, the next schedule ticks, whether a new candidate or only a pending request
would result) and returns a deterministic receipt. It reads state but never writes: no refs move, no candidate is created, no
store row changes. The one-active-candidate rule is respected because an active candidate turns every would-be request into a
would-be pending request.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from scripts.release import release_pipeline_config as cfg
from scripts.release import release_triggers as rt

RECEIPT_VERSION = "release-shadow-receipt/v1"
UTC = timezone.utc


def _iso(ts: float | datetime) -> str:
    dt = ts if isinstance(ts, datetime) else datetime.fromtimestamp(ts, UTC)
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def next_ticks(schedule: dict[str, Any] | None, now: datetime, count: int = 3, horizon_days: int = 40) -> list[str]:
    """The next `count` calendar ticks after `now` (UTC ISO strings). Empty when no schedule is configured."""
    if not schedule:
        return []
    ticks = rt.occurrences(schedule, now, now + timedelta(days=horizon_days))
    return [_iso(t) for t in ticks[:count]]


def shadow_run(*, doc: dict[str, Any], project: str, now: datetime, dev: rt.DevState, last_schedule_fired: float | None,
               active_candidate: dict[str, Any] | None, pending_count: int = 0, manual_request: str | None = None,
               capacity_available: bool = True, fast_checks_passed: bool = True, ref_reachable: bool = True, queue_empty: bool = True) -> dict[str, Any]:
    """Compute the receipt. `active_candidate` and `pending_count` come from a read-only view of the candidate store."""
    spec = cfg.effective_config(doc, project)
    spec_hash = cfg.config_hash(spec)
    triggers = spec["triggers"]
    tz = (triggers.get("schedule") or {}).get("timezone", "UTC")
    decisions = rt.evaluate(triggers, project=project, now=now, dev=dev, last_schedule_fired=last_schedule_fired, manual_request=manual_request, default_tz=tz)
    admission = rt.admission(fast_checks_passed=fast_checks_passed, capacity_available=capacity_available, ref_reachable=ref_reachable,
                             queue_empty=queue_empty, require_empty_queue=False)

    requests = [d for d in decisions if d.action == "request"]
    suppressed = [d for d in decisions if d.action == "skip"]
    deferred = [d for d in decisions if d.action == "defer"]
    if not requests:
        outcome = "no-request"
    elif active_candidate is not None:
        outcome = "pending-request"  # one active candidate per project: everything folds into one pending request
    elif admission.action != "request":
        outcome = "admission-deferred"
    else:
        outcome = "would-create-candidate"

    body = {
        "schemaVersion": RECEIPT_VERSION, "project": project, "evaluatedAt": _iso(now), "mode": spec["mode"], "effectiveConfigHash": spec_hash,
        "stages": [{"id": s["id"], "branch": s["branch"], "kind": s["kind"]} for s in spec["stages"]],
        "devSha": dev.dev_sha, "lastAcceptedSha": dev.last_accepted_sha,
        "noChangeSuppressed": dev.last_accepted_sha is not None and dev.dev_sha == dev.last_accepted_sha,
        "decisions": [{"trigger": d.trigger, "action": d.action, "reasons": d.reasons, "idempotencyKey": d.idempotency_key,
                       "occurrence": _iso(d.occurrence) if d.occurrence else None, "retryAt": _iso(d.retry_at) if d.retry_at else None} for d in decisions],
        "admission": {"action": admission.action, "reasons": admission.reasons},
        "activeCandidate": {"id": active_candidate["id"], "state": active_candidate["state"]} if active_candidate else None,
        "pendingRequests": pending_count + (len(requests) if active_candidate is not None else 0),
        "outcome": outcome,
        "nextScheduledTicks": next_ticks(triggers.get("schedule"), now),
        "counts": {"requests": len(requests), "skipped": len(suppressed), "deferred": len(deferred)},
        "mutations": [],  # by construction: a shadow run writes nothing
    }
    body["receiptDigest"] = "sha256:" + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    return body
