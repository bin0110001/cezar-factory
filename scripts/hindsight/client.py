#!/usr/bin/env python3
"""Bounded Hindsight HTTP boundary with evidence-backed provenance."""
import argparse
import hashlib
import json
import math
import os
import re
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

MAX_MEMORIES, MAX_CHARS, MAX_DETERMINISTIC = 8, 12000, 100
SECRET = re.compile(r"(?i)(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*\S+|bearer\s+\S+")
DENY = re.compile(r"(?i)(transcript|raw log|source file|credential|password|token|secret|personal data|temporary state)")
ALLOWED = {"architecture", "recurring-failure", "successful-fix", "convention", "environment-discovery"}
EVIDENCE_KINDS = {"run", "issue", "commit", "test", "file"}
VALIDATED_KINDS = {"run", "commit", "test"}


def scrub(value):
    return SECRET.sub("[redacted]", str(value)).strip()


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def decode_mcp_response(text):
    """Decode a JSON or Server-Sent Events MCP response body."""
    body = text.lstrip("\ufeff\r\n \t")
    if not body:
        return {}
    if body[0] in "[{":
        return json.loads(body)
    data = [line[5:].lstrip() for line in body.splitlines() if line.startswith("data:")]
    if data:
        return json.loads("\n".join(data))
    return json.loads(body)


def mcp_request(base, bank, token, method, params, timeout, session_id=None, request_id=1):
    """Make one streamable-HTTP MCP request and return JSON-RPC body/session."""
    endpoint = base.rstrip("/") + "/mcp/" + quote(bank, safe="") + "/"
    payload = {"jsonrpc": "2.0", "method": method, "params": params}
    if request_id is not None:
        payload["id"] = request_id
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    request = Request(endpoint, data=json.dumps(payload).encode(), method="POST", headers=headers)
    with urlopen(request, timeout=timeout) as response:
        text = response.read().decode()
        returned_session_id = response.headers.get("Mcp-Session-Id")
    if not text.strip():
        return {}, returned_session_id
    return decode_mcp_response(text), returned_session_id


def mcp_call(base, bank, token, tool, arguments, timeout):
    """Invoke Hindsight's built-in stateful single-bank MCP endpoint."""
    initial, session_id = mcp_request(base, bank, token, "initialize", {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "cezar-factory", "version": "1"}}, timeout)
    if initial.get("error") or not session_id:
        raise ValueError("MCP initialization failed")
    mcp_request(base, bank, token, "notifications/initialized", {}, timeout, session_id, request_id=None)
    result, _ = mcp_request(base, bank, token, "tools/call", {"name": tool, "arguments": arguments}, timeout, session_id, request_id=2)
    if result.get("error"):
        raise ValueError("MCP tool call failed")
    content = (result.get("result") or {}).get("content") or []
    for item in content:
        if item.get("type") == "text":
            try:
                return json.loads(item.get("text", ""))
            except ValueError:
                return {"text": item.get("text", "")}
    return result.get("result") or {}


def memories(response):
    if isinstance(response, list):
        return response
    if isinstance(response, dict):
        return response.get("memories") or response.get("results") or response.get("items") or []
    return []


def read_json_lines(path):
    if not path or not Path(path).exists():
        return []
    rows = []
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
            except json.JSONDecodeError:
                continue
    except (OSError, UnicodeDecodeError):
        return []
    return rows


