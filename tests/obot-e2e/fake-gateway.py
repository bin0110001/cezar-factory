#!/usr/bin/env python3
"""Local stand-in for the Obot vMCP gateway, used only by tests/obot-e2e.ps1.

It models the gateway contract the Factory relies on, not Obot internals: bearer
auth (403 for a missing, unknown, expired or revoked token), a read-only tool
allow-list, denial of write tools and cross-project access, a restartable
process, and an append-only audit ledger that never stores a credential.

Usage: fake-gateway.py <state-dir>. Prints PORT=<n> once it is listening.
"""
import hashlib, json, os, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = sys.argv[1]
LEDGER = os.path.join(STATE, 'ledger.jsonl')
TOKENS = os.path.join(STATE, 'tokens.json')  # sha256(token) -> {project, expires, revoked}
READ_TOOLS = ['get_file_contents', 'list_issues', 'get_pull_request']
WRITE_TOOLS = ['create_pull_request', 'merge_pull_request', 'push_files']
SECRET = re.compile(r'(ghp_|ghs_|github_pat_|Bearer\s+)[A-Za-z0-9_\-]{6,}')


def redact(value):
    return SECRET.sub('[redacted]', value) if isinstance(value, str) else value


def load_tokens():
    try:
        with open(TOKENS) as f:
            return json.load(f)
    except OSError:
        return {}


def ledger(event):
    event = {k: redact(v) for k, v in event.items()}
    event['ts'] = time.time()
    with open(LEDGER, 'a') as f:
        f.write(json.dumps(event) + '\n')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            req = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self.reply(400, {'error': 'malformed JSON-RPC'})
        trace = self.headers.get('X-Cezar-Trace-Id', '')
        auth = self.headers.get('Authorization', '')
        token = auth[7:] if auth.startswith('Bearer ') else ''
        method = req.get('method', '')
        base = {'trace': trace, 'method': method}
        if not token:
            ledger({**base, 'decision': 'deny', 'reason': 'missing-identity'})
            return self.reply(403, {'error': 'missing identity'})
        entry = load_tokens().get(hashlib.sha256(token.encode()).hexdigest())
        if entry is None:
            ledger({**base, 'decision': 'deny', 'reason': 'unknown-or-stale-token', 'presented': auth})
            return self.reply(403, {'error': 'unknown token'})
        if entry.get('revoked'):
            ledger({**base, 'project': entry['project'], 'decision': 'deny', 'reason': 'revoked'})
            return self.reply(403, {'error': 'revoked'})
        if entry.get('expires', 0) <= time.time():
            ledger({**base, 'project': entry['project'], 'decision': 'deny', 'reason': 'expired'})
            return self.reply(403, {'error': 'expired'})
        base['project'] = entry['project']
        if method == 'initialize':
            ledger({**base, 'decision': 'allow'})
            return self.reply(200, {'jsonrpc': '2.0', 'id': req.get('id'), 'result': {'serverInfo': {'name': 'fake-obot'}}})
        if method == 'tools/list':
            ledger({**base, 'decision': 'allow'})
            return self.reply(200, {'jsonrpc': '2.0', 'id': req.get('id'), 'result': {'tools': [{'name': n} for n in READ_TOOLS]}})
        if method == 'tools/call':
            params = req.get('params', {})
            tool, args = params.get('name', ''), params.get('arguments', {})
            if tool not in READ_TOOLS:
                ledger({**base, 'tool': tool, 'decision': 'deny', 'reason': 'tool-not-allowed'})
                return self.reply(403, {'error': 'tool not allowed: ' + tool})
            repo = args.get('repo', '')
            if repo and repo not in entry.get('repos', []):
                ledger({**base, 'tool': tool, 'repo': repo, 'decision': 'deny', 'reason': 'cross-project'})
                return self.reply(403, {'error': 'repository outside project scope'})
            ledger({**base, 'tool': tool, 'repo': repo, 'decision': 'allow'})
            return self.reply(200, {'jsonrpc': '2.0', 'id': req.get('id'), 'result': {'content': 'ok'}})
        ledger({**base, 'decision': 'deny', 'reason': 'unsupported-method'})
        return self.reply(400, {'error': 'unsupported method'})


if __name__ == '__main__':
    os.makedirs(STATE, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('FAKE_GATEWAY_PORT', '0'))), Handler)
    print('PORT=%d' % server.server_address[1], flush=True)
    server.serve_forever()
