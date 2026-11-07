#!/usr/bin/env python3
"""Optional Hindsight incident memory: bounded outbox, idempotent retain, advisory recall.

Memory is advisory only. Nothing here decides counts, lifecycle status or gates;
every command exits 0 and degrades to a logged warning when Hindsight is
disabled, unreachable or erroring.
"""
import argparse, hashlib, importlib.util, json, os, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError

_spec = importlib.util.spec_from_file_location("hindsight_client", Path(__file__).with_name("client.py"))
client = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(client)

EVENTS = {"first-seen", "resolved", "reopened"}
LIMITS = {"maxEntries": 50, "maxBytes": 64000, "maxAgeDays": 14, "maxContentChars": 1200, "staleDays": 90, "maxSent": 500, "maxAttempts": 5}
ID_FIELD = re.compile(r"^[A-Za-z0-9._:/#@-]{1,100}$")
EXTRA_SECRET = re.compile(r"(?i)(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{40,})")
HEADER = "incident-memory v1"

def redact(value, limit):
    text = re.sub(r"(?i)bearer\s+\S+", "[redacted]", str(value))
    text = client.scrub(text)
    text = EXTRA_SECRET.sub("[redacted]", text)
    return re.sub(r"\s+", " ", text)[:limit]

def clean_ids(values, limit=10):
    return [str(v) for v in (values or [])[:limit] if ID_FIELD.match(str(v))]

def enabled(env=os.environ):
    return bool(env.get("HINDSIGHT_URL")) and env.get("HINDSIGHT_INCIDENT_MEMORY", "1") not in ("0", "false", "off")

def idempotency_key(project, event):
    raw = "|".join([project, str(event.get("findingId", "")), str(event.get("event", "")), str(event.get("runId", ""))])
    return hashlib.sha256(raw.encode()).hexdigest()[:32]

def build_entry(project, bank, event, now=None):
    """Allowlisted, redacted, bounded outbox entry; None when the event is unusable."""
    if not isinstance(event, dict) or event.get("event") not in EVENTS or not ID_FIELD.match(str(event.get("findingId", ""))):
        return None
    entry = {
        "project": project, "bank": bank, "event": event["event"], "findingId": str(event["findingId"]),
        "runId": str(event.get("runId", "")) if ID_FIELD.match(str(event.get("runId", ""))) else "",
        "commit": str(event.get("commit", "")) if re.match(r"^[0-9a-f]{7,40}$", str(event.get("commit", ""))) else "",
        "evidenceIds": clean_ids(event.get("evidenceIds")),
        "verified": bool(event.get("verified")) and event["event"] == "resolved",
        "summary": redact(event.get("summary", ""), 600),
        "fix": redact(event.get("fix", ""), 400),
        "occurredAt": str(event.get("occurredAt") or datetime.fromtimestamp(now or time.time(), timezone.utc).isoformat()),
        "enqueuedAt": now or time.time(), "attempts": 0,
    }
    entry["key"] = idempotency_key(project, entry)
    return entry

def render(entry, limit=LIMITS["maxContentChars"]):
    lines = [HEADER, "key=" + entry["key"], "project=" + entry["project"], "event=" + entry["event"],
             "finding=" + entry["findingId"], "run=" + entry["runId"], "commit=" + entry["commit"],
             "evidence=" + ",".join(entry["evidenceIds"]), "verified=" + str(entry["verified"]).lower(),
             "at=" + entry["occurredAt"], "summary: " + entry["summary"]]
    if entry["fix"]: lines.append("fix: " + entry["fix"])
    return "\n".join(lines)[:limit]

def load_outbox(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return {"pending": list(data.get("pending", [])), "sent": list(data.get("sent", []))}
    except (OSError, ValueError, AttributeError):
        return {"pending": [], "sent": []}

def bound_outbox(box, now=None, limits=LIMITS):
    """Expire by age, then drop oldest by count and size. Returns the dropped count."""
    now = now or time.time(); before = len(box["pending"])
    box["pending"] = [e for e in box["pending"] if now - e.get("enqueuedAt", now) <= limits["maxAgeDays"] * 86400]
    box["pending"] = box["pending"][-limits["maxEntries"]:]
    while box["pending"] and len(json.dumps(box["pending"])) > limits["maxBytes"]:
        box["pending"].pop(0)
    box["sent"] = box["sent"][-limits["maxSent"]:]
    dropped = before - len(box["pending"])
    if dropped: print(f"warning: incident outbox dropped {dropped} oldest/expired entries", file=sys.stderr)
    return dropped

def save_outbox(path, box):
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp"); tmp.write_text(json.dumps(box, indent=1) + "\n", encoding="utf-8"); os.replace(tmp, p)

def enqueue(outbox, project, bank, event, now=None):
    entry = build_entry(project, bank, event, now)
    if not entry: return {"status": "rejected"}
    box = load_outbox(outbox)
    if entry["key"] in box["sent"] or any(e["key"] == entry["key"] for e in box["pending"]):
        return {"status": "duplicate", "key": entry["key"]}
    box["pending"].append(entry); bound_outbox(box, now); save_outbox(outbox, box)
    return {"status": "queued", "key": entry["key"]}

def flush(outbox, timeout=10, now=None, call=None):
    """Retry pending writes. Failures stay queued; success is recorded so retries stay idempotent."""
    call = call or client.mcp_call
    box = load_outbox(outbox); bound_outbox(box, now)
    result = {"status": "ok", "retained": 0, "pending": 0}
    base, token = os.getenv("HINDSIGHT_URL"), os.getenv("HINDSIGHT_AUTH_TOKEN")
    if not enabled():
        result.update(status="disabled", pending=len(box["pending"])); save_outbox(outbox, box); return result
    remaining = []
    for entry in box["pending"]:
        if entry["key"] in box["sent"]: continue
        if entry.get("attempts", 0) >= LIMITS["maxAttempts"]: continue
        try:
            call(base, entry["bank"], token, "retain", {
                "content": render(entry), "context": "incident-" + entry["event"], "document_id": entry["key"],
                "tags": ["project:" + entry["project"], "factory:incident"],
                "metadata": {"idempotency_key": entry["key"], "finding": entry["findingId"], "event": entry["event"]}}, timeout)
            box["sent"].append(entry["key"]); result["retained"] += 1
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            entry["attempts"] = entry.get("attempts", 0) + 1; remaining.append(entry)
            result.update(status="unavailable", errorClass=type(error).__name__)
            print("warning: Hindsight incident retain unavailable; will retry.", file=sys.stderr)
    box["pending"] = remaining; bound_outbox(box, now); save_outbox(outbox, box)
    result["pending"] = len(box["pending"])
    return result

def parse_memory(text):
    """Parse a retained incident memory; anything else is unverified, provenance-free."""
    if not text.startswith(HEADER): return None
    fields = {}
    for line in text.splitlines()[1:]:
        for sep in ("=", ": "):
            if sep in line and line.split(sep, 1)[0].isalpha():
                k, v = line.split(sep, 1); fields[k] = v; break
    return fields

def parse_time(value):
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, AttributeError):
        return None

