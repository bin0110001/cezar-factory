#!/usr/bin/env python3
"""Command-owned latest-run repair. Known errors and repeat attempts never start an LLM."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

WORKFLOW = "factory-repair-latest-failure"
FACTORY = pathlib.Path(__file__).resolve().parent.parent
PROTECTED = {"stable", "main", "master", "production", "prod"}
PROTECTED_DIRS = (".git", ".factory", ".codex", ".agents")


class RepairError(RuntimeError):
    pass


def redact(text: str) -> str:
    text = re.sub(r"(?i)\b(?:gh[psu]_[\w]{12,}|github_pat_[\w]{12,}|sk-[\w-]{12,})\b", "[REDACTED]", text)
    text = re.sub(r"(?i)(Bearer\s+)\S+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,]+", r"\1=[REDACTED]", text)
    return re.sub(r"(https?://)[^/\s@]+:[^/\s@]+@", r"\1[REDACTED]@", text)


def timestamp(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise RepairError("Run completion timestamps must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def latest_failure(runs: list, exclude: str = "") -> dict | None:
    candidates = []
    for run in runs:
        if run.get("status") != "failed" or run.get("workflow") == WORKFLOW or run.get("id") == exclude:
            continue
        if not isinstance(run.get("id"), str) or not run.get("finishedAt"):
            raise RepairError("A failed run has no identity/completion timestamp; recency is unknown")
        try:
            candidates.append((timestamp(run["finishedAt"]), run["id"], run))
        except (ValueError, TypeError):
            raise RepairError("A failed run has an invalid completion timestamp; recency is unknown")
    return max(candidates, key=lambda item: (item[0], item[1]))[2] if candidates else None


def fingerprint(workflow: str, step: str, evidence: str) -> str:
    normalized = evidence.lower()
    normalized = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[0-9a-f]{32,64}\b", "<id>", normalized)
    normalized = re.sub(r"\b\d{4}-\d\d-\d\d[t ][\d:.]+(?:z|[+-]\d\d:\d\d)?", "<time>", normalized)
    normalized = re.sub(r"[\\/]\.ai[\\/]cezar[\\/]worktrees[\\/][^\s/\\]+", "/<worktree>", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return hashlib.sha256(f"{workflow}|{step}|{normalized}".encode()).hexdigest()


def classify(evidence: str, rules: list[dict]) -> dict:
    # A failing assertion involving a network message is still a code/test defect.
    if re.search(r"AssertionError|SyntaxError|TypeError|assertion failed|schema validation failed", evidence, re.I):
        return {"classification": "unknown", "rule": None, "reason": "Concrete source/test diagnostic requires investigation"}
    for rule in rules:
        if rule.get("action") != "skip-operational" or not rule.get("id") or not rule.get("reason"):
            raise RepairError("Known-failure rules require id, skip-operational action and reason")
        if re.search(rule["pattern"], evidence, re.I):
            return {"classification": "operational", "rule": rule["id"], "reason": rule["reason"]}
    return {"classification": "unknown", "rule": None, "reason": "No confirmed operational signature matched"}


def request(base: str, project: str, suffix: str, limit: int = 8_388_608) -> bytes:
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RepairError("Cezar API must be an HTTP(S) URL without credentials, query or fragment")
    url = base.rstrip("/") + "/api/v1/p/" + urllib.parse.quote(project, safe="") + suffix
    with urllib.request.urlopen(url, timeout=15) as response:
        value = response.read(limit + 1)
    if len(value) > limit:
        raise RepairError("Cezar evidence exceeds the read budget; refusing incomplete selection")
    return value


def load_failure(api: str, project: str, exclude: str) -> dict | None:
    runs = json.loads(request(api, project, "/runs"))
    if isinstance(runs, dict):
        runs = runs.get("runs")
    if not isinstance(runs, list):
        raise RepairError("Cezar returned an invalid run list")
    run = latest_failure(runs, exclude)
    if run is None:
        return None
    steps = [step for step in run.get("steps", []) if step.get("status") == "failed"]
    step = steps[-1].get("id", "") if steps else ""
    errors = [str(run.get("error", ""))] + [str(item.get("error", "")) for item in steps]
    run_path = "/runs/" + urllib.parse.quote(run["id"], safe="")
    page = json.loads(request(api, project, run_path + "/history", 2_097_152))
    events = page.get("events", [])
    output = [str(event.get("text", event.get("message", ""))) for event in events
              if event.get("stepId") == step and
              (event.get("type") in ("error", "session.error") or
               event.get("type") == "check-output" and event.get("exitCode") not in (None, 0))]
    # The handoff is finite, unlike the live events SSE endpoint. Never fetch another worktree.
    handoff = request(api, project, run_path + "/handoff", 65536).decode("utf-8", errors="replace")
    lines = [line for line in handoff.splitlines() if re.search(r"error|failed|failure|exception|refused|unavailable|HTTP\s*[45]\d\d", line, re.I)]
    diagnostics = redact("\n".join(errors + output[-2:]))[-12000:]
    evidence = redact("\n".join(lines[-6:] + errors + output[-2:]))[-12000:]
    definition = run.get("workflowDef") or {}
    selected_command = next((str(s.get("command", "")) for s in definition.get("steps", []) if s.get("id") == step), "")
    return {"runId": run["id"], "workflow": run.get("workflow", ""), "step": step,
            "finishedAt": run["finishedAt"], "issue": run.get("issueNumber"),
            "evidence": evidence, "diagnostics": diagnostics, "command": redact(selected_command)[:2000],
            "fingerprint": fingerprint(run.get("workflow", ""), step, diagnostics)}


def command(argv: list[str], cwd: pathlib.Path, *, timeout: int = 60, stdin: str | None = None, env: dict | None = None, output_limit: int = 65536) -> str:
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x for x in argv):
        raise RepairError("Commands must be nonempty argv arrays")
    # Temporary output files bound memory even if a compiler or agent prints a huge transcript.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                stdout=output, stderr=errors, env=env, start_new_session=os.name != "nt")
        try:
            proc.communicate(stdin.encode() if stdin is not None else None, timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
            proc.wait()
            raise RepairError(f"{argv[0]} exceeded its {timeout}s deadline")
        size = output.tell()
        if size > output_limit and argv[0] == "git":
            raise RepairError("Git output exceeds the read budget")
        output.seek(max(0, size - output_limit))
        text = output.read(output_limit).decode("utf-8", errors="replace")
        errors.seek(max(0, errors.tell() - 4000))
        diagnostics = errors.read(4000).decode("utf-8", errors="replace")
    if proc.returncode:
        raise RepairError(f"{argv[0]} exited {proc.returncode}: {redact((text + diagnostics)[-4000:])}")
    return text.rstrip("\r\n")


def git(root: pathlib.Path, *args: str) -> str:
    return command(["git", *args], root)


def changed_files(root: pathlib.Path) -> list[str]:
    paths = git(root, "diff", "--name-only", "HEAD", "-z").split("\0")
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    paths += [path for path in untracked if not path.startswith(".factory/")]
    return sorted({path for path in paths if path})


class History:
    def __init__(self, path: pathlib.Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=15)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS failures (
            project TEXT NOT NULL, fingerprint TEXT NOT NULL, classification TEXT NOT NULL,
            state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, occurrences INTEGER NOT NULL DEFAULT 1,
            first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, run_id TEXT NOT NULL,
            payload TEXT NOT NULL, PRIMARY KEY(project, fingerprint))""")
        self.db.commit()

    def observe(self, project: str, failure: dict, classification: str) -> dict:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        with self.db:
            self.db.execute("""INSERT INTO failures(project,fingerprint,classification,state,first_seen,last_seen,run_id,payload)
                VALUES(?,?,?,'observed',?,?,?,?) ON CONFLICT(project,fingerprint) DO UPDATE SET
                occurrences=occurrences+CASE WHEN run_id<>excluded.run_id THEN 1 ELSE 0 END,
                last_seen=excluded.last_seen,run_id=excluded.run_id""",
                (project, failure["fingerprint"], classification, now, now, failure["runId"], json.dumps(failure)))
        return dict(self.db.execute("SELECT * FROM failures WHERE project=? AND fingerprint=?", (project, failure["fingerprint"])).fetchone())

    def reserve(self, project: str, key: str) -> bool:
        with self.db:
            row = self.db.execute("UPDATE failures SET attempts=attempts+1,state='repairing' WHERE project=? AND fingerprint=? AND attempts=0", (project, key))
        return row.rowcount == 1

    def update(self, project: str, key: str, state: str, payload: dict):
        with self.db:
            self.db.execute("UPDATE failures SET state=?,payload=? WHERE project=? AND fingerprint=?", (state, json.dumps(payload), project, key))


