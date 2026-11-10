#!/usr/bin/env python3
"""Bounded, host-local diagnosis and escalation for release incidents."""
from __future__ import annotations

import argparse
import contextlib
import json
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.release.factory_release_controller import ControllerError, exclusive_lock

MAX_INCIDENTS = 50
MAX_REPORT_CHARS = 24000


def diagnose(database: pathlib.Path, limit: int = MAX_INCIDENTS) -> dict:
    if not 1 <= limit <= MAX_INCIDENTS:
        raise ValueError(f"limit must be from 1 to {MAX_INCIDENTS}")
    uri = database.resolve().as_uri() + "?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        columns = {row[1] for row in db.execute("PRAGMA table_info(incidents)")}
        required = {"failure_class", "fingerprint", "summary", "first_seen", "last_seen", "attempt_count", "escalated", "causal_evidence"}
        if not required.issubset(columns):
            raise ValueError("incident ledger schema is incomplete")
        rows = db.execute("SELECT failure_class,fingerprint,summary,first_seen,last_seen,attempt_count,escalated,causal_evidence FROM incidents ORDER BY escalated DESC,last_seen DESC,failure_class,fingerprint LIMIT ?", (limit + 1,)).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    incidents = []
    for row in rows:
        try:
            evidence = json.loads(row["causal_evidence"])
        except (TypeError, json.JSONDecodeError):
            evidence = {"status": "unreadable"}
        if not isinstance(evidence, dict):
            evidence = {"status": "unreadable"}
        incidents.append({"class": row["failure_class"], "fingerprint": row["fingerprint"],
                          "summary": str(row["summary"])[:500], "firstSeen": row["first_seen"],
                          "lastSeen": row["last_seen"], "attempts": row["attempt_count"],
                          "escalated": bool(row["escalated"]), "evidence": evidence})
    result = {"schemaVersion": 1, "status": "ok", "count": len(incidents), "hasMore": has_more, "incidents": incidents}
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    if len(encoded) > MAX_REPORT_CHARS:
        # Keep the report deterministic and bounded even if stored evidence is malformed/large.
        for item in incidents:
            item["summary"] = item["summary"][:120]
            item["evidence"] = {k: str(v)[:100] for k, v in item["evidence"].items() if k in {"source", "stage", "evidenceId", "receipt", "candidateSha"}}
        while incidents and len(json.dumps(result, sort_keys=True, separators=(",", ":"))) > MAX_REPORT_CHARS:
            incidents.pop()
        result["count"] = len(incidents)
        result["truncated"] = True
    return result


