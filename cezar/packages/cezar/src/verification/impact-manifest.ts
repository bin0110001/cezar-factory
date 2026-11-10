import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { verificationManifestSchema } from '@open-mercato/cezar-contract';

const path = process.argv[2];
if (!path) throw new Error('manifest path is required');
const document = parse(await readFile(path, 'utf8')) as { verification?: unknown } | null;
if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('verification config must be a YAML mapping');
if (!('verification' in document)) {
  process.stdout.write(JSON.stringify({ configured: false, checks: [] }));
} else {
  const result = verificationManifestSchema.safeParse(document.verification);
  if (!result.success) throw new Error(`invalid verification manifest: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const checks = Object.entries(result.data.checks).sort(([a], [b]) => a.localeCompare(b)).map(([id, check]) => ({
    id,
    owns: check.owns ?? [],
    tags: check.tags ?? [],
  }));
  process.stdout.write(JSON.stringify({ configured: true, checks }));
}
