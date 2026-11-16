#!/usr/bin/env python3
"""Immutable regression candidate snapshots and guarded refs (#592).

A candidate is a frozen record, not a continuously merged branch: the verified merged dev SHA, the
stable base, the effective policy digest and artifact/asset/env fingerprints are captured once, an
immutable ``rc/<id>/<rev>`` tag is created, and the optional regression branch pointer moves only at
guarded transitions. Dev keeps advancing underneath; nothing here ever merges it into a candidate.

Every ref write is a compare-and-swap (``git update-ref <ref> <new> <expected-old>``). Unexpected
writers, deleted refs and races return a ``blocked`` result naming expected vs observed SHAs and write
nothing. Policy and candidate identity are injected so the config (#589) and state machine (#590)
contracts can be adapted in later. Candidate context is exported as data for the #199 merge
coordinator; this module has no PR merger, queue, lock or promotion.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ZERO = "0" * 40
SCHEMA_VERSION = 1
TERMINAL_STATES = ("promoted", "rejected", "abandoned", "superseded", "failed")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DEFAULT_POLICY: dict[str, Any] = {
    "branches": {"dev": "dev", "stable": "stable", "regression": "regression"},
    "regressionPointer": True,
    "legacyTwoBranchMode": False,
    "protectedRefs": [],
    "rcPrefix": "rc",
    "retentionSeconds": 7 * 86400,
    "auditRetentionSeconds": 90 * 86400,
}


class SnapshotError(RuntimeError):
    pass


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def fingerprint_files(paths: list[str | Path], root: Path | None = None) -> dict[str, str]:
    """Content fingerprint per file (sorted, relative to ``root`` when given); missing files hash as ``missing``."""
    out: dict[str, str] = {}
    for item in sorted(str(p) for p in paths):
        path = Path(item)
        if root is not None and not path.is_absolute():
            path = root / path
        out[item] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
    return out


def normalize_policy(raw: dict[str, Any] | None) -> dict[str, Any]:
    policy = json.loads(json.dumps(DEFAULT_POLICY))
    raw = raw or {}
    if not isinstance(raw, dict):
        raise SnapshotError("policy must be an object")
    for key, value in raw.items():
        if key == "branches":
            if not isinstance(value, dict):
                raise SnapshotError("policy.branches must be an object")
            policy["branches"].update({k: v for k, v in value.items() if v is None or isinstance(v, str)})
        elif key in policy:
            policy[key] = value
    if not isinstance(policy["protectedRefs"], list):
        raise SnapshotError("policy.protectedRefs must be a list")
    for key in ("retentionSeconds", "auditRetentionSeconds"):
        if isinstance(policy[key], bool) or not isinstance(policy[key], int) or policy[key] < 0:
            raise SnapshotError(f"policy.{key} must be a non-negative integer")
    if not policy["rcPrefix"] or "/" in policy["rcPrefix"].strip("/"):
        raise SnapshotError("policy.rcPrefix must be a single path segment")
    policy["rcPrefix"] = policy["rcPrefix"].strip("/")
    if policy["branches"].get("regression") is None:
        policy["regressionPointer"] = False
    return policy


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise SnapshotError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc


def resolve(repo: Path, ref: str) -> str | None:
    proc = _git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else None


def _is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    return _git(repo, "merge-base", "--is-ancestor", ancestor, descendant, check=False).returncode == 0


def _cas(repo: Path, ref: str, new: str | None, expected: str | None) -> bool:
    """Compare-and-swap a ref. ``new=None`` deletes; ``expected=None`` requires the ref to be absent."""
    old = ZERO if expected is None else expected
    args = ["update-ref", "-d", ref, old] if new is None else ["update-ref", ref, new, old]
    return _git(repo, *args, check=False).returncode == 0


def blocked(reason: str, **detail: Any) -> dict[str, Any]:
    return {"status": "blocked", "reason": reason, **detail}


def _check_id(candidate_id: str) -> None:
    if not isinstance(candidate_id, str) or not ID_RE.match(candidate_id) or ".." in candidate_id:
        raise SnapshotError(f"invalid candidate id: {candidate_id!r}")


def rc_ref(policy: dict[str, Any], candidate_id: str, rev: int) -> str:
    _check_id(candidate_id)
    return f"refs/tags/{policy['rcPrefix']}/{candidate_id}/{rev}"


def branch_ref(name: str) -> str:
    return name if name.startswith("refs/") else f"refs/heads/{name}"


def is_protected(policy: dict[str, Any], ref: str) -> bool:
    short = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
    if ref.startswith("refs/tags/" + policy["rcPrefix"] + "/") or short.startswith(policy["rcPrefix"] + "/"):
        return True
    names = [policy["branches"].get("dev"), policy["branches"].get("stable")]
    patterns = [n for n in names if n] + list(policy["protectedRefs"])
    return any(fnmatch.fnmatchcase(short, p) or fnmatch.fnmatchcase(ref, p) for p in patterns)


def record_path(store: Path, candidate_id: str, rev: int) -> Path:
    _check_id(candidate_id)
    return Path(store) / "candidates" / candidate_id / f"{rev}.json"


def _write_new(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "x", encoding="utf-8") as handle:  # exclusive: records are never overwritten
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def _seal(record: dict[str, Any]) -> dict[str, Any]:
    body = {k: v for k, v in record.items() if k != "recordDigest"}
    return {**body, "recordDigest": digest(body)}


def load_record(store: Path, candidate_id: str, rev: int) -> dict[str, Any]:
    path = record_path(store, candidate_id, rev)
    if not path.is_file():
        raise SnapshotError(f"snapshot record missing: {path}")
    record = json.loads(path.read_text(encoding="utf-8"))
    if _seal({k: v for k, v in record.items() if k != "recordDigest"})["recordDigest"] != record.get("recordDigest"):
        raise SnapshotError(f"snapshot record digest mismatch: {path}")
    return record


def create_snapshot(repo: Path, store: Path, candidate_id: str, dev_sha: str, policy: dict[str, Any] | None = None,
                    fingerprints: dict[str, Any] | None = None, evidence: dict[str, str] | None = None,
                    now: float | None = None) -> dict[str, Any]:
    """Freeze revision 1: verify the dev SHA is merged, record it, create the immutable rc tag."""
    policy = normalize_policy(policy)
    repo = Path(repo)
    _check_id(candidate_id)
    sha = resolve(repo, dev_sha)
    if not sha:
        return blocked("unknown-sha", sha=dev_sha)
    dev_name = policy["branches"]["dev"]
    dev_tip = resolve(repo, branch_ref(dev_name))
    if not dev_tip or not _is_ancestor(repo, sha, dev_tip):
        return blocked("sha-not-merged-to-dev", sha=sha, devTip=dev_tip)
    stable_base = resolve(repo, branch_ref(policy["branches"]["stable"]))
    return _freeze(repo, Path(store), policy, candidate_id, 1, None, sha, stable_base, fingerprints, evidence, now, [])


def _freeze(repo: Path, store: Path, policy: dict[str, Any], candidate_id: str, rev: int, parent_rev: int | None,
            sha: str, stable_base: str | None, fingerprints: Any, evidence: Any, now: float | None,
            invalidates: list[dict[str, Any]]) -> dict[str, Any]:
    record = _seal({
        "schemaVersion": SCHEMA_VERSION, "candidateId": candidate_id, "rev": rev, "parentRev": parent_rev,
        "sha": sha, "stableBase": stable_base, "policyDigest": digest(policy), "policy": policy,
        "fingerprints": dict(sorted((fingerprints or {}).items())),
        "evidence": dict(sorted((evidence or {}).items())),
        "invalidates": invalidates, "createdAt": time.time() if now is None else now,
        "rcRef": None if policy["legacyTwoBranchMode"] else rc_ref(policy, candidate_id, rev),
    })
    path = record_path(store, candidate_id, rev)
    if path.exists():
        return blocked("record-exists", path=str(path))
    ref = record["rcRef"]
    if ref:
        existing = resolve(repo, ref)
        if existing is not None:
            return blocked("rc-ref-exists", ref=ref, expected=None, observed=existing)
        if not _cas(repo, ref, sha, None):
            return blocked("rc-ref-race", ref=ref, expected=None, observed=resolve(repo, ref))
    try:
        _write_new(path, record)
    except FileExistsError:
        return blocked("record-exists", path=str(path))
    return {"status": "created", "record": record, "recordPath": str(path)}


def verify_snapshot(repo: Path, store: Path, candidate_id: str, rev: int) -> dict[str, Any]:
    """Detect a deleted, moved or tampered snapshot. Never repairs anything: reports the recovery needed."""
    try:
        record = load_record(store, candidate_id, rev)
    except (SnapshotError, json.JSONDecodeError) as exc:
        return blocked("record-invalid", detail=str(exc), recovery="restore the snapshot record from backup; do not recreate it")
    ref = record.get("rcRef")
    if not ref:
        return {"status": "ok", "record": record, "legacy": True}
    observed = resolve(Path(repo), ref)
    if observed is None:
        return blocked("rc-ref-deleted", ref=ref, expected=record["sha"], observed=None,
                       recovery=f"recreate {ref} at {record['sha']} with a CAS create after review")
    if observed != record["sha"]:
        return blocked("rc-ref-drift", ref=ref, expected=record["sha"], observed=observed,
                       recovery="investigate the unexpected writer; rc refs are immutable and were not touched")
    return {"status": "ok", "record": record}


def move_pointer(repo: Path, policy: dict[str, Any] | None, new_sha: str, expected_old: str | None,
                 force_with_lease: bool = False) -> dict[str, Any]:
    """Move the regression branch pointer at a guarded transition. Create or fast-forward unless explicitly leased."""
    policy = normalize_policy(policy)
    repo = Path(repo)
    if policy["legacyTwoBranchMode"]:
        return {"status": "skipped", "reason": "legacy-two-branch-mode"}
    if not policy["regressionPointer"]:
        return {"status": "skipped", "reason": "regression-pointer-disabled"}
    ref = branch_ref(policy["branches"]["regression"])
    if is_protected(policy, ref):
        return blocked("protected-ref", ref=ref)
    target = resolve(repo, new_sha)
    if not target:
        return blocked("unknown-sha", sha=new_sha)
    observed = resolve(repo, ref)
    if observed != expected_old:
        return blocked("pointer-drift" if observed else "pointer-deleted", ref=ref, expected=expected_old, observed=observed,
                       recovery="an unexpected writer changed the pointer; re-read it and retry the transition with the observed SHA")
    if observed == target:
        return {"status": "unchanged", "ref": ref, "sha": target}
    if observed is not None and not _is_ancestor(repo, observed, target) and not force_with_lease:
        return blocked("non-fast-forward", ref=ref, expected=expected_old, observed=observed, target=target)
    if not _cas(repo, ref, target, observed):
        return blocked("pointer-race", ref=ref, expected=observed, observed=resolve(repo, ref))
    return {"status": "moved", "ref": ref, "from": observed, "sha": target,
            "mode": "create" if observed is None else ("force-with-lease" if not _is_ancestor(repo, observed, target) else "fast-forward")}


def build_revision(repo: Path, store: Path, candidate_id: str, repair_sha: str, policy: dict[str, Any] | None = None,
                   fingerprints: dict[str, Any] | None = None, now: float | None = None) -> dict[str, Any]:
    """Targeted repair: derive revision N+1 from the current candidate. Latest dev is never merged in."""
    policy = normalize_policy(policy)
    repo, store = Path(repo), Path(store)
    _check_id(candidate_id)
    folder = store / "candidates" / candidate_id
    revs = sorted(int(p.stem) for p in folder.glob("*.json") if p.stem.isdigit()) if folder.is_dir() else []
    if not revs:
        return blocked("no-current-candidate", candidateId=candidate_id)
    prior = load_record(store, candidate_id, revs[-1])
    sha = resolve(repo, repair_sha)
    if not sha:
        return blocked("unknown-sha", sha=repair_sha)
    if sha == prior["sha"] or not _is_ancestor(repo, prior["sha"], sha):
        return blocked("not-derived-from-candidate", expected=prior["sha"], observed=sha)
    dev_tip = resolve(repo, branch_ref(policy["branches"]["dev"]))
    if dev_tip:
        new_commits = _git(repo, "rev-list", f"{prior['sha']}..{sha}").stdout.split()
        advanced = set(_git(repo, "rev-list", f"{prior['sha']}..{dev_tip}").stdout.split())
        merged_dev = sorted(set(new_commits) & advanced)
        if merged_dev:
            return blocked("repair-contains-dev-commits", commits=merged_dev[:10])
    rev = prior["rev"] + 1
    marker = {"candidateId": candidate_id, "rev": prior["rev"], "sha": prior["sha"], "reason": "superseded-by-repair",
              "evidence": prior["evidence"], "invalidatedAt": time.time() if now is None else now}
    result = _freeze(repo, store, policy, candidate_id, rev, prior["rev"], sha, prior["stableBase"],
                     fingerprints if fingerprints is not None else prior["fingerprints"], {}, now, [marker])
    if result["status"] == "created":
        mark = record_path(store, candidate_id, prior["rev"]).with_suffix(".invalidated.json")
        if not mark.exists():
            _write_new(mark, marker)
    return result


def retention_cleanup(repo: Path, store: Path, candidate_id: str, rev: int, terminal_state: str | None,
                      terminal_at: float | None, policy: dict[str, Any] | None = None, now: float | None = None,
                      dry_run: bool = False) -> dict[str, Any]:
    """Delete the regression pointer after ``retentionSeconds`` and the rc tag after ``auditRetentionSeconds``.

    Only for a terminal candidate with an intact snapshot record. The record itself is never deleted.
    Every deletion (or dry-run plan) is appended to ``cleanup.jsonl``.
    """
    policy = normalize_policy(policy)
    repo, store = Path(repo), Path(store)
    now = time.time() if now is None else now
    if terminal_state not in TERMINAL_STATES or terminal_at is None:
        return blocked("not-terminal", state=terminal_state)
    try:
        record = load_record(store, candidate_id, rev)
    except (SnapshotError, json.JSONDecodeError) as exc:
        return blocked("record-invalid", detail=str(exc))
    age = now - terminal_at
    actions: list[dict[str, Any]] = []
    pointer = policy["branches"].get("regression")
    if policy["regressionPointer"] and not policy["legacyTwoBranchMode"] and pointer and age >= policy["retentionSeconds"]:
        ref = branch_ref(pointer)
        observed = resolve(repo, ref)
        if observed == record["sha"] and not is_protected(policy, ref):
            actions.append({"ref": ref, "sha": observed, "kind": "pointer"})
    if record.get("rcRef") and age >= max(policy["auditRetentionSeconds"], policy["retentionSeconds"]):
        observed = resolve(repo, record["rcRef"])
        if observed == record["sha"]:
            actions.append({"ref": record["rcRef"], "sha": observed, "kind": "rc-tag"})
    done: list[dict[str, Any]] = []
    for action in actions:
        ok = True if dry_run else _cas(repo, action["ref"], None, action["sha"])
        entry = {**action, "candidateId": candidate_id, "rev": rev, "state": terminal_state, "at": now,
                 "dryRun": dry_run, "deleted": ok and not dry_run, "recordDigest": record["recordDigest"]}
        store.mkdir(parents=True, exist_ok=True)
        with open(store / "cleanup.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps(entry, sort_keys=True) + "\n")
        done.append(entry)
    return {"status": "dry-run" if dry_run else "cleaned" if done else "nothing-to-clean", "actions": done}


def candidate_context(record: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    """Data for the #199 merge coordinator: where dev may merge and what the candidate pins. No queue, no merger."""
    policy = normalize_policy(policy or record.get("policy"))
    return {"schemaVersion": SCHEMA_VERSION, "candidateId": record["candidateId"], "rev": record["rev"],
            "sha": record["sha"], "stableBase": record["stableBase"], "rcRef": record.get("rcRef"),
            "devBranch": policy["branches"]["dev"], "devMergeBlocked": False,
            "policyDigest": record["policyDigest"], "recordDigest": record["recordDigest"]}


