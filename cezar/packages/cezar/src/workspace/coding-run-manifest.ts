import { createHash } from 'node:crypto';
import {
  codingAttemptManifestSchema,
  type CodingAttemptManifest,
  type CodingEvidenceReference,
  type CodingRunRecord,
} from '@open-mercato/cezar-contract';

type Observation<T> = { availability: 'available'; value: T } | { availability: 'unknown'; reason?: string } | { availability: 'unavailable'; reasonCode: string; message?: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function unknown<T>(reason: string): Observation<T> { return { availability: 'unknown', reason }; }

export function buildCodingAttemptManifest(input: {
  run: CodingRunRecord;
  attemptId: string;
  index: number;
  workerImageDigest?: Observation<string>;
  testPolicySha256?: Observation<string>;
  templateSha256?: string[];
  commitSha?: Observation<string>;
  pullRequest?: Observation<{ number: number; url?: string; headSha?: string }>;
  artifacts?: CodingEvidenceReference[];
}): CodingAttemptManifest {
  const run = input.run;
  const agentVersion: Observation<string> = run.agent.availability === 'available' && run.agent.value.adapterVersion
    ? { availability: 'available', value: run.agent.value.adapterVersion }
    : unknown('agent-cli-version-not-recorded');
  const model: Observation<string> = run.model.availability === 'available'
    ? { availability: 'available', value: `${run.model.value.provider}/${run.model.value.modelId}` }
    : run.model.availability === 'unknown'
      ? { availability: 'unknown', ...(run.model.reason ? { reason: run.model.reason } : {}) }
      : { availability: 'unavailable', reasonCode: run.model.reasonCode, ...(run.model.message ? { message: run.model.message } : {}) };
  const unsigned = {
    schemaVersion: 1 as const,
    runId: run.runId,
    attemptId: input.attemptId,
    index: input.index,
    issue: { number: run.source.number, revision: run.source.revision },
    baseSha: run.baseSha,
    workerImageDigest: input.workerImageDigest ?? unknown('worker-image-digest-not-recorded'),
    agentCliVersion: agentVersion,
    resolvedModel: model,
    promptSha256: run.promptSha256,
    skillSha256: run.skillSha256,
    templateSha256: input.templateSha256 ?? [],
    testPolicySha256: input.testPolicySha256 ?? unknown('test-policy-not-recorded'),
    artifacts: input.artifacts ?? [],
    commitSha: input.commitSha ?? unknown('commit-not-recorded'),
    pullRequest: input.pullRequest ?? run.pullRequest,
  };
  return codingAttemptManifestSchema.parse({ ...unsigned, manifestDigest: digest(unsigned) });
}

export function verifyCodingAttemptManifest(input: unknown):
  | { status: 'valid'; manifest: CodingAttemptManifest }
  | { status: 'invalid'; detail: string }
  | { status: 'tampered'; expectedDigest: string; actualDigest: string } {
  const parsed = codingAttemptManifestSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid', detail: parsed.error.issues.map((issue) => issue.message).join('; ').slice(0, 1_000) };
  const { manifestDigest, ...unsigned } = parsed.data;
  const expectedDigest = digest(unsigned);
  return expectedDigest === manifestDigest
    ? { status: 'valid', manifest: parsed.data }
    : { status: 'tampered', expectedDigest, actualDigest: manifestDigest };
}