def rolling_escalation(repo: str, issue: int, fingerprint: str, body: str, *, gh="gh", state_path: pathlib.Path, runner=subprocess.run) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or issue < 1 or not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise ValueError("explicit repository, issue, and full incident fingerprint are required")
    marker = f"<!-- factory-incident:{fingerprint} -->"
    text = f"{marker}\n## Release incident escalation\n\n{body[:4000]}\n\nUpdated: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with exclusive_lock(state_path.with_suffix(".lock")):
        try:
            response = runner([gh, "api", f"repos/{repo}/issues/{issue}/comments?per_page=100", "--paginate", "--slurp"], capture_output=True, text=True, timeout=30, check=True)
            pages = json.loads(response.stdout)
            comments = [comment for page in pages for comment in page] if isinstance(pages, list) and all(isinstance(page, list) for page in pages) else pages
            if not isinstance(comments, list):
                raise ValueError("GitHub returned an invalid comment list")
            existing = next((c for c in comments if marker in c.get("body", "")), None)
            if existing:
                comment_id = str(existing.get("id") or "")
                if not comment_id:
                    raise ValueError("existing escalation comment has no id")
                runner([gh, "api", f"repos/{repo}/issues/comments/{comment_id}", "-X", "PATCH", "-f", f"body={text}"], capture_output=True, text=True, timeout=30, check=True)
                status = "updated"
            else:
                runner([gh, "issue", "comment", str(issue), "--repo", repo, "--body", text], capture_output=True, text=True, timeout=30, check=True)
                status = "created"
            receipt = {"status": status, "fingerprint": fingerprint, "issue": issue, "updatedAt": time.time()}
        except Exception as exc:
            receipt = {"status": "pending", "fingerprint": fingerprint, "issue": issue, "updatedAt": time.time(), "reason": type(exc).__name__}
        current = {}
        if state_path.is_file():
            try: current = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError): current = {}
        entries = current.get("incidents", {}) if isinstance(current, dict) else {}
        if not isinstance(entries, dict):
            entries = {}
        entries[fingerprint] = receipt
        temp = state_path.with_suffix(state_path.suffix + ".tmp")
        temp.write_text(json.dumps({"schemaVersion": 1, "incidents": entries}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        temp.replace(state_path)
        return receipt


def open_fix_pr(repo_path: pathlib.Path, repository: str, title: str, body_file: pathlib.Path, validation_receipt: pathlib.Path, *, gh="gh", runner=subprocess.run, git_runner=subprocess.run) -> dict:
    """Publish prepared local changes to dev; deliberately has no merge capability."""
    branch = git_runner(["git", "-C", str(repo_path), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip()
    if not branch or branch.lower() in {"main", "master", "stable", "production", "prod"}:
        raise ValueError("fix PR requires a non-protected task branch")
    changes = git_runner(["git", "-C", str(repo_path), "status", "--porcelain"], capture_output=True, text=True, check=True).stdout
    if changes.strip():
        raise ValueError("fix PR requires committed, clean worktree changes")
    head = git_runner(["git", "-C", str(repo_path), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    try:
        receipt = json.loads(validation_receipt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("fix PR requires a readable local validation receipt") from exc
    if (receipt.get("schemaVersion") != 1 or receipt.get("repository") != repository or
            receipt.get("headSha", "").lower() != head.lower() or receipt.get("status") != "passed" or
            receipt.get("exitCode") != 0 or receipt.get("worktreeClean") is not True):
        raise ValueError("fix PR requires passing, clean validation evidence bound to the exact HEAD")
    remote = git_runner(["git", "-C", str(repo_path), "remote", "get-url", "origin"], capture_output=True, text=True, check=True).stdout.strip()
    parsed = urllib.parse.urlsplit(remote)
    remote_repo = parsed.path.strip("/").removesuffix(".git") if parsed.hostname == "github.com" else ""
    if not remote_repo and remote.startswith("git@github.com:"):
        remote_repo = remote.removeprefix("git@github.com:").removesuffix(".git")
    if remote_repo.lower() != repository.lower():
        raise ValueError("origin must point to the explicitly configured GitHub repository")
    body = body_file.read_text(encoding="utf-8")
    if not title.strip() or "Closes #" not in body:
        raise ValueError("fix PR requires a title and issue-closing body")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("explicit repository owner/name is required")
    git_runner(["git", "-C", str(repo_path), "push", "--set-upstream", "origin", branch], capture_output=True, text=True, timeout=120, check=True)
    result = runner([gh, "pr", "create", "--repo", repository, "--base", "dev", "--head", branch, "--title", title, "--body-file", str(body_file)], cwd=repo_path, capture_output=True, text=True, timeout=60, check=True)
    url = result.stdout.strip().splitlines()[-1]
    if not re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+/pull/[1-9]\d*", url):
        raise ValueError("gh did not return a valid pull request URL")
    return {"status": "open", "base": "dev", "branch": branch, "pr": url, "autoMerge": False}


def reconcile(database: pathlib.Path, repo: str, issue: int, state_path: pathlib.Path, *, gh="gh", runner=subprocess.run) -> dict:
    report = diagnose(database)
    escalations = []
    for incident in report["incidents"]:
        if incident["escalated"]:
            evidence = json.dumps(incident["evidence"], sort_keys=True)
            body = f"Class: `{incident['class']}`\nFingerprint: `{incident['fingerprint']}`\nAttempts: {incident['attempts']}\n\n{incident['summary']}\n\nEvidence pointer: `{evidence[:600]}`"
            escalations.append(rolling_escalation(repo, issue, incident["fingerprint"], body, gh=gh, state_path=state_path, runner=runner))
    return {"status": "ok", "diagnosis": report, "escalations": escalations}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    report = subs.add_parser("diagnose"); report.add_argument("--ledger", required=True); report.add_argument("--limit", type=int, default=MAX_INCIDENTS)
    rec = subs.add_parser("reconcile"); rec.add_argument("--ledger", required=True); rec.add_argument("--repo", required=True); rec.add_argument("--issue", required=True, type=int); rec.add_argument("--state", required=True); rec.add_argument("--gh", default="gh")
    esc = subs.add_parser("escalate"); esc.add_argument("--repo", required=True); esc.add_argument("--issue", required=True, type=int); esc.add_argument("--fingerprint", required=True); esc.add_argument("--body", required=True); esc.add_argument("--state", required=True); esc.add_argument("--gh", default="gh")
    pr = subs.add_parser("open-fix-pr"); pr.add_argument("--repo-path", required=True); pr.add_argument("--repository", required=True); pr.add_argument("--title", required=True); pr.add_argument("--body-file", required=True); pr.add_argument("--validation-receipt", required=True); pr.add_argument("--gh", default="gh")
    args = parser.parse_args(argv)
    try:
        if args.command == "diagnose": result = diagnose(pathlib.Path(args.ledger), args.limit)
        elif args.command == "escalate": result = rolling_escalation(args.repo, args.issue, args.fingerprint, args.body, gh=args.gh, state_path=pathlib.Path(args.state))
        elif args.command == "reconcile": result = reconcile(pathlib.Path(args.ledger), args.repo, args.issue, pathlib.Path(args.state), gh=args.gh)
        else: result = open_fix_pr(pathlib.Path(args.repo_path), args.repository, args.title, pathlib.Path(args.body_file), pathlib.Path(args.validation_receipt), gh=args.gh)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (ValueError, OSError, sqlite3.Error, ControllerError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:1000]}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
