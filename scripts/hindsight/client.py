#!/usr/bin/env python3
"""Bounded Hindsight HTTP boundary. It never persists raw responses or credentials."""
import argparse, json, os, re, sys, time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

MAX_MEMORIES, MAX_CHARS = 8, 12000
SECRET = re.compile(r"(?i)(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*\S+|bearer\s+\S+")
DENY = re.compile(r"(?i)(transcript|raw log|source file|credential|password|token|secret|personal data|temporary state)")
ALLOWED = {"architecture", "recurring-failure", "successful-fix", "convention", "environment-discovery"}

def scrub(value):
    return SECRET.sub("[redacted]", str(value)).strip()

def mcp_request(base, bank, token, method, params, timeout, session_id=None, request_id=1):
    """Make one streamable-HTTP MCP request and return JSON-RPC body/session."""
    endpoint = base.rstrip("/") + "/mcp/" + quote(bank, safe="") + "/"
    payload = {"jsonrpc":"2.0", "method":method, "params":params}
    if request_id is not None: payload["id"] = request_id
    headers = {"Content-Type":"application/json", "Accept":"application/json, text/event-stream"}
    if token: headers["Authorization"] = "Bearer " + token
    if session_id: headers["Mcp-Session-Id"] = session_id
    request = Request(endpoint, data=json.dumps(payload).encode(), method="POST", headers=headers)
    with urlopen(request, timeout=timeout) as response:
        text = response.read().decode()
        returned_session_id = response.headers.get("Mcp-Session-Id")
    if not text.strip(): return {}, returned_session_id
    if text.startswith("data:"): text = "\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
    return json.loads(text), returned_session_id

def mcp_call(base, bank, token, tool, arguments, timeout):
    """Invoke Hindsight's built-in stateful single-bank MCP endpoint."""
    initial, session_id = mcp_request(base, bank, token, "initialize", {
        "protocolVersion":"2025-06-18", "capabilities":{},
        "clientInfo":{"name":"cezar-factory", "version":"1"}}, timeout)
    if initial.get("error") or not session_id:
        raise ValueError("MCP initialization failed")
    # Stateful MCP servers require this notification before a tool call.
    mcp_request(base, bank, token, "notifications/initialized", {}, timeout, session_id, request_id=None)
    result, _ = mcp_request(base, bank, token, "tools/call", {"name":tool, "arguments":arguments}, timeout, session_id, request_id=2)
    if result.get("error"): raise ValueError("MCP tool call failed")
    content = (result.get("result") or {}).get("content") or []
    for item in content:
        if item.get("type") == "text":
            try: return json.loads(item.get("text", ""))
            except ValueError: return {"text":item.get("text", "")}
    return result.get("result") or {}

def memories(response):
    if isinstance(response, list): return response
    if isinstance(response, dict): return response.get("memories") or response.get("results") or response.get("items") or []
    return []

def recall(args):
    artifact = {"status":"miss", "banksQueried":[], "memoryIds":[], "memoryCount":0, "contextChars":0, "selected":[]}
    base, token = os.getenv("HINDSIGHT_URL"), os.getenv("HINDSIGHT_AUTH_TOKEN")
    if not base:
        artifact.update(status="unavailable", warning="Hindsight is not configured; continuing without recall.")
        return artifact
    query = " ".join([args.objective[:2000], args.task_class, *args.keywords[:20], args.failure_signature[:500]]).strip()
    try:
        # Project bank is always queried before reusable Factory lessons.
        results = []
        for bank in [args.project_bank, args.factory_bank]:
            if not bank or len(results) >= MAX_MEMORIES: continue
            artifact["banksQueried"].append(bank)
            response = mcp_call(base, bank, token, "recall", {"query":query, "budget":"low", "max_tokens":3000}, args.timeout)
            results.extend(memories(response))
        remaining = MAX_CHARS
        seen = set()
        for item in results:
            if not isinstance(item, dict): continue
            identifier = str(item.get("id") or item.get("memoryId") or "")
            excerpt = scrub(item.get("excerpt") or item.get("content") or item.get("text") or "")
            if not identifier or not excerpt or identifier in seen: continue
            excerpt = excerpt[:remaining]
            if not excerpt: break
            seen.add(identifier); remaining -= len(excerpt)
            selected = {"id":identifier, "excerpt":excerpt}
            if isinstance(item.get("score"), (int, float)): selected["score"] = item["score"]
            artifact["selected"].append(selected); artifact["memoryIds"].append(identifier)
            if len(artifact["selected"]) == MAX_MEMORIES or remaining == 0: break
        artifact["memoryCount"] = len(artifact["selected"])
        artifact["contextChars"] = sum(len(x["excerpt"]) for x in artifact["selected"])
        artifact["status"] = "ok" if artifact["selected"] else "miss"
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
        artifact.update(status="unavailable", warning="Hindsight recall unavailable; continuing without recall.")
        artifact["errorClass"] = type(error).__name__
    return artifact

