// Claude Code `headersHelper` for the Obot gateway: prints {"Authorization": "Bearer ..."}.
// Claude strips credential-looking env vars (TOKEN, KEY, ...) from helpers, so the token is read
// from the gitignored .env instead: CEZ_MCP_GATEWAY_ENV_FILE, then this directory's .env, then the
// main checkout's copy (so git worktrees work without duplicating the secret).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function candidates() {
  const list = [process.env.CEZ_MCP_GATEWAY_ENV_FILE, resolve(here, '.env')];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    list.push(resolve(common, '..', 'integrations', 'mcp-gateway', '.env'));
  } catch {
    // not in a git checkout
  }
  return list.filter(Boolean);
}

let token = '';
for (const file of candidates()) {
  try {
    token = (parse(readFileSync(file, 'utf8')).OBOT_MCP_TOKEN || '').trim();
  } catch {
    continue;
  }
  if (token) break;
}

if (!token) {
  console.error('OBOT_MCP_TOKEN is not set in integrations/mcp-gateway/.env (see integrations/mcp-gateway/README.md).');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
