"""Candidate-scoped verification orchestration and evidence validity (#593).

Library only. It builds a manifest for one frozen candidate revision, decides whether recorded evidence is still valid
for that exact manifest, classifies results (infrastructure, known debt, flaky, genuine regression) with bounded
reruns, plans safe incremental revalidation, resumes failed shards, and checks that mixed-node runs used identical
inputs. Nothing runs tests: workers (local or the #213 distributed ones) do, and report into these structures.

Fail-closed throughout: a required suite with missing, stale, other-revision, unknown or error evidence does not pass.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

SHA = re.compile(r"^[0-9a-f]{40,64}$")
PASSING = ("pass", "passed")
INFRA_MARKERS = re.compile(r"(?i)(timed out|timeout|connection reset|econnreset|no space left|out of memory|oom|resource temporarily unavailable|node lost|worker (?:died|lost)|cannot allocate)")


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# ---- manifest ------------------------------------------------------------------------------------------------------
def build_manifest(*, candidate_id: str, revision: int, sha: str, suites: list[dict[str, Any]], config_hash: str, asset_hash: str,
                   env_hash: str, advisory_refresh: str | None = None) -> dict[str, Any]:
    """Freeze what must be verified. `suites` items: id, required, adapterVersion, selection (any JSON), optional
    mandatoryFull, advisoryBound, expiresAfterHours."""
    if not SHA.match(sha):
        raise ValueError("a candidate manifest needs a full commit SHA, not a branch name")
    ids = [s["id"] for s in suites]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate suite id")
    compiled = []
    for s in suites:
        compiled.append({"id": s["id"], "required": bool(s.get("required", False)), "adapterVersion": s["adapterVersion"],
                         "selectionHash": digest(s.get("selection", "all")), "mandatoryFull": bool(s.get("mandatoryFull", False)),
                         "advisoryBound": bool(s.get("advisoryBound", False)), "expiresAfterHours": s.get("expiresAfterHours")})
    body = {"candidateId": candidate_id, "revision": revision, "sha": sha, "suites": sorted(compiled, key=lambda x: x["id"]),
            "configHash": config_hash, "assetHash": asset_hash, "envHash": env_hash, "advisoryRefresh": advisory_refresh}
    return {**body, "manifestHash": digest(body)}


def evidence_record(manifest: dict[str, Any], suite_id: str, *, status: str, at: float, node: str = "local",
                    resources: dict[str, Any] | None = None, classification: str | None = None, attempts: int = 1) -> dict[str, Any]:
    """Evidence stamped with every dimension it is valid for. Immutable by convention: callers append, never edit."""
    suite = next(s for s in manifest["suites"] if s["id"] == suite_id)
    exp = suite["expiresAfterHours"]
    return {"suiteId": suite_id, "status": status, "classification": classification or status, "at": at, "node": node, "attempts": attempts,
            "expiresAt": at + exp * 3600 if exp else None, "resources": resources or {},
            "key": {"candidateId": manifest["candidateId"], "revision": manifest["revision"], "sha": manifest["sha"],
                    "adapterVersion": suite["adapterVersion"], "selectionHash": suite["selectionHash"], "configHash": manifest["configHash"],
                    "assetHash": manifest["assetHash"], "envHash": manifest["envHash"],
                    "advisoryRefresh": manifest["advisoryRefresh"] if suite["advisoryBound"] else None}}


def evidence_problems(ev: dict[str, Any], manifest: dict[str, Any], now: float) -> list[str]:
    """Why `ev` does not count for `manifest` (empty list means valid). Names every invalidated dimension."""
    suite = next((s for s in manifest["suites"] if s["id"] == ev["suiteId"]), None)
    if suite is None:
        return ["suite-not-in-manifest"]
    want = evidence_record(manifest, ev["suiteId"], status=ev["status"], at=ev["at"])["key"]
    reasons = [f"{k}-changed" if k != "advisoryRefresh" else "advisory-refreshed" for k, v in want.items() if ev["key"].get(k) != v]
    if ev["expiresAt"] is not None and now >= ev["expiresAt"]:
        reasons.append("expired")
    return reasons


def gate(manifest: dict[str, Any], evidence: list[dict[str, Any]], *, now: float, accept_known_debt: bool = False) -> dict[str, Any]:
    """Promotion eligibility from evidence alone. A required suite needs valid, passing evidence for this exact manifest."""
    suites: dict[str, Any] = {}
    for s in manifest["suites"]:
        mine = [e for e in evidence if e["suiteId"] == s["id"]]
        valid = [e for e in mine if not evidence_problems(e, manifest, now)]
        newest = max(valid, key=lambda e: e["at"], default=None)
        if newest is None:
            why = "no evidence" if not mine else "evidence invalid: " + ",".join(sorted({r for e in mine for r in evidence_problems(e, manifest, now)}))
            suites[s["id"]] = {"satisfied": False, "reason": why}
        elif newest["classification"] in PASSING or (accept_known_debt and newest["classification"] == "known-debt"):
            suites[s["id"]] = {"satisfied": True, "reason": newest["classification"]}
        else:
            suites[s["id"]] = {"satisfied": False, "reason": f"{newest['classification']} ({newest['status']})"}
    blocking = [i for i, r in suites.items() if not r["satisfied"] and next(x for x in manifest["suites"] if x["id"] == i)["required"]]
    return {"eligible": not blocking, "blocking": blocking, "suites": suites}


# ---- classification ------------------------------------------------------------------------------------------------
def classify(attempts: list[dict[str, Any]], *, known_debt: frozenset[str] = frozenset(), max_reruns: int = 2) -> dict[str, Any]:
    """Classify one suite's attempts (oldest first). Each attempt: {status: passed|failed|error, failures: [ids], log: str}.

    `unknown` is returned when reruns are exhausted without a determination, so it can never count as a pass."""
    if not attempts:
        return {"classification": "unknown", "rerun": True, "reason": "no attempts"}
    last = attempts[-1]
    if last["status"] == "passed":
        if all(a["status"] == "passed" for a in attempts):
            return {"classification": "passed", "rerun": False, "reason": "all attempts passed"}
        return {"classification": "flaky", "rerun": False, "reason": "failed then passed on rerun"}
    infra = last["status"] == "error" or (bool(INFRA_MARKERS.search(last.get("log", ""))) and not last.get("failures"))
    if infra:
        spent = len(attempts) > max_reruns
        return {"classification": "unknown" if spent else "infra-failure", "rerun": not spent,
                "reason": "infrastructure failure" + (" after bounded reruns" if spent else "")}
    failures = set(last.get("failures", []))
    if failures and failures <= known_debt:
        return {"classification": "known-debt", "rerun": False, "reason": "only recorded known failures"}
    if any(a["status"] == "passed" for a in attempts):
        return {"classification": "flaky", "rerun": False, "reason": "inconsistent across attempts"}
    # Consistent failure: rerun (bounded) to rule out flakiness, but it is never a pass in the meantime.
    return {"classification": "regression", "rerun": len(attempts) <= max_reruns, "reason": "genuine failure"}


# ---- incremental revalidation --------------------------------------------------------------------------------------
def plan_revalidation(previous: dict[str, Any], new: dict[str, Any], *, changed_paths: list[str], impact: dict[str, list[str]],
                      prior_evidence: list[dict[str, Any]], now: float) -> dict[str, dict[str, str]]:
    """Per suite: `run` or `reuse`. Reuse only when provably safe: same adapter, selection, config, assets, environment and
    advisory refresh; every changed path is covered by the impact map; none of them touches this suite; the suite is not
    marked mandatoryFull; and a passing prior result exists for the previous revision. Anything else runs in full."""
    plan: dict[str, dict[str, str]] = {}
    unmapped = [p for p in changed_paths if not any(_glob(p, g) for globs in impact.values() for g in globs)]
    for s in new["suites"]:
        old = next((x for x in previous["suites"] if x["id"] == s["id"]), None)
        why = None
        if s["mandatoryFull"]:
            why = "mandatory full regression is never skipped"
        elif old is None or old["adapterVersion"] != s["adapterVersion"] or old["selectionHash"] != s["selectionHash"]:
            why = "suite, adapter or selection changed"
        elif any(previous[k] != new[k] for k in ("configHash", "assetHash", "envHash")):
            why = "policy, asset or environment changed"
        elif s["advisoryBound"] and previous["advisoryRefresh"] != new["advisoryRefresh"]:
            why = "advisory data refreshed"
        elif unmapped:
            why = f"changed paths not covered by the impact map: {sorted(unmapped)[:3]}"
        elif any(_glob(p, g) for p in changed_paths for g in impact.get(s["id"], [])):
            why = "changed paths impact this suite"
        else:
            prev_ok = [e for e in prior_evidence if e["suiteId"] == s["id"] and not evidence_problems(e, previous, now) and e["classification"] in PASSING]
            if not prev_ok:
                why = "no valid passing prior result"
        plan[s["id"]] = {"action": "run", "reason": why} if why else {"action": "reuse", "reason": "provably unaffected"}
    return plan


def _glob(path: str, pattern: str) -> bool:
    import fnmatch
    return fnmatch.fnmatch(path, pattern)


# ---- shards and nodes ----------------------------------------------------------------------------------------------
def resume_plan(shards: list[str], completed: dict[str, dict[str, Any]], manifest: dict[str, Any], now: float) -> list[str]:
    """Shards still to run: missing, failed, or whose recorded pass is no longer valid for this manifest."""
    todo = []
    for sh in shards:
        ev = completed.get(sh)
        if ev is None or ev["classification"] not in PASSING or evidence_problems(ev, manifest, now):
            todo.append(sh)
    return todo


def assert_uniform(reports: list[dict[str, Any]]) -> list[str]:
    """Mixed-node runs must have used the same candidate SHA and pinned resources. Returns the differences."""
    problems = []
    for field in ("sha", "revision", "resourceDigest", "assetHash", "envHash"):
        values = {json.dumps(r.get(field)) for r in reports}
        if len(values) > 1:
            problems.append(f"{field} differs across nodes: {sorted(values)}")
    for r in reports:
        if r.get("checkout") in (None, "", "dev", "stable", "main", "HEAD") or not SHA.match(str(r.get("checkout", ""))):
            problems.append(f"node {r.get('node')} checked out a mutable ref {r.get('checkout')!r}, not the candidate SHA")
    return problems


class EvidenceCache:
    """Cache keyed by the immutable evidence key with explicit expiry."""

    def __init__(self) -> None:
        self._items: dict[str, tuple[float, dict[str, Any]]] = {}

    def put(self, ev: dict[str, Any], *, ttl_seconds: float, now: float) -> None:
        self._items[digest(ev["key"] | {"suiteId": ev["suiteId"]})] = (now + ttl_seconds, ev)

    def get(self, manifest: dict[str, Any], suite_id: str, *, now: float) -> dict[str, Any] | None:
        probe = evidence_record(manifest, suite_id, status="x", at=now)
        hit = self._items.get(digest(probe["key"] | {"suiteId": suite_id}))
        return hit[1] if hit and hit[0] > now else None