def promotion_provenance(repo: Path, record: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    """Whether stable can fast-forward to the exact tested SHA, plus the provenance to record. Moves nothing."""
    policy = normalize_policy(policy or record.get("policy"))
    stable = resolve(Path(repo), branch_ref(policy["branches"]["stable"]))
    sha = record["sha"]
    if stable is not None and stable != sha and not _is_ancestor(Path(repo), stable, sha):
        return blocked("stable-not-ancestor", expected=stable, observed=sha,
                       recovery="stable moved off the candidate base; build a new revision, do not merge")
    evidence = dict(record["evidence"])
    return {"status": "ready", "fastForwardFrom": stable, "to": sha, "provenance": {
        "snapshotId": f"{record['candidateId']}/{record['rev']}", "rev": record["rev"], "sha": sha,
        "recordDigest": record["recordDigest"], "evidenceDigests": evidence, "evidenceDigest": digest(evidence)}}


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".")
    parser.add_argument("--store", required=True)
    parser.add_argument("--policy", help="path to a policy JSON file")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot"); s.add_argument("--id", required=True); s.add_argument("--sha", required=True)
    s.add_argument("--fingerprints"); s.add_argument("--evidence")
    m = sub.add_parser("move-pointer"); m.add_argument("--sha", required=True); m.add_argument("--expected-old"); m.add_argument("--force-with-lease", action="store_true")
    r = sub.add_parser("revise"); r.add_argument("--id", required=True); r.add_argument("--sha", required=True)
    c = sub.add_parser("cleanup"); c.add_argument("--id", required=True); c.add_argument("--rev", type=int, required=True)
    c.add_argument("--state"); c.add_argument("--terminal-at", type=float); c.add_argument("--dry-run", action="store_true")
    x = sub.add_parser("context"); x.add_argument("--id", required=True); x.add_argument("--rev", type=int, required=True)
    p = sub.add_parser("provenance"); p.add_argument("--id", required=True); p.add_argument("--rev", type=int, required=True)
    v = sub.add_parser("verify"); v.add_argument("--id", required=True); v.add_argument("--rev", type=int, required=True)
    a = parser.parse_args(argv)
    repo, store = Path(a.repo), Path(a.store)
    policy = json.loads(Path(a.policy).read_text()) if a.policy else None
    load = lambda text: json.loads(Path(text).read_text()) if text else None  # noqa: E731
    try:
        if a.cmd == "snapshot":
            out = create_snapshot(repo, store, a.id, a.sha, policy, load(a.fingerprints), load(a.evidence))
        elif a.cmd == "move-pointer":
            out = move_pointer(repo, policy, a.sha, a.expected_old, a.force_with_lease)
        elif a.cmd == "revise":
            out = build_revision(repo, store, a.id, a.sha, policy)
        elif a.cmd == "cleanup":
            out = retention_cleanup(repo, store, a.id, a.rev, a.state, a.terminal_at, policy, dry_run=a.dry_run)
        elif a.cmd == "verify":
            out = verify_snapshot(repo, store, a.id, a.rev)
        elif a.cmd == "context":
            out = candidate_context(load_record(store, a.id, a.rev), policy)
        else:
            out = promotion_provenance(repo, load_record(store, a.id, a.rev), policy)
    except (SnapshotError, json.JSONDecodeError, OSError) as exc:
        out = blocked("error", detail=str(exc))
    print(json.dumps(out, indent=2, sort_keys=True))
    return 2 if out.get("status") == "blocked" else 0


if __name__ == "__main__":
    sys.exit(_main())
