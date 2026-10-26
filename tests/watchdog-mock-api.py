#!/usr/bin/env python3
"""Local-only API fixture for watchdog cancellation/re-read tests."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--state", required=True)
parser.add_argument("--ready", required=True)
args = parser.parse_args()
state_path = Path(args.state)


def load_state():
    return json.loads(state_path.read_text(encoding="utf-8"))


def save_state(state):
    state_path.write_text(json.dumps(state), encoding="utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body):
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        state = load_state()
        suffix = "/api/v1/p/fixture/runs"
        if self.path.endswith(suffix):
            self.respond(200, state["runs"])
            return
        marker = suffix + "/"
        if marker in self.path:
            run_id = self.path.split(marker, 1)[1]
            run = next((item for item in state["runs"] if item.get("id") == run_id), None)
            if run is None:
                self.respond(404, {"error": "not found"})
            else:
                self.respond(200, run)
            return
        self.respond(404, {"error": "not found"})

    def do_POST(self):
        state = load_state()
        marker = "/api/v1/p/fixture/runs/"
        if marker not in self.path or not self.path.endswith("/cancel"):
            self.respond(404, {"error": "not found"})
            return
        run_id = self.path.split(marker, 1)[1].removesuffix("/cancel")
        run = next((item for item in state["runs"] if item.get("id") == run_id), None)
        if run is None or run.get("status") != "running":
            self.respond(200, {"cancelled": False})
            return
        run["status"] = "cancelled"
        state["cancelCount"] += 1
        save_state(state)
        self.respond(200, {"cancelled": True})

    def do_DELETE(self):
        self.respond(200, {"stopping": True})
        self.server.shutdown()


server = HTTPServer(("127.0.0.1", 0), Handler)
Path(args.ready).write_text(str(server.server_port), encoding="ascii")
server.serve_forever()
