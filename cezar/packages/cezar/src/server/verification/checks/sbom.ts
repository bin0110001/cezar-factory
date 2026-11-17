import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * SBOM artifact schema and evidence binding (#652). A CycloneDX or SPDX document is validated against a deliberately small
 * schema (the fields policy and provenance need), then recorded as an artifact bound to the source SHA with its digest, generator
 * and format. `sbomEvidenceEntry` produces an entry the evidence manifest accepts (`schemas/evidence-manifest.schema.json`).
 */

const licenseChoice = z.union([
  z.object({ license: z.object({ id: z.string().min(1).max(128).optional(), name: z.string().min(1).max(256).optional() }).strict().refine((l) => Boolean(l.id || l.name), 'a license needs an id or a name') }).strict(),
  z.object({ expression: z.string().min(1).max(512) }).strict(),
]);

export const cycloneDxSchema = z.object({
  bomFormat: z.literal('CycloneDX'),
  specVersion: z.string().regex(/^1\.\d+$/),
  serialNumber: z.string().optional(),
  version: z.number().int().min(1).optional(),
  metadata: z.object({ timestamp: z.string().datetime().optional(), tools: z.unknown().optional(), component: z.unknown().optional() }).passthrough().optional(),
  components: z.array(z.object({
    type: z.string().min(1),
    name: z.string().min(1).max(512),
    version: z.string().max(256).optional(),
    purl: z.string().max(1024).optional(),
    licenses: z.array(licenseChoice).optional(),
  }).passthrough()).max(200_000),
}).passthrough();

export const spdxSchema = z.object({
  spdxVersion: z.string().regex(/^SPDX-2\.\d+$/),
  dataLicense: z.literal('CC0-1.0'),
  SPDXID: z.string().min(1),
  name: z.string().min(1),
  documentNamespace: z.string().min(1),
  creationInfo: z.object({ created: z.string().datetime(), creators: z.array(z.string()).min(1) }).passthrough(),
  packages: z.array(z.object({
    SPDXID: z.string().min(1),
    name: z.string().min(1).max(512),
    versionInfo: z.string().max(256).optional(),
    licenseConcluded: z.string().max(512).optional(),
    licenseDeclared: z.string().max(512).optional(),
  }).passthrough()).max(200_000),
}).passthrough();

export type SbomFormat = 'cyclonedx' | 'spdx';

export interface SbomComponent { name: string; version?: string | undefined; purl?: string | undefined; license?: string | undefined }

export interface ValidatedSbom { format: SbomFormat; specVersion: string; components: SbomComponent[] }

/** Validate a parsed SBOM document and extract the components policy cares about. Throws with the failing path on a bad document. */
export function validateSbom(doc: unknown): ValidatedSbom {
  const d = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  if (d.bomFormat === 'CycloneDX') {
    const r = cycloneDxSchema.safeParse(doc);
    if (!r.success) throw new Error(`invalid CycloneDX SBOM: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return {
      format: 'cyclonedx', specVersion: r.data.specVersion,
      components: r.data.components.map((c) => ({
        name: c.name, version: c.version, purl: c.purl,
        license: (c.licenses ?? []).map((l) => ('expression' in l ? l.expression : (l.license.id ?? l.license.name))).filter((x): x is string => Boolean(x)).join(' AND ') || undefined,
      })),
    };
  }
  if (typeof d.spdxVersion === 'string') {
    const r = spdxSchema.safeParse(doc);
    if (!r.success) throw new Error(`invalid SPDX SBOM: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const clean = (v: string | undefined) => (v && v !== 'NOASSERTION' && v !== 'NONE' ? v : undefined);
    return {
      format: 'spdx', specVersion: r.data.spdxVersion,
      components: r.data.packages.map((p) => ({ name: p.name, version: p.versionInfo, license: clean(p.licenseConcluded) ?? clean(p.licenseDeclared) })),
    };
  }
  throw new Error('unrecognized SBOM: expected CycloneDX (bomFormat) or SPDX (spdxVersion)');
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val));
export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface SbomProvenance {
  sourceSha: string;
  generator: { name: string; version: string };
  format: SbomFormat;
  specVersion: string;
  sha256: string;
  bytes: number;
  componentCount: number;
  generatedAt: string;
}

export interface SbomArtifact { provenance: SbomProvenance; document: unknown; components: SbomComponent[] }

/** Validate, digest and bind an SBOM to the source SHA it describes. The digest is over canonical JSON, so it is stable. */
export function recordSbom(doc: unknown, input: { sourceSha: string; generator: { name: string; version: string }; generatedAt: string }): SbomArtifact {
  if (!/^[a-f0-9]{40,64}$/i.test(input.sourceSha)) throw new Error('an SBOM is bound to a full source SHA, not a branch name');
  const v = validateSbom(doc);
  const text = canonical(doc);
  return {
    document: doc, components: v.components,
    provenance: { sourceSha: input.sourceSha, generator: input.generator, format: v.format, specVersion: v.specVersion, sha256: sha256Hex(text), bytes: Buffer.byteLength(text), componentCount: v.components.length, generatedAt: input.generatedAt },
  };
}

/** An artifact entry for the evidence manifest (kind `artifact`, plain hex digest, no extra properties). */
export function sbomEvidenceEntry(a: SbomArtifact, reference: string): Record<string, unknown> {
  return {
    schemaVersion: 1, evidenceId: `sbom-${a.provenance.sourceSha.slice(0, 12)}-${a.provenance.sha256.slice(0, 12)}`, kind: 'artifact', reference,
    sha256: a.provenance.sha256, mediaType: a.provenance.format === 'cyclonedx' ? 'application/vnd.cyclonedx+json' : 'application/spdx+json',
    bytes: a.provenance.bytes, createdAt: a.provenance.generatedAt,
  };
}