def project_settings(config: dict, registry: list, project: str) -> dict:
    if config.get("schemaVersion") != 1 or not isinstance(config.get("projects"), dict):
        raise RepairError("Failure-repair configuration must use schemaVersion 1 and explicit projects")
    targets = [target for target in registry if target.get("projectId") == project]
    if len(targets) != 1:
        raise RepairError("Project must occur exactly once in config/factory-projects.json")
    setting = config["projects"].get(project)
    if not isinstance(setting, dict):
        raise RepairError("Project has no explicit failure-repair configuration")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", setting.get("repository", "")):
        raise RepairError("Repair repository must be explicitly configured as owner/name")
    for field in ("baseBranch", "channel"):
        value = setting.get(field, "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", value) or value.rsplit("/", 1)[-1].lower() in PROTECTED:
            raise RepairError(f"Repair {field} must explicitly select a non-stable target")
    for field in ("validation",):
        values = setting.get(field)
        if not isinstance(values, list) or not values:
            raise RepairError(f"Project requires explicit nonempty {field} argv arrays")
        if any(not isinstance(v, list) or not v or not all(isinstance(s, str) and s for s in v) for v in values):
            raise RepairError(f"Invalid {field} command")
    deployment = setting.get("deployment", {})
    if deployment.get("kind") == "factory":
        if setting["channel"] != "dev" or setting["repository"] != "bin0110001/cezar-factory":
            raise RepairError("Factory deployment supports only the configured cezar-factory dev channel")
        for field in ("repo", "store", "registry"):
            if not isinstance(deployment.get(field), str) or not pathlib.Path(deployment[field]).is_absolute():
                raise RepairError(f"Factory deployment requires an absolute host-local {field} path")
    elif deployment.get("kind") == "commands":
        commands = deployment.get("commands", [])
        if not isinstance(commands, list) or not commands:
            raise RepairError("Application deployment commands must be explicitly configured")
        for argv in commands:
            if not isinstance(argv, list) or not argv or not all(isinstance(s, str) and s for s in argv):
                raise RepairError("Deployment commands must be argv arrays")
            if not all(token in " ".join(argv) for token in ("{channel}", "{mergeSha}")):
                raise RepairError("Deployment commands must bind both {channel} and {mergeSha}")
            if any(re.search(r"(?:^|[=/])(?:stable|production|prod)(?:$|/)|promote-stable", s, re.I) for s in argv):
                raise RepairError("Stable deployment is forbidden in the repair workflow")
    else:
        raise RepairError("Explicit factory or commands deployment configuration is required")
    model = config.get("model", "")
    if not debug_mode() and not re.fullmatch(r"gpt-[A-Za-z0-9_.-]+", model):
        raise RepairError("A hosted GPT model ID is required; gateway aliases are not accepted")
    timeout = config.get("timeoutSeconds", 900)
    if not isinstance(timeout, int) or not 30 <= timeout <= 1200:
        raise RepairError("Hosted repair timeoutSeconds must be between 30 and 1200")
    return {**setting, "model": model, "timeoutSeconds": timeout}


