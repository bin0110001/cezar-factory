#!/usr/bin/env python3
"""One run of the release-engine inbox step (#603, #634): apply Control Center waiver requests and operator actions.

Runs on the host, from a systemd oneshot (`integrations/bazzite/factory-release-inbox.service`). The Control Center appends audited requests to
`<release-dir>/waivers.jsonl` and `<release-dir>/actions.jsonl`; this step decides each request not yet decided and appends one decision per request to
`waiver-decisions.jsonl` and `action-decisions.jsonl`, using `release_waiver_inbox` and `release_action_inbox`. It writes `holds.json` (projects paused by an
operator, for the owning worker). It never fetches, pushes, promotes, or edits a candidate except through `CandidateStore.request` and `CandidateStore.end`.

Safe to run any number of times: a decided request is never decided again. A missing request file means nothing to do; a missing or unreadable ref or policy
rejects only the requests that need it, with the reason, and never guesses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from scripts.release import quality_gate_policy as qg  # noqa: E402
from scripts.release import release_action_inbox as actions  # noqa: E402
from scripts.release import release_pipeline_config as rpc  # noqa: E402
from scripts.release import release_waiver_inbox as waivers  # noqa: E402
from scripts.release.release_candidate_store import CandidateStore  # noqa: E402


def _read(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf8")
    except FileNotFoundError:
        return ""


def _append(path: pathlib.Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows).encode("utf8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_atomic(path: pathlib.Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf8")
    os.replace(tmp, path)


def _git_ref(repo: pathlib.Path, ref: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", ref + "^{commit}"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    return sha if out.returncode == 0 and len(sha) == 40 else None


def make_context(repo: pathlib.Path, remote: str, policy_doc: dict[str, Any]):
    """The engine's view of a project: its dev and stable SHAs from the already-fetched remote refs, and the hash of its effective pipeline configuration."""
    def context(project: str) -> dict[str, str] | None:
        dev, stable = _git_ref(repo, f"refs/remotes/{remote}/dev"), _git_ref(repo, f"refs/remotes/{remote}/stable")
        if not dev or not stable:
            return None
        try:
            spec = rpc.effective_config(policy_doc, project)
        except Exception:  # an invalid document must not open a candidate bound to a guess
            return None
        return {"devSha": dev, "baseStableSha": stable, "configHash": rpc.config_hash(spec)}
    return context


def run(release_dir: pathlib.Path, store_path: pathlib.Path, repo: pathlib.Path, quality_policy: pathlib.Path, *, remote: str = "origin", now: float | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    summary: dict[str, Any] = {"waivers": {"granted": 0, "rejected": 0}, "actions": {"applied": 0, "recorded": 0, "rejected": 0}}

    # Waivers: each request is decided against the policy that applies to its project.
    wtext, wdone = _read(release_dir / "waivers.jsonl"), _read(release_dir / "waiver-decisions.jsonl")
    if wtext:
        try:
            qdoc = json.loads(quality_policy.read_text(encoding="utf8"))
            qg.load(qdoc)
        except (OSError, ValueError, qg.PolicyError) as e:
            qdoc, summary["waivers"]["error"] = None, f"quality policy unreadable: {e}"
        decided = {r["requestId"] for r in waivers.parse_rows(wdone, "requestId")}
        out = []
        for req in waivers.parse_rows(wtext, "id"):
            if req["id"] in decided:
                continue
            decided.add(req["id"])
            if qdoc is None:
                continue  # left undecided so the next run, with a readable policy, decides it
            pw = qg.effective(qdoc, project=req.get("projectId"), repo_type=None).get("waivers") or {}
            out.append(waivers.decide(req, policy_waivers=pw, now=now))
        _append(release_dir / "waiver-decisions.jsonl", out)
        for d in out:
            summary["waivers"]["granted" if d["outcome"] == "granted" else "rejected"] += 1

    # Operator actions, applied against the durable store.
    atext, adone = _read(release_dir / "actions.jsonl"), _read(release_dir / "action-decisions.jsonl")
    if atext:
        try:
            # No saved policy means the built-in defaults, as in the Control Center; a saved but invalid one rejects, it is never guessed.
            policy_doc = json.loads(_read(release_dir / "pipeline-policy.json") or json.dumps({"schemaVersion": rpc.SCHEMA_VERSION, "defaults": {}, "projects": {}}))
        except ValueError:
            policy_doc = {}
        store_path.parent.mkdir(parents=True, exist_ok=True)
        out = actions.process(CandidateStore(str(store_path)), atext, adone, context=make_context(repo, remote, policy_doc if isinstance(policy_doc, dict) else {}), now=now)
        _append(release_dir / "action-decisions.jsonl", out)
        for d in out:
            summary["actions"][d["outcome"]] += 1

    holds = sorted(actions.paused_projects(_read(release_dir / "action-decisions.jsonl")))
    release_dir.mkdir(parents=True, exist_ok=True)
    _write_atomic(release_dir / "holds.json", json.dumps({"schemaVersion": 1, "paused": holds, "digest": "sha256:" + hashlib.sha256(json.dumps(holds).encode()).hexdigest()}, sort_keys=True))
    summary["paused"] = holds
    return summary


def granted_suppressions(release_dir: pathlib.Path, project: str, *, now: float | None = None) -> list[dict[str, Any]]:
    """The unexpired operator-granted waivers for a project: pass these as `suppressions` to `quality_stage_gate.evaluate_stage`."""
    return waivers.active_suppressions(_read(release_dir / "waiver-decisions.jsonl"), project=project, now=time.time() if now is None else now)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--release-dir", required=True, type=pathlib.Path, help="directory holding the Control Center files (CEZ_HOME/release)")
    p.add_argument("--store", required=True, type=pathlib.Path, help="the SQLite candidate store file")
    p.add_argument("--repo", required=True, type=pathlib.Path, help="the Factory checkout whose remote dev and stable refs give the SHAs")
    p.add_argument("--quality-policy", type=pathlib.Path, help="quality gate policy (default: policies/quality-gates.json in --repo)")
    p.add_argument("--remote", default="origin")
    a = p.parse_args(argv)
    result = run(a.release_dir, a.store, a.repo, a.quality_policy or a.repo / "policies" / "quality-gates.json", remote=a.remote)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