def candidate_allowed(candidate):
    if not isinstance(candidate, dict): return False, "not-an-object"
    if set(candidate) != {"topic","lesson","kind","evidence"}: return False, "unexpected-fields"
    if candidate.get("kind") not in ALLOWED: return False, "invalid-kind"
    if not all(isinstance(candidate.get(x), str) and candidate[x].strip() for x in candidate): return False, "missing-text"
    if len(candidate["topic"]) > 160 or len(candidate["lesson"]) > 2000 or len(candidate["evidence"]) > 500: return False, "size"
    if DENY.search(" ".join(candidate.values())) or SECRET.search(" ".join(candidate.values())): return False, "sensitive-or-transient"
    return True, "allowed"

def retain(args):
    candidate = json.loads(Path(args.candidate).read_text(encoding="utf-8"))
    allowed, reason = candidate_allowed(candidate)
    receipt = {"status":"rejected", "reason":reason, "candidateHash":__import__('hashlib').sha256(json.dumps(candidate, sort_keys=True).encode()).hexdigest()}
    if not allowed or not args.approved: return receipt
    base, token = os.getenv("HINDSIGHT_URL"), os.getenv("HINDSIGHT_AUTH_TOKEN")
    if not base:
        receipt.update(status="unavailable", reason="Hindsight is not configured")
        return receipt
    try:
        content = candidate["lesson"]
        response = mcp_call(base, args.bank, token, "retain", {"content":content, "context":candidate["kind"], "tags":["project:" + args.project, "factory:approved"], "metadata":{"candidate_hash":receipt["candidateHash"],"workflow":args.workflow,"issue":args.issue,"worker":args.worker,"model":args.model}}, args.timeout)
        receipt.update(status="retained", reason="approved", memoryId=scrub(response.get("id") or response.get("memoryId") or "accepted"))
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
        receipt.update(status="unavailable", reason=type(error).__name__)
    return receipt

def main():
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("recall"); r.add_argument("--project",required=True); r.add_argument("--project-bank",required=True); r.add_argument("--factory-bank",default=""); r.add_argument("--objective",required=True); r.add_argument("--task-class",required=True); r.add_argument("--keywords",nargs="*",default=[]); r.add_argument("--failure-signature",default=""); r.add_argument("--timeout",type=int,default=10); r.add_argument("--output",required=True)
    t = sub.add_parser("retain"); t.add_argument("--project",required=True); t.add_argument("--bank",required=True); t.add_argument("--candidate",required=True); t.add_argument("--approved",action="store_true"); t.add_argument("--workflow",default=""); t.add_argument("--issue",default=""); t.add_argument("--worker",default=""); t.add_argument("--model",default=""); t.add_argument("--timeout",type=int,default=10); t.add_argument("--output",required=True)
    args = parser.parse_args(); value = recall(args) if args.command == "recall" else retain(args)
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status":value["status"], "output":str(output)}))
if __name__ == "__main__": main()
