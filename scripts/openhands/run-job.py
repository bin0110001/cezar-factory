#!/usr/bin/env python3
"""Submit one bounded Cezar job to an OpenHands Agent Server.

The adapter keeps provider state in OpenHands and emits only the compact
job-result contract consumed by Cezar. Secrets are accepted through CLI
arguments or environment variables and are never written to the result.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


REQUIRED_REQUEST = {
    "provider",
    "agent",
    "project",
    "issue",
    "task",
    "branch",
    "validation",
    "risk",
}
ALLOWED_AGENTS = {"codex", "claude", "local"}
ALLOWED_RISKS = {"risk:low", "risk:medium", "risk:high"}
TERMINAL_STATES = {"finished", "error", "stuck"}


class ProviderError(RuntimeError):
    """A provider request or response failed."""


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProviderError(f"could not read JSON request: {exc}") from exc
    if not isinstance(value, dict):
        raise ProviderError("request must be a JSON object")
    return value


def validate_request(request: dict[str, Any]) -> None:
    missing = sorted(REQUIRED_REQUEST - request.keys())
    extra = sorted(set(request) - REQUIRED_REQUEST)
    if missing:
        raise ProviderError(f"request missing required fields: {', '.join(missing)}")
    if extra:
        raise ProviderError(f"request has unsupported fields: {', '.join(extra)}")
    if request["provider"] != "openhands":
        raise ProviderError("provider must be openhands")
    if request["agent"] not in ALLOWED_AGENTS:
        raise ProviderError("agent must be codex, claude, or local")
    if not isinstance(request["issue"], int) or isinstance(request["issue"], bool) or request["issue"] < 1:
        raise ProviderError("issue must be a positive integer")
    if not isinstance(request["validation"], list) or not all(isinstance(item, str) for item in request["validation"]):
        raise ProviderError("validation must be an array of strings")
    if request["risk"] not in ALLOWED_RISKS:
        raise ProviderError("risk must be risk:low, risk:medium, or risk:high")
    for field in ("project", "task", "branch"):
        if not isinstance(request[field], str) or not request[field].strip():
            raise ProviderError(f"{field} must be a non-empty string")


class AgentServer:
    def __init__(self, base_url: str, api_key: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, method=method)
        request.add_header("X-Session-API-Key", self.api_key)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise ProviderError(f"OpenHands HTTP {exc.code}: {detail}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise ProviderError(f"OpenHands request failed: {exc}") from exc


def build_payload(
    request: dict[str, Any],
    workspace: str,
    model: str,
    llm_api_key: str | None,
    llm_base_url: str | None,
    provider_connection_id: str | None,
    agent_profile_id: str | None,
    max_iterations: int,
) -> dict[str, Any]:
    llm: dict[str, Any] = {"model": model, "max_output_tokens": 512, "temperature": 0}
    if llm_api_key:
        llm["api_key"] = llm_api_key
    if llm_base_url:
        llm["base_url"] = llm_base_url.rstrip("/")
    if provider_connection_id:
        llm["provider_connection_id"] = provider_connection_id
    validation = "\n".join(f"- Run validation command exactly: `{item}`" for item in request["validation"])
    message = (
        f"Work on issue #{request['issue']} for project {request['project']} on branch "
        f"{request['branch']}.\n\n{request['task']}\n\n"
        f"Risk classification: {request['risk']}.\n{validation}\n"
        "Keep the work bounded. Report the changed files, validation results, and final status."
    )
    payload: dict[str, Any] = {
        "workspace": {"working_dir": workspace, "kind": "LocalWorkspace"},
        "worktree": True,
        "max_iterations": max_iterations,
        "stuck_detection": True,
        "confirmation_policy": {"kind": "NeverConfirm"},
        "initial_message": {"content": [{"text": message}], "run": False},
        "tags": {"provider": "openhands", "issue": str(request["issue"]), "agent": request["agent"]},
    }
    if agent_profile_id:
        # Let OpenHands resolve subscription auth, MCP, skills, and model
        # settings server-side. No premium/API credential crosses this
        # adapter boundary.
        payload["agent_profile_id"] = agent_profile_id
    else:
        payload["agent"] = {
            "kind": "Agent",
            "llm": llm,
            "tools": [{"name": "terminal", "params": {}}],
            "include_default_tools": [],
        }
    return payload


def event_validation(server: AgentServer, conversation_id: str, commands: list[str]) -> bool:
    if not commands:
        return True
    events = server.call(
        "GET",
        f"/api/conversations/{urllib.parse.quote(conversation_id)}/events/search?limit=100",
    )
    observations = {}
    for event in events.get("items", []):
        if event.get("kind") != "ObservationEvent":
            continue
        observation = event.get("observation") or {}
        command = observation.get("command")
        if command and observation.get("exit_code") == 0:
            observations[command] = True
    # Agents commonly append a bounded reporting suffix such as
    # ``&& echo VALIDATION PASSED``. Accept that without treating an unrelated
    # command as proof of validation.
    return all(
        any(observed == command or observed.startswith(command + " ") or observed.startswith(command + " &&") for observed in observations)
        for command in commands
    )


def run_attempt(
    server: AgentServer,
    request: dict[str, Any],
    workspace: str,
    model: str,
    llm_api_key: str | None,
    llm_base_url: str | None,
    provider_connection_id: str | None,
    agent_profile_id: str | None,
    max_iterations: int,
    timeout_seconds: float,
    poll_seconds: float,
) -> tuple[str, bool, str, dict[str, Any]]:
    payload = build_payload(
        request,
        workspace,
        model,
        llm_api_key,
        llm_base_url,
        provider_connection_id,
        agent_profile_id,
        max_iterations,
    )
    conversation = server.call("POST", "/api/conversations", payload)
    conversation_id = conversation["id"]
    started = time.monotonic()
    deadline = started + timeout_seconds
    status = "running"
    current: dict[str, Any] = conversation
    while time.monotonic() < deadline:
        time.sleep(poll_seconds)
        current = server.call(
            "GET",
            f"/api/conversations?ids={urllib.parse.quote(conversation_id)}",
        )[0]
        status = current.get("execution_status", "error")
        if status in TERMINAL_STATES:
            break
    if status not in TERMINAL_STATES:
        status = "stuck"
    validation_passed = status == "finished" and event_validation(server, conversation_id, request["validation"])
    usage: dict[str, int] = {}
    token_usage = ((current.get("stats") or {}).get("usage_to_metrics") or {}).get("default", {}).get("accumulated_token_usage") or {}
    token_fields = {
        "promptTokens": "prompt_tokens",
        "completionTokens": "completion_tokens",
        "cacheReadTokens": "cache_read_tokens",
        "cacheWriteTokens": "cache_write_tokens",
        "reasoningTokens": "reasoning_tokens",
    }
    for result_name, source_name in token_fields.items():
        value = token_usage.get(source_name)
        if isinstance(value, int) and value >= 0:
            usage[result_name] = value
    if "promptTokens" in usage and "completionTokens" in usage:
        usage["totalTokens"] = usage["promptTokens"] + usage["completionTokens"]
    metrics: dict[str, Any] = {"duration": round(time.monotonic() - started, 3)}
    if usage:
        metrics["usage"] = usage
    return status, validation_passed, conversation_id, metrics


def run(args: argparse.Namespace) -> dict[str, Any]:
    request = read_json(Path(args.request))
    validate_request(request)
    server_url = args.server_url or os.environ.get("OPENHANDS_AGENT_SERVER_URL")
    session_key = args.session_api_key or os.environ.get("OPENHANDS_SESSION_API_KEY")
    workspace = args.workspace or request["project"]
    model = args.model or os.environ.get("OPENHANDS_LLM_MODEL", "openai/factory-code")
    llm_api_key = args.llm_api_key or os.environ.get("OPENHANDS_LLM_API_KEY")
    llm_base_url = args.llm_base_url or os.environ.get("OPENHANDS_LLM_BASE_URL")
    provider_connection_id = args.provider_connection_id or os.environ.get("OPENHANDS_PROVIDER_CONNECTION_ID")
    agent_profile_id = args.agent_profile_id or os.environ.get("OPENHANDS_AGENT_PROFILE_ID")
    if not server_url or not session_key:
        raise ProviderError("server URL and session API key are required")
    if not agent_profile_id and not llm_api_key and not provider_connection_id:
        raise ProviderError("an agent profile ID, LLM API key, or provider connection ID is required")

    server = AgentServer(server_url, session_key, args.http_timeout)
    attempts: list[dict[str, Any]] = []
    for _ in range(args.max_attempts):
        status, validation_passed, conversation_id, metrics = run_attempt(
            server,
            request,
            workspace,
            model,
            llm_api_key,
            llm_base_url,
            provider_connection_id,
            agent_profile_id,
            args.max_iterations,
            args.timeout_seconds,
            args.poll_seconds,
        )
        attempts.append(
            {
                "conversation": conversation_id,
                "execution_status": status,
                "validationPassed": validation_passed,
                **metrics,
            }
        )
        if status == "finished" and validation_passed:
            break
    final = attempts[-1]
    success = final["execution_status"] == "finished" and final["validationPassed"]
    validation_passed = bool(final["validationPassed"])
    result: dict[str, Any] = {
        "provider": "openhands",
        "agent": request["agent"],
        "status": "success" if success and validation_passed else "failure",
        "issue": request["issue"],
        "branch": request["branch"],
        "attempts": len(attempts),
        "validationPassed": validation_passed,
        "model": model,
    }
    for metric_name in ("duration", "usage"):
        if metric_name in final:
            result[metric_name] = final[metric_name]
    if not success or not validation_passed:
        result["failureArtifacts"] = [
            f"conversation:{item['conversation']} status:{item['execution_status']}"
            for item in attempts
        ]
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="OpenHands job-request JSON")
    parser.add_argument("--output", required=True, help="OpenHands job-result JSON output")
    parser.add_argument("--server-url")
    parser.add_argument("--session-api-key")
    parser.add_argument("--workspace")
    parser.add_argument("--model")
    parser.add_argument("--llm-api-key")
    parser.add_argument("--llm-base-url")
    parser.add_argument("--provider-connection-id")
    parser.add_argument(
        "--agent-profile-id",
        help="OpenHands profile UUID; resolves subscription auth and MCP server-side",
    )
    parser.add_argument("--max-iterations", type=int, default=20)
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--poll-seconds", type=float, default=2)
    parser.add_argument("--timeout-seconds", type=float, default=900)
    parser.add_argument("--http-timeout", type=float, default=30)
    args = parser.parse_args()
    if args.max_iterations < 1 or args.max_attempts < 1 or args.timeout_seconds <= 0 or args.poll_seconds <= 0:
        parser.error("iteration, attempt, timeout, and poll limits must be positive")
    return args


def main() -> int:
    args = parse_args()
    try:
        result = run(args)
    except ProviderError as exc:
        print(f"openhands-provider-error: {exc}", file=sys.stderr)
        return 2
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["status"] == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
