"""Incremental documentation drift detection, refresh and failure recovery.

Consumes verified-merge events (the execution ledger owns the events; this module
stores only its own job queue and the derived documentation index). The index is a
rebuildable cache: every claim carries its source revision and evidence, or is
explicitly ``unverified``. Deterministic impact analysis runs before any model call.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import pathlib
import re
import time
from typing import Callable, Iterable

SCHEMA = "factory-doc-refresh/v1"
MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 1800
LEASE_SECONDS = 300
ESCALATE_AFTER = 3

EXCLUDED_GLOBS = (
    "*.env", ".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*secret*", "*credential*", "*id_rsa*",
    "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.wav", "*.ogg", "*.mp3", "*.mp4", "*.zip",
    "*.gz", "*.tar", "*.exe", "*.dll", "*.so", "*.dylib", "*.bin", "*.pck", "*.glb", "*.fbx",
    "*.import", "*.min.js", "*.generated.*", "*.g.cs", "*.pb.go", "*_pb2.py",
)
EXCLUDED_DIRS = {"node_modules", "vendor", "third_party", "addons", ".git", ".godot", "dist", "build",
                 "__pycache__", ".factory", "generated", "bin", "obj"}
DOC_SUFFIXES = (".md", ".mdx", ".rst", ".txt")
DOC_DIRS = ("docs/",)
CRITICAL_SEVERITIES = {"critical"}


class RefreshError(Exception):
    pass


# ---- path safety and exclusions ------------------------------------------

def safe_path(path: str) -> str | None:
    """Return a normalized repo-relative path, or None for traversal/absolute/odd paths."""
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path:
        return None
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return None
    parts = pathlib.PurePosixPath(path).parts
    if any(p in ("..", "") for p in parts):
        return None
    return "/".join(p for p in parts if p != ".")


def excluded(path: str) -> bool:
    safe = safe_path(path)
    if safe is None:
        return True
    parts = safe.split("/")
    if any(p in EXCLUDED_DIRS for p in parts[:-1]):
        return True
    name = parts[-1].lower()
    return any(fnmatch.fnmatch(name, g) for g in EXCLUDED_GLOBS)


def is_docs_only(path: str) -> bool:
    return path.lower().endswith(DOC_SUFFIXES) or path.startswith(DOC_DIRS)


_INJECTION = re.compile(r"(?i)(ignore (all |any )?(previous|prior) instructions|system prompt|disregard the above|"
                        r"you are now|<\s*/?\s*(system|assistant)\s*>|BEGIN (RSA|OPENSSH|PRIVATE))")


def sanitize_comment(text: str) -> str:
    """Neutralize untrusted source comments before they reach a model prompt."""
    return "\n".join("[redacted: suspected instruction]" if _INJECTION.search(line) else line
                     for line in text.splitlines())


# ---- deterministic extraction --------------------------------------------

_PY_API = re.compile(r"^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)", re.M)
_GD_API = re.compile(r"^(?:class_name\s+(\w+)|signal\s+(\w+)|func\s+([A-Za-z]\w*)|@export[^\n]*var\s+(\w+))", re.M)
_PS_API = re.compile(r"^\s*function\s+([A-Za-z][\w-]*)", re.M | re.I)
_TSCN = re.compile(r"^\[(?:node|ext_resource|connection)[^\]]*\]", re.M)


def extract_contract(path: str, text: str) -> list[str]:
    """Deterministic public-surface signature list for a file (no model involved)."""
    if path.endswith(".py"):
        names = [m for m in _PY_API.findall(text) if not m.startswith("_")]
    elif path.endswith(".gd"):
        names = [next(g for g in m if g) for m in _GD_API.findall(text)]
    elif path.endswith((".ps1", ".psm1")):
        names = _PS_API.findall(text)
    elif path.endswith((".tscn", ".tres")):
        names = _TSCN.findall(text)
    elif path.endswith(".json"):
        try:
            data = json.loads(text)
            names = sorted(data) if isinstance(data, dict) else []
        except ValueError:
            names = []
    else:
        names = []
    return sorted(set(names))


def contract_hash(path: str, text: str) -> str:
    return hashlib.sha256("\n".join(extract_contract(path, text)).encode()).hexdigest()


# ---- documentation index (derived, rebuildable) ---------------------------

def new_index() -> dict:
    return {"schema": SCHEMA, "sections": {}, "verifiedSha": {}}


def impacted_sections(index: dict, changed: Iterable[str], deps: dict[str, list[str]] | None = None) -> list[str]:
    """Sections whose sources (or dependents of changed sources) changed. Pure, no model call."""
    deps = deps or {}
    touched = set()
    for raw in changed:
        p = safe_path(raw)
        if p is None or excluded(p) or is_docs_only(p):
            continue
        touched.add(p)
        touched.update(deps.get(p, []))
    return sorted(sid for sid, sec in index["sections"].items() if touched & set(sec.get("sources", [])))


def claim(text: str, source: str | None, sha: str | None, evidence: str | None) -> dict:
    ok = bool(source and sha and evidence)
    return {"text": text, "source": source, "sourceSha": sha, "evidence": evidence,
            "state": "verified" if ok else "unverified"}


# ---- durable queue --------------------------------------------------------

def _atomic_write(path: pathlib.Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def job_key(target: str, sha: str) -> str:
    return hashlib.sha256(f"{target}@{sha}".encode()).hexdigest()[:24]


class DocsRefresher:
    """Queue + index persisted under ``root``. Every mutation is an atomic file replace."""

    def __init__(self, root: str | os.PathLike, *, now: Callable[[], float] = time.time,
                 is_ancestor: Callable[[str, str], bool] | None = None,
                 target_head: Callable[[str], str | None] | None = None,
                 read_file: Callable[[str, str], str | None] | None = None) -> None:
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.now = now
        self.is_ancestor = is_ancestor or (lambda a, b: False)
        self.target_head = target_head or (lambda target: None)
        self.read_file = read_file or (lambda sha, path: None)
        self.queue_path = self.root / "queue.json"
        self.index_path = self.root / "index.json"
        self.queue = self._load(self.queue_path, {"schema": SCHEMA, "jobs": {}})
        self.index = self._load(self.index_path, new_index())

    @staticmethod
    def _load(path: pathlib.Path, default: dict) -> dict:
        if not path.exists():
            return default
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            # Corrupt state is never trusted; keep bytes for repair and rebuild.
            path.rename(path.with_suffix(".corrupt"))
            return default
        if data.get("schema") != SCHEMA:
            raise RefreshError(f"unsupported state version in {path.name}: {data.get('schema')!r}")
        return data

    def _save(self) -> None:
        _atomic_write(self.queue_path, self.queue)
        _atomic_write(self.index_path, self.index)

    # -- enqueue (idempotent, deduplicated, debounced by verified SHA) --
    def enqueue(self, target: str, sha: str, changed: list[str]) -> str:
        key = job_key(target, sha)
        jobs = self.queue["jobs"]
        if key in jobs:
            return key  # replayed event: idempotent
        for other in jobs.values():
            if sha in other.get("aliases", []) and other["target"] == target:
                return other["key"]  # replay of a coalesced event
        relevant = [p for p in (safe_path(c) for c in changed) if p and not excluded(p) and not is_docs_only(p)]
        for other in jobs.values():  # debounce: coalesce into a pending job for the same target
            if other["target"] == target and other["state"] == "pending":
                other["changed"] = sorted(set(other["changed"]) | set(relevant))
                other["sha"], other["aliases"] = sha, other.get("aliases", []) + [other["sha"]]
                jobs[key] = jobs.pop(other["key"])
                jobs[key]["key"] = key
                self._save()
                return key
        jobs[key] = {"key": key, "target": target, "sha": sha, "changed": sorted(set(relevant)),
                     "state": "pending", "attempts": 0, "notBefore": 0, "lease": None, "aliases": []}
        self._save()
        return key

    def recover(self) -> int:
        """Crash recovery: running jobs with an expired lease return to pending."""
        n = 0
        for job in self.queue["jobs"].values():
            if job["state"] == "running" and (job["lease"] or 0) <= self.now():
                job["state"], job["lease"] = "pending", None
                n += 1
        if n:
            self._save()
        return n

    # -- processing --
    def process_next(self, generate: Callable[[str, dict], dict], deps: dict | None = None,
                     gate_policy: dict | None = None) -> dict | None:
        """Run one due job. ``generate(section_id, context)`` is the only model call."""
        self.recover()
        due = sorted((j for j in self.queue["jobs"].values()
                      if j["state"] == "pending" and j["notBefore"] <= self.now()), key=lambda j: j["key"])
        if not due:
            return None
        job = due[0]
        target, sha = job["target"], job["sha"]
        head = self.target_head(target)
        verified = self.index["verifiedSha"].get(target)
        # Never publish unmerged or stale work as stable documentation.
        if head is not None and head != sha and not self.is_ancestor(sha, head):
            return self._finish(job, "rejected", "sha is not on the merged target branch")
        if verified and (verified == sha or self.is_ancestor(sha, verified)):
            return self._finish(job, "rejected", "older or duplicate sha cannot overwrite newer verified docs")
        sections = impacted_sections(self.index, job["changed"], deps)
        if not sections:
            self.index["verifiedSha"][target] = sha
            return self._finish(job, "noop", "no impacted sections; zero generation calls")
        job["state"], job["lease"] = "running", self.now() + LEASE_SECONDS
        self._save()
        staged: dict[str, dict] = {}
        try:
            for sid in sections:
                sec = self.index["sections"][sid]
                srcs = {}
                for p in sec["sources"]:
                    text = self.read_file(sha, p)
                    if text is not None and not excluded(p):
                        srcs[p] = sanitize_comment(text)
                result = generate(sid, {"sha": sha, "sources": srcs, "previous": sec.get("claims", [])})
                staged[sid] = {"claims": [claim(c["text"], c.get("source"), sha, c.get("evidence"))
                                          for c in result.get("claims", [])]}
        except Exception as exc:  # backend outage or malformed output: nothing staged is published
            return self._fail(job, sections, str(exc), gate_policy)
        for sid, upd in staged.items():  # publish atomically after every section succeeded
            sec = self.index["sections"][sid]
            sec.update(upd, sourceSha=sha, state=self._section_state(upd["claims"]))
        self.index["verifiedSha"][target] = sha
        return self._finish(job, "done", f"refreshed {len(staged)} section(s)", sections=sections)

    @staticmethod
    def _section_state(claims: list[dict]) -> str:
        return "verified" if claims and all(c["state"] == "verified" for c in claims) else "unverified"

    def _finish(self, job: dict, state: str, note: str, **extra) -> dict:
        job.update(state=state, lease=None, note=note)
        self._save()
        return {"key": job["key"], "state": state, "note": note, **extra}

    def _fail(self, job: dict, sections: list[str], err: str, gate_policy: dict | None) -> dict:
        job["attempts"] += 1
        job["lease"], job["lastError"] = None, err
        for sid in sections:  # advisory: mark stale content unverified, never silently keep claiming fresh
            self.index["sections"][sid]["state"] = "unverified"
        out: dict = {"key": job["key"], "error": err, "attempts": job["attempts"]}
        if job["attempts"] >= MAX_ATTEMPTS:
            job["state"] = "failed"
        else:
            job["state"] = "pending"
            job["notBefore"] = self.now() + min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (job["attempts"] - 1))
        out["state"] = job["state"]
        if job["attempts"] >= ESCALATE_AFTER:
            out["escalation"] = {"issueTitle": f"Docs refresh failing for {job['target']}@{job['sha'][:12]}",
                                 "attempts": job["attempts"], "error": err[:300]}
        out["gate"] = self.gate(sections, gate_policy)
        self._save()
        return out

    # -- gate policy: only approved critical contract/security drift blocks --
    def gate(self, sections: list[str], policy: dict | None) -> str:
        policy = policy or {}
        gated = set(policy.get("blockingSections", []))
        for sid in sections:
            if sid in gated and self.index["sections"][sid].get("severity") in CRITICAL_SEVERITIES:
                return "block"
        return "advisory"

    def detect_drift(self, section_id: str, sha: str) -> dict:
        """Compare stored contract hashes with the contract at ``sha``; emit severity + evidence."""
        sec = self.index["sections"][section_id]
        changed = []
        for p, old in sec.get("contractHashes", {}).items():
            text = self.read_file(sha, p)
            if text is None or contract_hash(p, text) != old:
                changed.append(p)
        severity = "none"
        if changed:
            severity = "critical" if sec.get("critical") else "advisory"
        return {"section": section_id, "severity": severity, "evidence": changed, "sha": sha}

    def rebuild(self, specs: dict[str, list[str]], sha: str) -> None:
        """Deterministic rebuild of the index skeleton from source specs at a pinned SHA."""
        sections = {}
        for sid, srcs in sorted(specs.items()):
            safe = [p for p in (safe_path(s) for s in srcs) if p and not excluded(p)]
            sections[sid] = {"sources": safe, "claims": [], "sourceSha": sha, "state": "unverified",
                             "contractHashes": {p: contract_hash(p, t) for p in safe
                                                if (t := self.read_file(sha, p)) is not None}}
        self.index = {"schema": SCHEMA, "sections": sections, "verifiedSha": {}}
        self._save()