@contextmanager
def state_lock(path):
    lock_path = Path(str(path) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as stream:
        if os.name == "nt":
            import msvcrt
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def append_state(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with state_lock(target):
        with target.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())


def state_path(args):
    configured = getattr(args, "provenance_index", None) or os.getenv("HINDSIGHT_PROVENANCE_INDEX")
    if configured:
        return Path(configured)
    home = os.getenv("CEZ_HOME")
    if home:
        return Path(home) / "hindsight" / "provenance.jsonl"
    return Path(".factory/context/hindsight-provenance.jsonl")


def deterministic_rows(args):
    configured = getattr(args, "deterministic_index", None) or os.getenv("HINDSIGHT_DETERMINISTIC_INDEX")
    if not configured:
        return []
    try:
        data = json.loads(Path(configured).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    rows = data if isinstance(data, list) else data.get("records", []) if isinstance(data, dict) else []
    return [row for row in rows if isinstance(row, dict)]


def deterministic_matches(args):
    needles = {value.strip().casefold() for value in [args.failure_signature, *args.keywords] if value and value.strip()}
    found = []
    seen = set()
    for row in deterministic_rows(args):
        kind = row.get("kind")
        value = row.get("fingerprint") if kind == "fingerprint" else row.get("testId") if kind == "test" else None
        if not value or str(value).casefold() not in needles:
            continue
        identifier = str(row.get("id") or row.get("ref") or value)
        reference = str(row.get("ref") or identifier)
        if any(DENY.search(item) or SECRET.search(item) for item in (identifier, reference, str(value))):
            continue
        if identifier in seen:
            continue
        seen.add(identifier)
        observed_hash = row.get("contentHash") or row.get("sha256")
        if not isinstance(observed_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", observed_hash):
            observed_hash = sha256(json.dumps(row, sort_keys=True))
        found.append({
            "kind": kind, "id": scrub(identifier), "ref": scrub(reference),
            "value": scrub(value), "contentHash": observed_hash,
            "readAt": now_utc(),
        })
        if len(found) >= MAX_DETERMINISTIC:
            break
    return found


def state_records(args):
    records = {}
    for event in read_json_lines(state_path(args)):
        record = event.get("record")
        if event.get("event") == "retained" and isinstance(record, dict) and record.get("id"):
            records[str(record["id"])] = record
            previous = event.get("supersedes")
            if previous and str(previous) in records:
                records[str(previous)]["superseded"] = True
                records[str(previous)]["supersededBy"] = record["id"]
                records[str(previous)]["supersededAt"] = event.get("timestamp")
    return records


def matching_deterministic_reference(link, rows):
    if link.get("kind") not in VALIDATED_KINDS:
        return None
    for row in rows:
        verified = row.get("verified") is True
        if verified and row.get("kind") == link.get("kind") and str(row.get("ref")) == str(link.get("ref")):
            observed_hash = row.get("contentHash") or row.get("sha256")
            if link.get("sha256") and observed_hash != link["sha256"]:
                continue
            return row
    return None


def candidate_allowed(candidate):
    if not isinstance(candidate, dict):
        return False, "not-an-object"
    allowed_fields = {"topic", "lesson", "kind", "evidence", "scope", "claimType", "evidenceLinks"}
    if set(candidate) - allowed_fields:
        return False, "unexpected-fields"
    if candidate.get("kind") not in ALLOWED:
        return False, "invalid-kind"
    if not all(isinstance(candidate.get(x), str) and candidate[x].strip() for x in ("topic", "lesson", "evidence")):
        return False, "missing-text"
    if len(candidate["topic"]) > 160 or len(candidate["lesson"]) > 2000 or len(candidate["evidence"]) > 500:
        return False, "size"
    if candidate.get("scope") not in {"repo", "global"}:
        return False, "missing-or-invalid-scope"
    if candidate.get("claimType") not in {"fact", "hypothesis"}:
        return False, "missing-or-invalid-claim-type"
    links = candidate.get("evidenceLinks")
    if not isinstance(links, list) or not links:
        return False, "evidence-link-required"
    if len(links) > 16:
        return False, "too-many-evidence-links"
    for link in links:
        if not isinstance(link, dict) or set(link) - {"kind", "ref", "sha256"}:
            return False, "invalid-evidence-link"
        if link.get("kind") not in EVIDENCE_KINDS or not isinstance(link.get("ref"), str) or not link["ref"].strip() or len(link["ref"]) > 2048:
            return False, "invalid-evidence-link"
        if "sha256" in link and (not isinstance(link["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", link["sha256"])):
            return False, "invalid-evidence-link"
    text = " ".join([candidate["topic"], candidate["lesson"], candidate["evidence"], *(str(link["ref"]) for link in links)])
    if DENY.search(text) or SECRET.search(text):
        return False, "sensitive-or-transient"
    return True, "allowed"


def normalized_candidate(candidate, args):
    rows = deterministic_rows(args)
    validated = [link for link in candidate["evidenceLinks"] if matching_deterministic_reference(link, rows)]
    claim_type = candidate["claimType"] if candidate["claimType"] == "hypothesis" or validated else "hypothesis"
    validation = "validated" if validated else "unvalidated"
    safe_links = [{
        "kind": link["kind"], "ref": scrub(link["ref"]),
        **({"sha256": link["sha256"]} if link.get("sha256") else {}),
        "validationStatus": "validated" if link in validated else "unvalidated",
    } for link in candidate["evidenceLinks"]]
    return {
        "topic": scrub(candidate["topic"]), "lesson": scrub(candidate["lesson"]), "kind": candidate["kind"],
        "scope": candidate["scope"], "claimType": claim_type, "validationStatus": validation,
        "evidenceLinks": safe_links,
    }


def create_record(candidate, memory_id, args, prior, supersedes=None):
    timestamp = now_utc()
    content_hash = sha256(memory_content(candidate))
    version_map = {}
    for row in prior:
        for version in row.get("versionHistory", []):
            version_map[version["id"]] = version
        version_map[row["id"]] = {"id": row["id"], "version": row.get("version", 1), "contentHash": row.get("contentHash", ""), "retainedAt": row.get("retainedAt", "")}
    versions = sorted(version_map.values(), key=lambda item: (int(item.get("version", 1)), item["id"]))[-32:]
    version = max((int(row.get("version", 1)) for row in prior), default=0) + 1
    return {
        "id": memory_id, "project": args.project, **candidate, "version": version,
        "contentHash": content_hash, "retainedAt": timestamp, "superseded": False,
        "supersedes": supersedes, "supersededBy": None, "versionHistory": versions,
    }


def memory_content(candidate):
    return "Topic: " + candidate["topic"] + "\nLesson: " + candidate["lesson"]


def latest_topic_records(args, candidate):
    key = (candidate["scope"], candidate["topic"].casefold())
    return [row for row in state_records(args).values()
            if (key[0] == "global" or row.get("project") == args.project) and row.get("scope") == key[0]
            and str(row.get("topic", "")).casefold() == key[1]]


def retention_arguments(record, args):
    tags = ["project:" + scrub(args.project), "factory:approved", "scope:" + record["scope"],
            "claim:" + record["claimType"], "validation:" + record["validationStatus"]]
    metadata = {key: record[key] for key in (
        "scope", "claimType", "validationStatus", "evidenceLinks", "version", "contentHash",
        "retainedAt", "supersedes", "versionHistory")}
    metadata.update({"project": scrub(args.project), "candidate_hash": record["contentHash"],
                     "workflow": scrub(args.workflow), "issue": scrub(args.issue),
                     "worker": scrub(args.worker), "model": scrub(args.model)})
    identity = "|".join([scrub(args.project), record["scope"], record["topic"].casefold(),
                         str(record["version"]), record["contentHash"]])
    document_id = "cezar-memory-" + sha256(identity)[:32]
    return {"content": memory_content(record), "context": record["kind"], "tags": tags,
            "metadata": metadata, "document_id": document_id}


def retain(args, supersedes=None):
    candidate = json.loads(Path(args.candidate).read_text(encoding="utf-8"))
    allowed, reason = candidate_allowed(candidate)
    receipt = {"status": "rejected", "reason": reason,
               "candidateHash": sha256(json.dumps(candidate, sort_keys=True))}
    if not allowed or not args.approved:
        if allowed:
            receipt["reason"] = "approval-required"
        return receipt
    base, token = os.getenv("HINDSIGHT_URL"), os.getenv("HINDSIGHT_AUTH_TOKEN")
    if not base:
        receipt.update(status="unavailable", reason="Hindsight is not configured")
        return receipt
    normalized = normalized_candidate(candidate, args)
    prior = latest_topic_records(args, normalized)
    if supersedes:
        old = state_records(args).get(supersedes)
        if not old or old.get("superseded"):
            receipt["reason"] = "superseded-memory-not-found-or-inactive"
            return receipt
        if old.get("scope") != normalized["scope"] or str(old.get("topic", "")).casefold() != normalized["topic"].casefold():
            receipt["reason"] = "replacement-topic-or-scope-mismatch"
            return receipt
        if not any(link["validationStatus"] == "validated" for link in normalized["evidenceLinks"]):
            receipt["reason"] = "supersession-requires-validated-evidence"
            return receipt
        prior = [old]
    timestamp = now_utc()
    provisional_id = "pending-" + str(uuid.uuid4())
    provisional = create_record(normalized, provisional_id, args, prior, supersedes)
    try:
        response = mcp_call(base, args.bank, token, "retain", retention_arguments(provisional, args), args.timeout)
        memory_id = scrub(response.get("id") or response.get("memoryId") or "")
        if not memory_id:
            memory_id = str(uuid.uuid4())
        record = create_record(normalized, memory_id, args, prior, supersedes)
        append_state(state_path(args), {"event": "retained", "timestamp": timestamp, "record": record, "supersedes": supersedes})
        receipt.update(status="retained", reason="approved", memoryId=memory_id, record=record)
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
        receipt.update(status="unavailable", reason=type(error).__name__)
    return receipt


def recall(args):
    artifact = {"status": "miss", "banksQueried": [], "memoryIds": [], "memoryCount": 0,
                "contextChars": 0, "selected": [], "deterministicMatches": [], "retrievalCapture": {
                    "schemaVersion": 1, "project": args.project, "readAt": now_utc(),
                    "deterministicMatches": [], "memories": []}}
    artifact["deterministicMatches"] = deterministic_matches(args)
    artifact["retrievalCapture"]["deterministicMatches"] = [
        {key: row[key] for key in ("kind", "id", "ref", "contentHash")} for row in artifact["deterministicMatches"]]
    base, token = os.getenv("HINDSIGHT_URL"), os.getenv("HINDSIGHT_AUTH_TOKEN")
    if not base:
        artifact.update(status="unavailable", warning="Hindsight is not configured; continuing without recall.")
        return artifact
    query = " ".join([args.objective[:2000], args.task_class, *args.keywords[:20], args.failure_signature[:500]]).strip()
    local = state_records(args)
    try:
        results = []
        for bank in [args.project_bank, args.factory_bank]:
            if not bank or len(results) >= MAX_MEMORIES:
                continue
            artifact["banksQueried"].append(bank)
            response = mcp_call(base, bank, token, "recall", {"query": query, "budget": "low", "max_tokens": 3000}, args.timeout)
            results.extend(memories(response))
        remaining = MAX_CHARS
        seen = set()
        for item in results:
            if not isinstance(item, dict):
                continue
            identifier = str(item.get("id") or item.get("memoryId") or "")
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            local_record = local.get(identifier, {})
            if (not identifier or identifier in seen or local_record.get("superseded")
                    or metadata.get("superseded") is True or metadata.get("validationStatus") == "superseded"):
                continue
            if local_record.get("scope") == "repo" and local_record.get("project") != args.project:
                continue
            excerpt = scrub(item.get("excerpt") or item.get("content") or item.get("text") or "")
            if not excerpt:
                continue
            excerpt = excerpt[:remaining]
            if not excerpt:
                break
            read_at = now_utc()
            content_hash = str(local_record.get("contentHash") or metadata.get("contentHash") or sha256(excerpt))
            raw_version = local_record.get("version") or metadata.get("version")
            try:
                version = int(raw_version) if raw_version is not None and int(raw_version) > 0 else None
            except (TypeError, ValueError):
                version = None
            validation = str(local_record.get("validationStatus") or metadata.get("validationStatus") or "unvalidated")
            if validation not in {"validated", "unvalidated"}:
                validation = "unvalidated"
            if not re.fullmatch(r"[a-f0-9]{64}", content_hash):
                content_hash = sha256(excerpt)
            selected = {"id": identifier, "excerpt": excerpt, "version": version, "contentHash": content_hash,
                        "readAt": read_at, "validationStatus": validation, "superseded": False}
            if isinstance(item.get("score"), (int, float)) and math.isfinite(float(item["score"])):
                selected["score"] = item["score"]
            artifact["selected"].append(selected)
            artifact["retrievalCapture"]["memories"].append({"id": identifier, "version": version, "contentHash": content_hash,
                                                              "readAt": read_at, "validationStatus": validation})
            artifact["memoryIds"].append(identifier)
            seen.add(identifier)
            remaining -= len(excerpt)
            if len(artifact["selected"]) == MAX_MEMORIES or remaining == 0:
                break
        artifact["memoryCount"] = len(artifact["selected"])
        artifact["contextChars"] = sum(len(item["excerpt"]) for item in artifact["selected"])
        artifact["status"] = "ok" if artifact["selected"] or artifact["deterministicMatches"] else "miss"
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
        artifact.update(status="unavailable", warning="Hindsight recall unavailable; continuing without recall.", errorClass=type(error).__name__)
    return artifact


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    def provenance_argument(command):
        command.add_argument("--provenance-index", default="")
    recall_parser = sub.add_parser("recall")
    recall_parser.add_argument("--project", required=True)
    recall_parser.add_argument("--project-bank", required=True)
    recall_parser.add_argument("--factory-bank", default="")
    recall_parser.add_argument("--objective", required=True)
    recall_parser.add_argument("--task-class", required=True)
    recall_parser.add_argument("--keywords", nargs="*", default=[])
    recall_parser.add_argument("--failure-signature", default="")
    recall_parser.add_argument("--timeout", type=int, default=10)
    recall_parser.add_argument("--output", required=True)
    recall_parser.add_argument("--deterministic-index", default="")
    provenance_argument(recall_parser)
    retain_parser = sub.add_parser("retain")
    retain_parser.add_argument("--project", required=True)
    retain_parser.add_argument("--bank", required=True)
    retain_parser.add_argument("--candidate", required=True)
    retain_parser.add_argument("--approved", action="store_true")
    retain_parser.add_argument("--workflow", default="")
    retain_parser.add_argument("--issue", default="")
    retain_parser.add_argument("--worker", default="")
    retain_parser.add_argument("--model", default="")
    retain_parser.add_argument("--timeout", type=int, default=10)
    retain_parser.add_argument("--output", required=True)
    retain_parser.add_argument("--deterministic-index", default="")
    provenance_argument(retain_parser)
    supersede_parser = sub.add_parser("supersede")
    supersede_parser.add_argument("--project", required=True)
    supersede_parser.add_argument("--bank", required=True)
    supersede_parser.add_argument("--candidate", required=True)
    supersede_parser.add_argument("--old-memory-id", required=True)
    supersede_parser.add_argument("--approved", action="store_true")
    supersede_parser.add_argument("--workflow", default="")
    supersede_parser.add_argument("--issue", default="")
    supersede_parser.add_argument("--worker", default="")
    supersede_parser.add_argument("--model", default="")
    supersede_parser.add_argument("--timeout", type=int, default=10)
    supersede_parser.add_argument("--output", required=True)
    supersede_parser.add_argument("--deterministic-index", default="")
    provenance_argument(supersede_parser)
    args = parser.parse_args()
    value = recall(args) if args.command == "recall" else retain(args, args.old_memory_id if args.command == "supersede" else None)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": value["status"], "output": str(output)}))


if __name__ == "__main__":
    main()