def interpret(items, project, now=None, stale_days=LIMITS["staleDays"]):
    """Turn raw recalled items into advisory records. Never asserts hypotheses as fact."""
    now = now or time.time(); parsed = []
    for item in items:
        if not isinstance(item, dict): continue
        text = client.scrub(item.get("excerpt") or item.get("content") or item.get("text") or "")
        fields = parse_memory(text)
        if fields is not None and fields.get("project") != project: continue  # bank isolation, defence in depth
        parsed.append((item, text, fields))
    reopened = {}
    for _, _, f in parsed:
        if f and f.get("event") == "reopened":
            reopened[f.get("finding")] = max(reopened.get(f.get("finding"), 0), parse_time(f.get("at", "")) or 0)
    out = []
    for item, text, f in parsed:
        score = item.get("score") if isinstance(item.get("score"), (int, float)) else 0.5
        score = max(0.0, min(1.0, float(score)))
        if f is None:
            out.append({"id": str(item.get("id") or item.get("memoryId") or ""), "marker": "hypothesized", "confidence": min(score, 0.4),
                        "stale": False, "provenance": {}, "advice": "Unverified hypothesis (no provenance): " + text[:400]})
            continue
        at = parse_time(f.get("at", "")); verified = f.get("verified") == "true" and f.get("event") == "resolved"
        stale = bool(at and now - at > stale_days * 86400) or bool(at and reopened.get(f.get("finding"), 0) > at and f.get("event") != "reopened")
        summary = f.get("summary", "")
        prefix = "Prior verified fix (advisory, may be stale; re-verify): " if verified else "Prior incident, cause unconfirmed (hypothesis, not fact): "
        out.append({"id": str(item.get("id") or item.get("memoryId") or f.get("key", "")), "marker": "verified" if verified else "hypothesized",
                    "confidence": score if verified else min(score, 0.5), "stale": stale, "event": f.get("event"),
                    "provenance": {"findingId": f.get("finding"), "runId": f.get("run"), "commit": f.get("commit"),
                                   "evidenceIds": [x for x in f.get("evidence", "").split(",") if x]},
                    "advice": prefix + summary + ((" Fix: " + f["fix"]) if f.get("fix") else "") + (" [STALE]" if stale else "")})
    return out[:client.MAX_MEMORIES]

def recall(project, bank, query, timeout=10, now=None, call=None):
    call = call or client.mcp_call
    artifact = {"status": "miss", "bank": bank, "items": []}
    base, token = os.getenv("HINDSIGHT_URL"), os.getenv("HINDSIGHT_AUTH_TOKEN")
    if not enabled() or not bank:
        artifact.update(status="unavailable", warning="Hindsight incident memory disabled; continuing without recall."); return artifact
    try:
        artifact["items"] = interpret(client.memories(call(base, bank, token, "recall", {"query": query[:2500], "budget": "low", "max_tokens": 3000}, timeout)), project, now)
        artifact["status"] = "ok" if artifact["items"] else "miss"
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
        artifact.update(status="unavailable", warning="Hindsight incident recall unavailable; continuing without recall.", errorClass=type(error).__name__)
    return artifact

def main():
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="command", required=True)
    for name in ("enqueue", "flush", "recall"):
        s = sub.add_parser(name); s.add_argument("--project", required=True); s.add_argument("--bank", default="")
        s.add_argument("--outbox", default=".factory/memory/incident-outbox.json"); s.add_argument("--timeout", type=int, default=10)
        s.add_argument("--output", default="")
        if name == "enqueue": s.add_argument("--event", required=True)
        if name == "recall": s.add_argument("--query", required=True)
    a = p.parse_args()
    try:
        if a.command == "enqueue":
            value = enqueue(a.outbox, a.project, a.bank or "project-" + a.project, json.loads(Path(a.event).read_text(encoding="utf-8")))
        elif a.command == "flush": value = flush(a.outbox, a.timeout)
        else: value = recall(a.project, a.bank or "project-" + a.project, a.query, a.timeout)
    except (OSError, ValueError) as error:  # memory must never fail a run
        value = {"status": "unavailable", "errorClass": type(error).__name__}
        print("warning: incident memory unavailable; continuing.", file=sys.stderr)
    if a.output:
        out = Path(a.output); out.parent.mkdir(parents=True, exist_ok=True); out.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(value))
if __name__ == "__main__": main()