def safe_path(root: pathlib.Path, path: str) -> pathlib.Path:
    relative = pathlib.PurePosixPath(path)
    if not path or "\\" in path or relative.is_absolute() or ".." in relative.parts or relative.parts[0] in PROTECTED_DIRS:
        raise RepairError("Protected or non-relative source path")
    target = root / path
    if not target.resolve().is_relative_to(root.resolve()):
        raise RepairError("Source path escapes the task worktree")
    return target


def validate_result(value: dict, root: pathlib.Path, *, verify_changes: bool = True) -> dict:
    if set(value) != {"status", "classification", "rootCause", "summary", "files", "patch", "requestedFiles", "selfReview"}:
        raise RepairError("Invalid hosted repair result fields")
    if value["status"] not in ("repaired", "unresolved", "needs-context") or value["classification"] not in ("code", "test", "configuration", "operational", "unknown"):
        raise RepairError("Invalid repair status or classification")
    review = value["selfReview"]
    if not isinstance(review, dict) or set(review) != {"scope", "risk", "invariants", "unresolvedFindings"}:
        raise RepairError("A structured self-review is required")
    for text in [value["rootCause"], value["summary"], review["scope"], review["risk"], review["invariants"]]:
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
            raise RepairError("Repair summaries and self-review must contain bounded text")
    if not isinstance(review["unresolvedFindings"], list) or len(review["unresolvedFindings"]) > 20:
        raise RepairError("Invalid unresolved findings")
    paths = value["files"]
    if not isinstance(paths, list) or len(paths) > 30 or any(not isinstance(p, str) for p in paths) or len(set(paths)) != len(paths):
        raise RepairError("Invalid repair file manifest")
    for path in paths:
        safe_path(root, path)
    if not isinstance(value["patch"], str) or len(value["patch"]) > 65536:
        raise RepairError("Repair patch exceeds its budget")
    requests = value["requestedFiles"]
    if not isinstance(requests, list) or len(requests) > 8:
        raise RepairError("At most eight source ranges can be requested")
    allowed = []
    for item in requests:
        if not isinstance(item, dict) or set(item) != {"path", "startLine", "endLine"}:
            raise RepairError("Invalid source range request")
        try:
            safe_path(root, item["path"])
        except RepairError:
            # A model asking for run scratch (.factory/...) is expected; ignore the request, do not abort the repair.
            continue
        start, end = item["startLine"], item["endLine"]
        if not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start or end - start >= 400:
            raise RepairError("Source requests are limited to 400 lines each")
        allowed.append(item)
    value["requestedFiles"] = allowed
    if value["status"] != "repaired" and (paths or value["patch"]):
        raise RepairError("Only a repaired result can contain a patch")
    if verify_changes and sorted(paths) != changed_files(root):
        raise RepairError("Repair file manifest does not exactly match the worktree changes")
    return value


