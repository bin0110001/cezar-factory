"""Immutable regression snapshots and refs (#592).

A candidate is a frozen SHA behind an immutable `refs/rc/<id>/<rev>` reference, not a branch that keeps receiving
merges. Every ref write is a compare-and-swap (`git update-ref <ref> <new> <expected-old>`), never a force push, so an
unexpected writer or a racing process is detected and reported as a blocked state instead of being overwritten.

Library only. Git is reached through `Git`, which tests point at a temporary repository.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any

ZERO = "0" * 40
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
TERMINAL = ("promoted", "abandoned", "failed", "canceled")


class Git:
    def __init__(self, repo: str):
        self.repo = repo

    def run(self, *args: str, check: bool = True) -> str:
        p = subprocess.run(["git", "-C", self.repo, *args], capture_output=True, text=True, encoding="utf8")
        if check and p.returncode != 0:
            raise GitError(f"git {' '.join(args)} failed: {p.stderr.strip()}")
        return p.stdout.strip() if p.returncode == 0 else ""

    def rev(self, ref: str) -> str | None:
        p = subprocess.run(["git", "-C", self.repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}"], capture_output=True, text=True)
        return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None

    def ref_value(self, ref: str) -> str | None:
        p = subprocess.run(["git", "-C", self.repo, "rev-parse", "--verify", "--quiet", ref], capture_output=True, text=True)
        return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None

    def is_ancestor(self, ancestor: str, descendant: str) -> bool:
        return subprocess.run(["git", "-C", self.repo, "merge-base", "--is-ancestor", ancestor, descendant], capture_output=True).returncode == 0

    def cas(self, ref: str, new: str, expected_old: str | None) -> bool:
        """Compare-and-swap a ref. `expected_old=None` means the ref must not exist."""
        p = subprocess.run(["git", "-C", self.repo, "update-ref", ref, new, expected_old or ZERO], capture_output=True, text=True)
        return p.returncode == 0

    def delete(self, ref: str, expected_old: str) -> bool:
        return subprocess.run(["git", "-C", self.repo, "update-ref", "-d", ref, expected_old], capture_output=True, text=True).returncode == 0


class GitError(RuntimeError):
    pass


def candidate_ref(candidate_id: str, revision: int) -> str:
    if not _ID.match(candidate_id) or revision < 1:
        raise ValueError("unsafe candidate id or revision")
    return f"refs/rc/{candidate_id}/{revision}"


@dataclass
class Snapshot:
    ok: bool
    ref: str | None = None
    sha: str | None = None
    manifest: dict[str, Any] = field(default_factory=dict)
    blocked: str | None = None  # machine reason when not ok
    detail: str = ""
    pointer_moved: bool = False


def _blocked(reason: str, detail: str) -> Snapshot:
    return Snapshot(ok=False, blocked=reason, detail=detail)


def fingerprint(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def create_snapshot(git: Git, *, candidate_id: str, revision: int, dev_sha: str, base_stable_sha: str, config_hash: str,
                    fingerprints: dict[str, Any], regression_branch: str | None = None, expected_pointer: str | None = None,
                    allow_pointer_rewind: bool = False) -> Snapshot:
    """Freeze `dev_sha` as revision `revision` of the candidate.

    Refuses, with a reason, rather than repairing: an unknown or non-ancestral SHA, an immutable ref that already names a
    different SHA, or a regression branch that was moved by someone else since `expected_pointer`."""
    ref = candidate_ref(candidate_id, revision)
    if regression_branch is not None and not _BRANCH.match(regression_branch):
        raise ValueError("unsafe regression branch name")
    sha = git.rev(dev_sha)
    if sha is None or sha != dev_sha:  # a full SHA is required: a branch name or abbreviation is mutable or ambiguous
        return _blocked("unknown-sha", f"{dev_sha} is not a full commit SHA in this repository")
    base = git.rev(base_stable_sha)
    if base is None:
        return _blocked("unknown-base", f"stable base {base_stable_sha} is not a commit")
    if not git.is_ancestor(base, sha):
        return _blocked("diverged-stable", "stable base is not an ancestor of the dev SHA; promotion would not be a fast-forward")
    existing = git.ref_value(ref)
    if existing is not None and existing != sha:
        return _blocked("immutable-ref-conflict", f"{ref} already names {existing}")
    if existing is None and not git.cas(ref, sha, None):
        return _blocked("ref-race", f"could not create {ref}; another writer created it first")

    manifest = {"candidateId": candidate_id, "revision": revision, "ref": ref, "sha": sha, "devSha": sha, "baseStableSha": base,
                "configHash": config_hash, "fingerprints": fingerprints, "manifestHash": ""}
    manifest["manifestHash"] = fingerprint({k: v for k, v in manifest.items() if k != "manifestHash"})
    snap = Snapshot(ok=True, ref=ref, sha=sha, manifest=manifest)
    if regression_branch is None:
        return snap  # optional pointer is off, or legacy two-branch mode
    branch_ref = f"refs/heads/{regression_branch}"
    current = git.ref_value(branch_ref)
    if current != expected_pointer:
        return Snapshot(ok=False, ref=ref, sha=sha, manifest=manifest, blocked="writer-drift",
                        detail=f"{branch_ref} is {current} but {expected_pointer} was expected; refusing to overwrite")
    if current is not None and current != sha and not git.is_ancestor(current, sha) and not allow_pointer_rewind:
        return Snapshot(ok=False, ref=ref, sha=sha, manifest=manifest, blocked="non-fast-forward",
                        detail=f"moving {branch_ref} would not be a fast-forward; needs an explicit guarded rewind")
    if current != sha and not git.cas(branch_ref, sha, current):
        return Snapshot(ok=False, ref=ref, sha=sha, manifest=manifest, blocked="ref-race", detail=f"{branch_ref} changed during the move")
    snap.pointer_moved = current != sha
    return snap


def verify_snapshot(git: Git, ref: str, expected_sha: str) -> str:
    """`ok`, `ref-missing` (deleted: recover from the recorded SHA) or `ref-moved` (tampered: block)."""
    value = git.ref_value(ref)
    if value is None:
        return "ref-missing"
    return "ok" if value == expected_sha else "ref-moved"


def recover_missing_ref(git: Git, ref: str, expected_sha: str) -> bool:
    """Recreate a deleted immutable ref from the SHA recorded in durable state, if the object still exists."""
    if git.ref_value(ref) is not None or git.rev(expected_sha) != expected_sha:
        return False
    return git.cas(ref, expected_sha, None)


def derive_revision(git: Git, *, previous_sha: str, repair_sha: str) -> tuple[bool, str]:
    """A repair revision must descend from the current candidate with no merge commits, so the latest dev is never
    merged into an active candidate and the new SHA is strictly newer (sequential)."""
    if previous_sha == repair_sha:
        return False, "repair SHA equals the previous revision"
    if not git.is_ancestor(previous_sha, repair_sha):
        return False, "repair SHA does not descend from the current candidate"
    if git.run("rev-list", "--merges", f"{previous_sha}..{repair_sha}", check=False):
        return False, "repair range contains a merge commit; dev must not be merged into an active candidate"
    return True, "ok"


def provenance(snapshot_manifest: dict[str, Any], *, stable_branch: str, tested_sha: str) -> dict[str, Any]:
    """Promotion evidence tying stable to the exact tested SHA."""
    if snapshot_manifest["sha"] != tested_sha:
        raise ValueError("tested SHA differs from the snapshot SHA; evidence is for a different revision")
    return {"stableBranch": stable_branch, "promotedSha": tested_sha, "candidateRef": snapshot_manifest["ref"],
            "candidateId": snapshot_manifest["candidateId"], "revision": snapshot_manifest["revision"],
            "baseStableSha": snapshot_manifest["baseStableSha"], "configHash": snapshot_manifest["configHash"],
            "manifestHash": snapshot_manifest["manifestHash"]}


def cleanup(git: Git, *, candidate_id: str, state: str, revisions: list[dict[str, Any]], keep_final_if_promoted: bool = True) -> dict[str, Any]:
    """Delete a terminal candidate's immutable refs, returning an audit record of every ref and SHA first.

    Never deletes for a nonterminal candidate; the audit list is what the caller must persist before the refs go."""
    if state not in TERMINAL:
        raise ValueError(f"candidate is {state}; refs are cleaned only after a terminal state")
    audit = [{"ref": r["ref"], "sha": r["sha"], "revision": r["revision"]} for r in revisions]
    last = max((r["revision"] for r in revisions), default=None)
    deleted, kept, drifted = [], [], []
    for r in revisions:
        if keep_final_if_promoted and state == "promoted" and r["revision"] == last:
            kept.append(r["ref"])
            continue
        value = git.ref_value(r["ref"])
        if value is None:
            continue
        if value != r["sha"]:
            drifted.append(r["ref"])  # tampered: leave it for an operator rather than delete evidence
        elif git.delete(r["ref"], r["sha"]):
            deleted.append(r["ref"])
    return {"audit": audit, "deleted": deleted, "kept": kept, "drifted": drifted}
