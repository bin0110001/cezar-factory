import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT || 8090);
const token = process.env.OCR_WORKER_TOKEN || '';
const root = await realpath(process.env.OCR_REPO_ROOT || '/workspace');
const rules = await realpath(process.env.OCR_RULE_PATH || '/opt/ocr/rules.json');
const gatewayUrl = process.env.OCR_GATEWAY_URL || '';
const gatewayToken = process.env.OCR_GATEWAY_TOKEN || '';
const model = process.env.OCR_MODEL_ALIAS || '';
const maxOutput = 2 * 1024 * 1024;
const sessions = new Map();
let activeReview = false;
if (token.length < 32 || !gatewayUrl || !gatewayToken || !model) throw new Error('OCR worker secrets and model configuration are required');
const gateway = new URL(gatewayUrl);
if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/v1/chat/completions' || !['litellm', 'host.containers.internal', 'localhost'].includes(gateway.hostname.toLowerCase()) && !gateway.hostname.toLowerCase().endsWith('.local')) {
  throw new Error('OCR gateway must be the configured local LiteLLM chat-completions endpoint');
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
function authenticated(value) {
  const supplied = Buffer.from(value || '');
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req, maxBytes = 64 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > maxBytes) throw new Error('request too large');
  }
  return JSON.parse(data);
}
function run(argv, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('ocr', argv.slice(1), {
      cwd: root,
      shell: false,
      env: { ...env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp/ocr-home', TMPDIR: '/tmp', TERM: 'dumb', OCR_LLM_URL: env.OCR_LLM_URL || gatewayUrl, OCR_LLM_TOKEN: gatewayToken, OCR_LLM_MODEL: model, OCR_LLM_PROTOCOL: 'openai' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let overflow = false;
    child.stdout.on('data', (part) => {
      if (Buffer.byteLength(stdout) + part.length > maxOutput) { overflow = true; child.kill('SIGKILL'); }
      else stdout += part.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: 127, stdout: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: overflow ? 124 : code ?? 124, stdout }); });
  });
}

function meterProxy() {
  let tokens = 0;
  let costUsd = 0;
  let complete = true;
  let requests = 0;
  const upstream = gateway;
  const proxy = createServer(async (req, res) => {
    if (req.method !== 'POST' || !/^\/v1\/(?:chat\/completions|completions)$/.test(req.url || '')) {
      res.writeHead(404).end(); return;
    }
    try {
      const raw = await body(req, 4 * 1024 * 1024);
      if (raw?.model !== model) throw new Error('gateway model does not match the approved alias');
      const response = await fetch(new URL(req.url, upstream), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayToken}` },
        body: JSON.stringify(raw),
        signal: AbortSignal.timeout(120_000),
      });
      const parts = [];
      let size = 0;
      for await (const part of response.body ?? []) {
        size += part.length;
        if (size > 16 * 1024 * 1024) throw new Error('gateway response too large');
        parts.push(part);
      }
      const text = Buffer.concat(parts).toString('utf8');
      const costHeader = response.headers.get('x-litellm-response-cost');
      const billed = costHeader === null || costHeader.trim() === '' ? Number.NaN : Number(costHeader);
      let usage;
      try { usage = JSON.parse(text)?.usage; } catch { /* invalid model JSON stays a CLI error */ }
      const used = Number(response.headers.get('x-litellm-total-tokens') ?? usage?.total_tokens ?? (Number(usage?.prompt_tokens) + Number(usage?.completion_tokens)));
      requests += 1;
      if (!response.ok || !Number.isSafeInteger(used) || used < 0 || !Number.isFinite(billed) || billed < 0) complete = false;
      else { tokens += used; costUsd += billed; }
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      res.end(text);
    } catch { complete = false; res.writeHead(502).end(); }
  });
  return new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address();
      if (!address || typeof address === 'string') return reject(new Error('could not bind metering proxy'));
      resolve({ url: `http://127.0.0.1:${address.port}/v1/chat/completions`, close: () => new Promise((done) => proxy.close(() => done())), receipt: () => requests && complete ? { tokens, costUsd, receiptId: randomUUID() } : undefined });
    });
  });
}