def source_context(root: pathlib.Path, failure: dict, requests: list | None = None) -> dict:
    tracked = set(command(["git", "ls-files", "-z"], root, output_limit=2_097_152).split("\0"))
    tracked.discard("")
    # Run scratch such as .factory/*.json is tracked in this repo and named by failure evidence, but safe_path
    # forbids it; leave protected directories out of the requestable set instead of aborting the whole repair.
    tracked = {p for p in tracked if pathlib.PurePosixPath(p).parts[0] not in PROTECTED_DIRS}
    words = set(re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", failure["evidence"] + " " + failure["workflow"]))
    ranked = sorted(tracked, key=lambda p: (-sum(word.lower() in p.lower() for word in words), p))
    catalog = "\n".join(ranked[:150])[:6000]
    if requests is None:
        paths = ["AGENTS.md", "workflows/" + failure["workflow"].removeprefix("factory-") + ".yaml"]
        references = (failure["evidence"] + " " + failure.get("command", "")).replace("$FACTORY_RUNTIME_ROOT/", "").replace("${FACTORY_RUNTIME_ROOT}/", "")
        references = references.replace(str(root).replace("\\", "/") + "/", "")
        paths += re.findall(r"(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:ps1|py|ya?ml|[cm]?[jt]sx?|json|sh|toml)", references)
        # Include directly dot-sourced PowerShell helpers without executing them.
        for path in list(dict.fromkeys(paths)):
            if path in tracked and path.endswith(".ps1"):
                target = safe_path(root, path)
                if target.stat().st_size <= 16384:
                    for imported in re.findall(r"Join-Path\s+\$PSScriptRoot\s+['\"]([^'\"]+\.ps1)['\"]", target.read_text(encoding="utf-8")):
                        dependency = (target.parent / imported).resolve()
                        if dependency.is_relative_to(root.resolve()):
                            paths.append(dependency.relative_to(root.resolve()).as_posix())
        requests = [{"path": path, "startLine": 1, "endLine": 400} for path in dict.fromkeys(paths) if path in tracked][:8]
    # Always supply the applicable contributor instructions with requested source.
    instructions = {"AGENTS.md"}
    for item in requests:
        for parent in pathlib.PurePosixPath(item["path"]).parents:
            instructions.add(str(parent / "AGENTS.md"))
    records = []
    budget = 48000
    combined = [{"path": p, "startLine": 1, "endLine": 400} for p in sorted(instructions) if p in tracked]
    combined += [item for item in requests if item["path"] not in instructions]
    for item in combined:
        path = item["path"]
        if path not in tracked:
            raise RepairError("Source requests must name tracked repository files")
        target = safe_path(root, path)
        if target.stat().st_size > 1_048_576:
            raise RepairError("Requested source file exceeds the read budget")
        lines = target.read_text(encoding="utf-8").splitlines(keepends=True)
        content = "".join(lines[item["startLine"] - 1:item["endLine"]])
        shown = content[:budget]
        records.append(dict(item, content=shown, truncated=len(shown) != len(content) or len(lines) > item["endLine"]))
        budget -= len(shown)
        if not budget:
            break
    return {"fileCatalog": catalog, "catalogPartial": len(tracked) > 150, "sources": records}


def apply_repair(root: pathlib.Path, result: dict, check_only: bool = False):
    patch = result["patch"]
    if not patch:
        raise RepairError("Repaired result has no patch")
    if re.search(r"(?m)^(?:rename (?:from|to) |copy (?:from|to) |GIT binary patch|Binary files )", patch):
        raise RepairError("Binary, copy and rename patches are not supported")
    stats = command(["git", "apply", "--numstat", "-z", "-"], root, stdin=patch)
    paths = []
    for record in stats.split("\0"):
        if not record:
            continue
        parts = record.split("\t", 2)
        if len(parts) != 3 or not parts[2] or not parts[0].isdigit() or not parts[1].isdigit():
            raise RepairError("Only plain text patches without renames are supported")
        safe_path(root, parts[2])
        paths.append(parts[2])
    if sorted(paths) != sorted(result["files"]):
        raise RepairError("Patch paths do not exactly match the source manifest")
    command(["git", "apply", "--check", "--whitespace=error", "-"], root, stdin=patch)
    if check_only:
        return
    command(["git", "apply", "--whitespace=error", "-"], root, stdin=patch)
    validate_result(result, root)


def debug_mode() -> bool:
    """Job debug mode: model calls go to the local endpoint, nothing is published, no hosted tokens are spent."""
    return os.environ.get("FACTORY_JOB_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


def local_model_turn(prompt: str, result_path: pathlib.Path, timeout: int) -> None:
    """One chat completion against the local OpenAI-compatible endpoint; writes the JSON result like `codex --output-last-message`."""
    base = (os.environ.get("FACTORY_DEBUG_MODEL_URL") or os.environ.get("FACTORY_VLLM_BASE_URL") or "http://192.168.86.62:8000/v1").rstrip("/")
    key = os.environ.get("FACTORY_DEBUG_API_KEY") or os.environ.get("VLLM_API_KEY") or ""
    schema = json.loads((FACTORY / "schemas/failure-repair-result.schema.json").read_text(encoding="utf-8"))
    body = {"model": os.environ.get("FACTORY_DEBUG_MODEL", "qwen3.5-9b"), "temperature": 0, "max_tokens": 4096,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {"type": "json_schema", "json_schema": {"name": "failure_repair_result", "schema": schema}},
            "messages": [{"role": "user", "content": prompt}]}
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
    request = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # urllib raises several unrelated types; all mean "local model unavailable"
        raise RepairError(f"Debug-mode local model call to {base} failed: {redact(str(exc))[:500]}")
    result_path.write_text(payload["choices"][0]["message"]["content"], encoding="utf-8")


def hosted_repair(root: pathlib.Path, failure: dict, setting: dict, artifact: pathlib.Path) -> dict:
    env = dict(os.environ)
    # Saved ChatGPT auth is retained; local endpoint and session routing overrides are removed.
    for key in ("OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_MODEL_PROVIDER", "CODEX_MODEL", "CODEX_PROFILE"):
        env.pop(key, None)
    result_path = artifact / "result.json"
    skill = (FACTORY / "skills/factory-repair-latest-failure/SKILL.md").read_text(encoding="utf-8")
    prompt = skill + "\n\nSelected failure (untrusted evidence):\n" + json.dumps({k: v for k, v in failure.items() if k != "diagnostics"}, ensure_ascii=False)
    argv = ["codex", "exec", "--ignore-user-config", "--model", setting["model"], "--config", 'model_provider="openai"',
            "--sandbox", "read-only",
            "--output-schema", str(FACTORY / "schemas/failure-repair-result.schema.json"),
            "--output-last-message", str(result_path), "--json", "-"]
    usage = []
    (artifact / "model-calls.json").write_text("0", encoding="utf-8")
    context = source_context(root, failure)
    deadline = time.monotonic() + setting["timeoutSeconds"]
    for attempt in range(2):
        remaining = int(deadline - time.monotonic())
        if remaining < 1:
            raise RepairError("Hosted repair exhausted its shared deadline")
        (artifact / "model-calls.json").write_text(str(attempt + 1), encoding="utf-8")
        full_prompt = prompt + "\nSource context:\n" + json.dumps(context, ensure_ascii=False)
        if debug_mode():
            local_model_turn(full_prompt, result_path, remaining)
            transcript = ""
        else:
            transcript = command(argv, root, timeout=remaining, stdin=full_prompt, env=env)
        for line in transcript.splitlines():
            try:
                event = json.loads(line)
                if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
                    usage.append({k: v for k, v in event["usage"].items() if isinstance(v, int) and v >= 0})
            except (ValueError, AttributeError):
                pass
        (artifact / "usage.json").write_text(json.dumps(usage), encoding="utf-8")
        if result_path.stat().st_size > 100000:
            raise RepairError("Hosted repair result exceeds its size budget")
        result = validate_result(json.loads(result_path.read_text(encoding="utf-8")), root, verify_changes=False)
        if result["status"] != "needs-context":
            return result
        if not result["requestedFiles"] or attempt:
            result["status"] = "unresolved"
            return result
        context = {"initial": context, "additional": source_context(root, failure, result["requestedFiles"])}
        prompt += "\nThis is the final context round; return a patch or unresolved."


def gh(root: pathlib.Path, *args: str, json_result: bool = False):
    result = command(["gh", *args], root)
    return json.loads(result) if json_result else result


def expected_origin(remote: str, repository: str) -> bool:
    if remote.startswith("git@github.com:"):
        return remote[len("git@github.com:"):].removesuffix(".git") == repository
    parsed = urllib.parse.urlsplit(remote)
    return (parsed.scheme in ("https", "ssh") and parsed.hostname == "github.com"
            and not parsed.password and parsed.path.strip("/").removesuffix(".git") == repository)


def publish(root: pathlib.Path, setting: dict, payload: dict, artifact: pathlib.Path) -> dict:
    repository = setting["repository"]
    prs = gh(root, "pr", "list", "--repo", repository, "--head", payload["branch"], "--state", "all", "--json", "number,url,headRefOid,baseRefName,state", json_result=True)
    if prs:
        pr = prs[0]
    else:
        result = payload["result"]
        body = artifact / "pr-body.md"
        body.write_text(f"{result['summary']}\n\nCause: {result['rootCause']}\n\n"
                        f"Source run: `{payload['runId']}`; fingerprint: `{payload['fingerprint']}`.\n\n"
                        f"Validation passed: {json.dumps(payload['validation'])}\n\n"
                        f"<!-- factory-failure-repair:{payload['fingerprint']} -->\n", encoding="utf-8")
        gh(root, "pr", "create", "--repo", repository, "--base", setting["baseBranch"], "--head", payload["branch"],
           "--title", "Repair latest workflow failure: " + payload["workflow"][:100], "--body-file", str(body))
        pr = gh(root, "pr", "view", payload["branch"], "--repo", repository, "--json", "number,url,headRefOid,baseRefName", json_result=True)
    if pr["headRefOid"] != payload["headSha"] or pr["baseRefName"] != setting["baseBranch"]:
        raise RepairError("Repair PR head/base do not match the validated change")
    if pr.get("state") in ("MERGED", "CLOSED"):
        return dict(payload, pr=pr["url"])
    author = gh(root, "api", "user", "--jq", ".login")
    collaborators = gh(root, "api", f"repos/{repository}/collaborators?per_page=100", json_result=True)
    if len(collaborators) >= 100:
        raise RepairError("Reviewer discovery exceeded its page budget; solo-maintainer status is unknown")
    reviewers = [c["login"] for c in collaborators if c["login"] != author and c.get("type") != "Bot"
                 and any(c.get("permissions", {}).get(p) for p in ("admin", "maintain", "push"))]
    if reviewers:
        gh(root, "pr", "edit", str(pr["number"]), "--repo", repository, "--add-reviewer", reviewers[0])
        payload.update(pr=pr["url"], review="requested")
    else:
        body = artifact / "self-review.md"
        body.write_text("Structured self-review (solo maintainer)\n\n" + "\n\n".join(
            f"{k}: {v}" for k, v in payload["result"]["selfReview"].items()) +
            "\n\nValidation evidence: " + json.dumps(payload["validation"]) + "\nUnresolved findings: none.\n", encoding="utf-8")
        gh(root, "pr", "comment", str(pr["number"]), "--repo", repository, "--body-file", str(body))
        gh(root, "pr", "merge", str(pr["number"]), "--repo", repository, "--auto", "--squash", "--match-head-commit", payload["headSha"])
        payload.update(pr=pr["url"], review="self-reviewed", autoMergeRequested=True)
    return payload


def debug_repair(root: pathlib.Path, failure: dict, setting: dict, artifact: pathlib.Path) -> dict:
    """Local-model dry run: ask the local model, dry-check its patch, change nothing (no reset, commit, push, PR or budget use)."""
    result = hosted_repair(root, failure, setting, artifact)
    outcome = {"status": "debug-" + result["status"], "fingerprint": failure["fingerprint"], "modelCalls": 0,
               "localModelCalls": int((artifact / "model-calls.json").read_text() or 0), "classification": result.get("classification"),
               "files": result.get("files"), "resultPath": str(artifact / "result.json")}
    if result["status"] == "repaired" and result.get("files"):
        try:
            apply_repair(root, result, check_only=True)
            outcome["patchApplies"] = True
        except RepairError as exc:
            outcome["patchApplies"] = False
            outcome["patchError"] = redact(str(exc))[:1000]
    return outcome


def repair(root: pathlib.Path, failure: dict, setting: dict, history: History, project: str, artifact: pathlib.Path):
    if debug_mode():
        return debug_repair(root, failure, setting, artifact)
    if changed_files(root) or git(root, "diff", "--cached", "--name-only"):
        raise RepairError("Task worktree contains source changes; refusing to overwrite unrelated work")
    branch = git(root, "branch", "--show-current")
    if not branch or branch.lower() in PROTECTED or branch == setting["baseBranch"]:
        raise RepairError("Repairs require an isolated task branch")
    remote = git(root, "remote", "get-url", "origin")
    if not expected_origin(remote, setting["repository"]):
        raise RepairError("Task origin does not match the configured repair repository")
    git(root, "fetch", "origin", setting["baseBranch"])
    if git(root, "rev-parse", "HEAD") != git(root, "rev-parse", "FETCH_HEAD"):
        # The task branch is cut from stable, which need not be an ancestor of the repair base branch.
        # A clean branch with no commits of its own can safely be moved; never discard unpushed work.
        if git(root, "rev-list", "HEAD", "--not", "--remotes"):
            git(root, "merge", "--ff-only", "FETCH_HEAD")
        else:
            git(root, "reset", "--hard", "FETCH_HEAD")
    if git(root, "rev-parse", "HEAD") != git(root, "rev-parse", "FETCH_HEAD"):
        raise RepairError("Task cannot fast-forward to the configured non-stable branch head")
    # Reserve atomically immediately before the first paid call; a crashed process does not refund it.
    if not history.reserve(project, failure["fingerprint"]):
        return {"status": "skipped", "reason": "attempt-budget-exhausted", "modelCalls": 0}
    payload = dict(failure, branch=branch)
    try:
        payload["modelCalls"] = 1
        result = hosted_repair(root, failure, setting, artifact)
        calls_path = artifact / "model-calls.json"
        payload["modelCalls"] = int(calls_path.read_text()) if calls_path.is_file() else 1
        usage_path = artifact / "usage.json"
        if usage_path.is_file():
            payload["usage"] = json.loads(usage_path.read_text(encoding="utf-8"))
        payload["result"] = result
        with history.db:
            history.db.execute("UPDATE failures SET classification=? WHERE project=? AND fingerprint=?", (result["classification"], project, failure["fingerprint"]))
        if result["status"] != "repaired" or not result["files"] or result["selfReview"]["unresolvedFindings"] or result["classification"] in ("unknown", "operational"):
            history.update(project, failure["fingerprint"], "unresolved", payload)
            return {"status": "unresolved", "fingerprint": failure["fingerprint"], "modelCalls": payload["modelCalls"]}
        apply_repair(root, result)
        git(root, "diff", "--check")
        validation = []
        for argv in setting["validation"]:
            command(argv, root, timeout=1200)
            validation.append({"command": argv, "status": "passed"})
        # Validation may create files or alter source; the tested manifest must still match.
        validate_result(result, root)
        git(root, "add", "--", *result["files"])
        git(root, "commit", "-m", f"Repair workflow failure {failure['fingerprint'][:12]}")
        payload.update(headSha=git(root, "rev-parse", "HEAD"), validation=validation)
        git(root, "push", "origin", f"HEAD:refs/heads/{branch}")
        history.update(project, failure["fingerprint"], "pending-pr", payload)
        payload = publish(root, setting, payload, artifact)
        history.update(project, failure["fingerprint"], "pr-open", payload)
        return {"status": "pr-open", "pr": payload["pr"], "fingerprint": failure["fingerprint"], "modelCalls": payload["modelCalls"]}
    except Exception as exc:
        calls_path = artifact / "model-calls.json"
        if calls_path.is_file():
            payload["modelCalls"] = int(calls_path.read_text())
        payload["error"] = redact(str(exc))[:4000]
        # Preserve a pushed branch's publication checkpoint for a later zero-model retry.
        row = history.db.execute("SELECT state FROM failures WHERE project=? AND fingerprint=?", (project, failure["fingerprint"])).fetchone()
        history.update(project, failure["fingerprint"], "pending-pr" if row["state"] == "pending-pr" else "unresolved", payload)
        raise


def deploy_factory(setting: dict, sha: str) -> dict:
    # Reuse the transactional activation controller, including rollback and parity checks.
    if str(FACTORY) not in sys.path:
        sys.path.insert(0, str(FACTORY))
    from scripts.release.factory_activation import ActivationCoordinator
    from scripts.release.factory_release_controller import ReleaseController, exclusive_lock
    cfg = setting["deployment"]
    repository = pathlib.Path(cfg["repo"])
    if git(repository, "status", "--porcelain"):
        raise RepairError("Factory deployment checkout is dirty; refusing to alter it")
    git(repository, "fetch", "origin", setting["channel"])
    git(repository, "merge-base", "--is-ancestor", sha, "FETCH_HEAD")
    controller = ReleaseController(repository, pathlib.Path(cfg["store"]), "origin", setting["channel"], 3, 30, 4)
    with exclusive_lock(controller.store / "controller.lock"):
        controller.stage_sha(sha)
    return ActivationCoordinator(controller, pathlib.Path(cfg["registry"])).activate(sha)


def deploy(root: pathlib.Path, setting: dict, history: History, project: str, artifact: pathlib.Path) -> dict:
    if str(FACTORY) not in sys.path:
        sys.path.insert(0, str(FACTORY))
    from scripts.release.factory_release_controller import exclusive_lock
    with exclusive_lock(history.path.with_suffix(".deployment.lock")):
        return deploy_locked(root, setting, history, project, artifact)


def deploy_locked(root: pathlib.Path, setting: dict, history: History, project: str, artifact: pathlib.Path) -> dict:
    outcomes = []
    rows = history.db.execute("SELECT * FROM failures WHERE project=? AND state IN ('pending-pr','pr-open','deploying') ORDER BY last_seen LIMIT 10", (project,)).fetchall()
    for row in rows:
        payload = json.loads(row["payload"])
        if row["state"] == "pending-pr":
            payload = publish(root, setting, payload, artifact)
            history.update(project, row["fingerprint"], "pr-open", payload)
        pr = gh(root, "pr", "view", payload["pr"], "--repo", setting["repository"], "--json", "state,baseRefName,headRefOid,mergeCommit,reviewDecision,statusCheckRollup", json_result=True)
        if pr["baseRefName"] != setting["baseBranch"] or pr["headRefOid"] != payload["headSha"]:
            raise RepairError("PR changed after validation; deployment refused")
        if pr["state"] == "OPEN":
            if payload.get("review") == "requested" and pr.get("reviewDecision") == "APPROVED":
                gh(root, "pr", "merge", payload["pr"], "--repo", setting["repository"], "--auto", "--squash", "--match-head-commit", payload["headSha"])
            outcomes.append({"pr": payload["pr"], "status": "awaiting-reviewed-merge"})
            continue
        if pr["state"] != "MERGED":
            history.update(project, row["fingerprint"], "closed-unmerged", payload)
            continue
        if payload.get("review") != "self-reviewed" and not (payload.get("review") == "requested" and pr.get("reviewDecision") == "APPROVED"):
            raise RepairError("Merged repair has no completed technical review gate")
        # A merge alone does not prove validation. Reject incomplete or failed required checks.
        checks = pr.get("statusCheckRollup") or []
        if not checks or any(c.get("conclusion", c.get("state")) not in ("SUCCESS", "NEUTRAL", "SKIPPED") for c in checks):
            raise RepairError("Merged PR lacks complete passing CI evidence")
        sha = pr.get("mergeCommit", {}).get("oid", "")
        if not re.fullmatch(r"[0-9a-f]{40,64}", sha):
            raise RepairError("Merged PR has no verified merge SHA")
        # Host-local deployment commands own the supported service/channel flow. No stable default.
        payload["mergeSha"] = sha
        history.update(project, row["fingerprint"], "deploying", payload)
        if setting["deployment"]["kind"] == "factory":
            payload["deploymentResult"] = deploy_factory(setting, sha)
        else:
            env = dict(os.environ, FACTORY_DEPLOY_BRANCH=setting["baseBranch"], FACTORY_CONTROLLER_CHANNEL=setting["channel"])
            deadline = time.monotonic() + 1200
            for argv in setting["deployment"]["commands"]:
                remaining = int(deadline - time.monotonic())
                if remaining < 1:
                    raise RepairError("Application deployment exhausted its shared deadline")
                command([x.replace("{mergeSha}", sha).replace("{channel}", setting["channel"]) for x in argv], root, timeout=remaining, env=env)
        history.update(project, row["fingerprint"], "deployed", payload)
        outcomes.append({"pr": payload["pr"], "status": "deployed", "channel": setting["channel"], "mergeSha": sha})
        break  # One deployment per reconciliation keeps the workflow's deadline bounded.
    return {"status": "reconciled", "modelCalls": 0, "outcomes": outcomes}


def probe(root: pathlib.Path, args) -> dict:
    """Model-free, side-effect-free rehearsal of `run`: select, classify, validate settings, assemble the model context.

    This is the promotion canary: it exercises every code path that precedes the model call (the part a bad release
    breaks) without a model, a history database, git changes or publication, so it cannot be blocked by GPU health.
    """
    failure = load_failure(args.api_url, args.project, os.environ.get("CEZ_TASK_ID", ""))
    if failure is None:
        return {"status": "skipped", "reason": "no-failed-run"}
    rules = json.loads((FACTORY / "config/known-failures.json").read_text(encoding="utf-8"))["rules"]
    verdict = classify(failure.get("diagnostics", failure["evidence"]), rules)
    # Host-local target configuration is allowed to be absent (a Dev host); a present one must validate.
    configured = args.config.is_file() and args.registry.is_file()
    if configured:
        project_settings(json.loads(args.config.read_text(encoding="utf-8")), json.loads(args.registry.read_text(encoding="utf-8")), args.project)
    context = source_context(root, failure)
    skill = (FACTORY / "skills/factory-repair-latest-failure/SKILL.md").read_text(encoding="utf-8")
    json.loads((FACTORY / "schemas/failure-repair-result.schema.json").read_text(encoding="utf-8"))
    return {"status": "probe-ok", "runId": failure["runId"], "classification": verdict["classification"], "fingerprint": failure["fingerprint"],
            "configuration": "valid" if configured else "absent", "sourceFiles": len(context["sources"]), "skillBytes": len(skill)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("run", "inspect", "deploy", "probe"))
    parser.add_argument("--api-url", default=os.environ.get("CEZ_API_URL", os.environ.get("CEZAR_API_URL", "")))
    parser.add_argument("--project", default=os.environ.get("CEZ_PROJECT_ID", os.environ.get("CEZAR_PROJECT_ID", "")))
    source_root = pathlib.Path(os.environ.get("FACTORY_RUNTIME_SOURCE_ROOT", str(FACTORY)))
    parser.add_argument("--config", type=pathlib.Path, default=pathlib.Path(os.environ.get("FACTORY_FAILURE_REPAIR_CONFIG", str(source_root / "config/failure-repair.json"))))
    parser.add_argument("--registry", type=pathlib.Path, default=pathlib.Path(os.environ.get("FACTORY_PROJECTS_REGISTRY", str(source_root / "config/factory-projects.json"))))
    parser.add_argument("--history", type=pathlib.Path)
    args = parser.parse_args(argv)
    root = pathlib.Path.cwd()
    artifact = root / ".factory/repair-latest-failure"
    artifact.mkdir(parents=True, exist_ok=True)
    receipt = {"schemaVersion": 1, "status": "failed", "modelCalls": 0, "project": args.project}
    try:
        if not args.project or not re.fullmatch(r"[\w.-]+", args.project):
            raise RepairError("Explicit Cezar project ID is required")
        if args.phase == "probe":
            receipt.update(probe(root, args))
            return 0
        common = pathlib.Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        # Debug runs keep their own scratch history so they never consume or mask a real attempt budget.
        scratch = artifact / "debug-history.sqlite"
        if debug_mode():
            scratch.unlink(missing_ok=True)
        history = History(args.history or (scratch if debug_mode() else common.parent / ".ai/cezar/failure-repair.sqlite"))
        if args.phase != "deploy":
            failure = load_failure(args.api_url, args.project, os.environ.get("CEZ_TASK_ID", ""))
            if failure is None:
                receipt.update(status="skipped", reason="no-failed-run")
                return 0
            rules = json.loads((FACTORY / "config/known-failures.json").read_text(encoding="utf-8"))["rules"]
            verdict = classify(failure.get("diagnostics", failure["evidence"]), rules)
            row = history.observe(args.project, failure, verdict["classification"])
            receipt.update(failure=failure, **verdict)
            if row["attempts"]:
                receipt.update(status="skipped", reason="known-fingerprint-attempt-budget-exhausted", previousState=row["state"], classification=row["classification"], pr=json.loads(row["payload"]).get("pr"))
                return 0
            if verdict["classification"] == "operational":
                history.update(args.project, failure["fingerprint"], "skipped-operational", failure)
                receipt.update(status="skipped")
                return 0
            if args.phase == "inspect":
                receipt.update(status="unknown", reason="inspection-only")
                return 0
        if args.phase == "deploy" and not history.db.execute("SELECT 1 FROM failures WHERE project=? AND state IN ('pending-pr','pr-open','deploying') LIMIT 1", (args.project,)).fetchone():
            receipt.update(status="skipped", reason="no-pending-repairs")
            return 0
        if not args.config.is_file() or not args.registry.is_file():
            raise RepairError("Needs target configuration: host-local failure-repair.json and factory-projects.json are required")
        setting = project_settings(json.loads(args.config.read_text(encoding="utf-8")), json.loads(args.registry.read_text(encoding="utf-8")), args.project)
        if args.phase == "deploy":
            receipt.update(deploy(root, setting, history, args.project, artifact))
        else:
            receipt.update(repair(root, failure, setting, history, args.project, artifact))
        return 0
    except Exception as exc:
        if "history" in locals() and "failure" in locals() and failure:
            saved = history.db.execute("SELECT payload FROM failures WHERE project=? AND fingerprint=?", (args.project, failure["fingerprint"])).fetchone()
            if saved and "row" in locals() and not row["attempts"]:
                receipt["modelCalls"] = json.loads(saved["payload"]).get("modelCalls", 0)
        receipt.update(status="failed", error=redact(str(exc))[:4000])
        return 1
    finally:
        if "history" in locals():
            history.db.close()
        (artifact / f"{args.phase}-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        (artifact / "receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        print(json.dumps(receipt, separators=(",", ":")))


if __name__ == "__main__":
    sys.exit(main())
