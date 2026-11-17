import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  PipelinePolicyDocumentResponse, PipelinePolicyPreviewRequest, PipelinePolicyPreviewResponse, PipelinePolicySaveRequest, PipelinePolicySaveResponse,
} from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { collectSecretValues, redactDeep, redactSecrets } from '../core/secret-redaction.ts';
import { SCHEMA_VERSION, configHash, effectiveConfig, nextRuns, validateDocument } from './pipeline-policy.ts';

/**
 * Stores the operator's release pipeline policy (#632) at `~/.cezar/release/pipeline-policy.json`, the document the release engine reads,
 * and an append-only audit log beside it. Saves are validated, compare-and-swap on the current effective hash, and written atomically.
 * Policy lives under the home directory, outside any repository, so a coding agent's change to a repository cannot reach it.
 */

type J = Record<string, unknown>;
export const POLICY_FILE = 'pipeline-policy.json';
export const POLICY_AUDIT_FILE = 'pipeline-policy-audit.jsonl';
const releaseDir = (env: NodeJS.ProcessEnv = process.env) => join(cezarHomeDir(env), 'release');
export const policyPath = (env?: NodeJS.ProcessEnv) => join(releaseDir(env), POLICY_FILE);
export const policyAuditPath = (env?: NodeJS.ProcessEnv) => join(releaseDir(env), POLICY_AUDIT_FILE);

const emptyDoc = (): J => ({ schemaVersion: SCHEMA_VERSION, defaults: {}, projects: {} });

export function loadPolicyDocument(path = policyPath()): J {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as J : emptyDoc(); } catch { return emptyDoc(); }
}

/** The effective hash for a project in `doc`, or null if the document is invalid for it. */
function hashFor(doc: J, projectId: string): string | null {
  try { return configHash(effectiveConfig(doc, projectId)); } catch { return null; }
}

const withProject = (doc: J, projectId: string, policy: J): J => ({ ...doc, schemaVersion: SCHEMA_VERSION, projects: { ...((doc.projects as J | undefined) ?? {}), [projectId]: policy } });

export function previewPolicy(req: PipelinePolicyPreviewRequest, now: Date, path = policyPath()): PipelinePolicyPreviewResponse {
  const current = loadPolicyDocument(path);
  const candidate = withProject(current, req.projectId, req.policy as J);
  const errors = validateDocument(candidate);
  const secrets = collectSecretValues();
  if (errors.length > 0) return { valid: false, errors: errors.map((e) => redactSecrets(e, secrets)).slice(0, 100), effective: null, effectiveHash: null, currentHash: hashFor(current, req.projectId), nextRuns: [] };
  const spec = effectiveConfig(candidate, req.projectId);
  return { valid: true, errors: [], effective: redactDeep(spec, secrets), effectiveHash: configHash(spec) as never, currentHash: hashFor(current, req.projectId) as never, nextRuns: nextRuns(spec, now) };
}

export type SaveResult = { ok: true; response: PipelinePolicySaveResponse } | { ok: false; status: 400 | 409 | 500; error: string; errors?: string[] };

export function savePolicy(req: PipelinePolicySaveRequest, now: Date, path = policyPath(), auditPath = policyAuditPath()): SaveResult {
  const current = loadPolicyDocument(path);
  const candidate = withProject(current, req.projectId, req.policy as J);
  const errors = validateDocument(candidate);
  if (errors.length > 0) return { ok: false, status: 400, error: 'The policy is not valid; nothing was saved.', errors: errors.slice(0, 100) };
  const beforeHash = hashFor(current, req.projectId);
  if (req.expectedCurrentHash !== undefined && req.expectedCurrentHash !== beforeHash) {
    return { ok: false, status: 409, error: 'The saved policy changed since you loaded it. Reload and review the change before saving.' };
  }
  const afterHash = configHash(effectiveConfig(candidate, req.projectId));
  const auditId = `pol-${randomUUID().slice(0, 12)}`;
  const entry = { id: auditId, at: now.toISOString(), actor: 'local-operator', projectId: req.projectId, beforeHash, afterHash, reason: redactSecrets(req.reason, collectSecretValues()) };
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Audit first: an unrecorded change must not exist. A crash between the two leaves an audit entry for a change that did not land, never the reverse.
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    return { ok: false, status: 500, error: 'The policy could not be written, so it was not saved.' };
  }
  return { ok: true, response: { saved: true, projectId: req.projectId, beforeHash: beforeHash as never, afterHash: afterHash as never, auditId, appliesTo: 'future-candidates' } };
}

export function readPolicyDocument(path = policyPath(), auditPath = policyAuditPath()): PipelinePolicyDocumentResponse {
  const doc = loadPolicyDocument(path);
  const secrets = collectSecretValues();
  const projects = Object.fromEntries(Object.entries((doc.projects as J | undefined) ?? {}).map(([id, policy]) => [id, { policy: redactDeep(policy as J, secrets), effectiveHash: hashFor(doc, id) }]));
  let audit: PipelinePolicyDocumentResponse['audit'] = [];
  try {
    audit = existsSync(auditPath)
      ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as PipelinePolicyDocumentResponse['audit'][number]).slice(-50).reverse()
      : [];
  } catch { audit = []; }
  return { schemaVersion: 1, available: existsSync(path), projects: projects as never, audit };
}