const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
  if (!authenticated(req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '')) return send(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url?.startsWith('/v1/usage/')) {
    let session;
    try { session = decodeURIComponent(req.url.slice('/v1/usage/'.length)); } catch { return send(res, 404, { error: 'usage receipt unavailable' }); }
    const receipt = sessions.get(session);
    return receipt ? send(res, 200, receipt) : send(res, 404, { error: 'usage receipt unavailable' });
  }
  if (req.method !== 'POST' || req.url !== '/v1/execute') return send(res, 404, { error: 'not found' });
  try {
    const input = await body(req);
    if (!Array.isArray(input.argv) || input.argv.length < 2 || input.argv[0] !== 'ocr') return send(res, 400, { error: 'unsupported command' });
    const argv = input.argv;
    const allowed = argv[1] === 'version' && argv.length === 2 || argv[1] === 'review' && argv.includes('--repo') && argv.includes('--from') && argv.includes('--to') && argv.includes('--rule');
    if (!allowed || argv.some((part) => typeof part !== 'string' || part.length > 4096 || part.includes('\0'))) return send(res, 400, { error: 'unsupported command' });
    if (argv[1] === 'review') {
      const valued = new Set(['--repo', '--from', '--to', '--format', '--audience', '--model', '--concurrency', '--timeout', '--max-tokens-budget', '--rule']);
      const switches = new Set(['--preview']);
      for (let i = 2; i < argv.length;) {
        const flag = argv[i];
        if (switches.has(flag)) { i += 1; continue; }
        if (!valued.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) return send(res, 400, { error: 'unsupported review option' });
        i += 2;
      }
      if (argv.filter((part) => valued.has(part)).some((flag, index, flags) => flags.indexOf(flag) !== index)) return send(res, 400, { error: 'duplicate review option' });
      if (argv[argv.indexOf('--model') + 1] !== model || argv[argv.indexOf('--format') + 1] !== 'json' || argv[argv.indexOf('--audience') + 1] !== 'agent') return send(res, 400, { error: 'unapproved review configuration' });
      if (activeReview) return send(res, 429, { error: 'worker is at review concurrency limit' });
    }
    const repoIndex = argv.indexOf('--repo');
    if (repoIndex >= 0) {
      const repo = await realpath(argv[repoIndex + 1]);
      if (repo !== root && !repo.startsWith(`${root}${path.sep}`)) return send(res, 400, { error: 'repo outside worker mount' });
      argv[repoIndex + 1] = repo;
    }
    const ruleIndex = argv.indexOf('--rule');
    if (ruleIndex >= 0 && argv[ruleIndex + 1] !== rules) return send(res, 400, { error: 'unapproved rules file' });
    if (argv[1] === 'review') {
      for (const flag of ['--from', '--to']) {
        const value = argv[argv.indexOf(flag) + 1];
        if (!/^[a-f0-9]{40}$/i.test(value || '')) return send(res, 400, { error: 'immutable full revisions required' });
      }
    }
    const env = input.env && typeof input.env === 'object' ? input.env : {};
    if (Object.keys(env).some((key) => !['OCR_LLM_URL', 'OCR_LLM_MODEL', 'OCR_LLM_PROTOCOL', 'HOME', 'TERM'].includes(key))) return send(res, 400, { error: 'environment key rejected' });
    const timeout = Math.min(120, Math.max(1, Number(argv[argv.indexOf('--timeout') + 1]) || 10)) * 60_000;
    const isFinalReview = argv[1] === 'review' && !argv.includes('--preview');
    if (isFinalReview) {
      if (activeReview) return send(res, 429, { error: 'worker is at review concurrency limit' });
      activeReview = true;
    }
    let meter;
    let result;
    try {
      if (isFinalReview) meter = await meterProxy();
      if (meter) env.OCR_LLM_URL = meter.url;
      result = await run(argv, env, timeout);
    } finally { if (meter) await meter.close(); if (isFinalReview) activeReview = false; }
    if (isFinalReview) {
      try {
        const parsed = JSON.parse(result.stdout);
        const session = parsed.session_id || parsed.manifest?.run_id;
        const receipt = meter?.receipt();
        if (typeof session === 'string' && receipt) {
          if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
          sessions.set(session, receipt);
        }
      } catch { /* The adapter reports malformed output as unknown. */ }
    }
    send(res, 200, result);
  } catch (error) { send(res, 400, { error: error instanceof Error ? error.message : 'invalid request' }); }
});
server.listen(port, '0.0.0.0');
