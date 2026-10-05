#!/usr/bin/env python3
"""Small authenticated/allowlisted HTTP reverse proxy for a trusted vLLM LAN hop."""

from __future__ import annotations

import argparse
import ipaddress
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
MAX_BODY = 64 * 1024 * 1024


def networks(values: Iterable[str]) -> tuple[ipaddress._BaseNetwork, ...]:
    parsed = []
    for value in values:
        parsed.append(ipaddress.ip_network(value.strip(), strict=False))
    if not parsed:
        raise ValueError("at least one allowed client network is required")
    return tuple(parsed)


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "CezarVllmTrustedProxy/1"

    def do_GET(self) -> None:
        self.forward()

    def do_HEAD(self) -> None:
        self.forward()

    def do_POST(self) -> None:
        self.forward()

    def do_PUT(self) -> None:
        self.forward()

    def do_PATCH(self) -> None:
        self.forward()

    def do_DELETE(self) -> None:
        self.forward()

    def client_allowed(self) -> bool:
        try:
            address = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        return any(address in network for network in self.server.allowed_networks)

    def authorized(self) -> bool:
        expected = self.server.api_key
        if not expected:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {expected}"

    def reject(self, status: int, message: str) -> None:
        body = (message + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def forward(self) -> None:
        if not self.client_allowed():
            self.reject(403, "client address is not allowed")
            return
        if not self.authorized():
            self.reject(401, "bearer token required")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_BODY:
            self.reject(413, "request body is too large")
            return
        body = self.rfile.read(length) if length else None
        headers = {
            name: value
            for name, value in self.headers.items()
            if name.lower() not in HOP_BY_HOP | {"host", "authorization", "content-length"}
        }
        request = urllib.request.Request(
            self.server.upstream + self.path,
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.server.timeout) as response:
                self.send_response(response.status)
                for name, value in response.headers.items():
                    if name.lower() not in HOP_BY_HOP:
                        self.send_header(name, value)
                self.end_headers()
                if self.command != "HEAD":
                    while chunk := response.read(64 * 1024):
                        self.wfile.write(chunk)
        except urllib.error.HTTPError as error:
            self.send_response(error.code)
            for name, value in error.headers.items():
                if name.lower() not in HOP_BY_HOP:
                    self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                while chunk := error.read(64 * 1024):
                    self.wfile.write(chunk)
        except (OSError, urllib.error.URLError):
            self.reject(502, "upstream vLLM endpoint unavailable")

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.client_address[0]} {self.command} {self.path} - {format % args}", flush=True)


class ProxyServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, handler, upstream, allowed_networks, api_key, timeout):
        super().__init__(address, handler)
        self.upstream = upstream.rstrip("/")
        self.allowed_networks = allowed_networks
        self.api_key = api_key
        self.timeout = timeout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-host", default="0.0.0.0")
    parser.add_argument("--listen-port", type=int, default=8000)
    parser.add_argument("--upstream", default="http://127.0.0.1:8002")
    parser.add_argument("--allowed-client", action="append", required=True)
    parser.add_argument("--api-key", default=os.environ.get("VLLM_PROXY_API_KEY", ""))
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    server = ProxyServer(
        (args.listen_host, args.listen_port),
        ProxyHandler,
        args.upstream,
        networks(args.allowed_client),
        args.api_key,
        args.timeout,
    )
    print(f"trusted vLLM proxy listening on {args.listen_host}:{args.listen_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
