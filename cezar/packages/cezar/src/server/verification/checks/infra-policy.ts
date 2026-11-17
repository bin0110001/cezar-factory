import { z } from 'zod';
import type { CheckProviderPlugin, PluginRunOutput } from './check-runner.js';

/**
 * Container base-image and Terraform/IaC policy checks (#653). Static, deterministic analysis of Dockerfiles and `.tf` files
 * that needs no external scanner: an unpinned base image, a privileged runtime user, remote `ADD`, public network exposure and
 * unencrypted storage become findings in the `container` and `iac` categories. A project with no Dockerfile or Terraform is
 * NOT_APPLICABLE through capability planning (`capabilities.ts`), so nothing here runs for it.
 */

export const infraPolicySchema = z.object({
  /** Registries base images may come from. Empty means any registry is acceptable. */
  trustedRegistries: z.array(z.string().min(1)).max(100).default([]),
  /** A base image must be pinned by digest to be clean; a tag alone is a finding unless this is false. */
  requireDigest: z.boolean().default(true),
  /** Ports that must not be open to the world. */
  sensitivePorts: z.array(z.number().int().min(1).max(65535)).max(100).default([22, 3389, 5432, 3306, 6379, 9200]),
}).strict();
export type InfraPolicy = z.infer<typeof infraPolicySchema>;

export interface InfraFinding { id: string; severity: 'high' | 'medium' | 'low'; title: string; path: string; line: number }

const registryOf = (image: string): string => {
  const first = image.split('/')[0] ?? '';
  return image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io';
};

/** Analyse one Dockerfile. Multi-stage `FROM stage` references to an earlier stage are not external images. */
export function analyzeDockerfile(path: string, text: string, policy: InfraPolicy): InfraFinding[] {
  const out: InfraFinding[] = [];
  const stages = new Set<string>();
  let lastUser: { value: string; line: number } | undefined;
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const l = raw.trim();
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
    if (from) {
      const image = from[1]!;
      if (from[2]) stages.add(from[2].toLowerCase());
      if (image.toLowerCase() === 'scratch' || stages.has(image.toLowerCase()) && !from[2]) return;
      const digest = image.includes('@sha256:');
      const tag = !digest && /:[^/@]+$/.test(image) ? image.split(':').pop()! : undefined;
      if (!digest && (tag === undefined || tag === 'latest')) out.push({ id: 'container.unpinned-base-image', severity: 'high', title: `base image ${image} has no pinned tag or digest`, path, line });
      else if (!digest && policy.requireDigest) out.push({ id: 'container.base-image-not-digest-pinned', severity: 'medium', title: `base image ${image} is pinned by tag only; pin a digest`, path, line });
      if (policy.trustedRegistries.length && !policy.trustedRegistries.includes(registryOf(image))) {
        out.push({ id: 'container.untrusted-registry', severity: 'high', title: `base image ${image} comes from ${registryOf(image)}, which is not a trusted registry`, path, line });
      }
    }
    if (/^ADD\s+https?:\/\//i.test(l)) out.push({ id: 'container.remote-add', severity: 'medium', title: 'ADD from a remote URL is not integrity-checked; use COPY with a verified download', path, line });
    const user = /^USER\s+(\S+)/i.exec(l);
    if (user) lastUser = { value: user[1]!.split(':')[0]!, line };
  });
  if (!lastUser || lastUser.value === 'root' || lastUser.value === '0') {
    out.push({ id: 'container.runs-as-root', severity: 'low', title: 'the image runs as root; add a non-root USER', path, line: lastUser?.line ?? 1 });
  }
  return out;
}

/** Analyse one Terraform file with line-level rules. Not a full HCL parser: it flags the unambiguous, high-value patterns. */
export function analyzeTerraform(path: string, text: string, policy: InfraPolicy): InfraFinding[] {
  const out: InfraFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    if (/^\s*#|^\s*\/\//.test(raw)) return;
    if (/acl\s*=\s*"public-read(-write)?"/.test(raw)) out.push({ id: 'iac.public-bucket-acl', severity: 'high', title: 'storage bucket ACL is public', path, line });
    if (/publicly_accessible\s*=\s*true/.test(raw)) out.push({ id: 'iac.public-database', severity: 'high', title: 'database is publicly accessible', path, line });
    if (/\b(encrypted|storage_encrypted|enable_encryption)\s*=\s*false/.test(raw)) out.push({ id: 'iac.unencrypted-storage', severity: 'medium', title: 'storage encryption is disabled', path, line });
    if (/cidr_blocks\s*=\s*\[[^\]]*"0\.0\.0\.0\/0"/.test(raw) || /ipv6_cidr_blocks\s*=\s*\[[^\]]*"::\/0"/.test(raw)) {
      // Look in the surrounding block for the port to decide how serious an open range is.
      const block = lines.slice(Math.max(0, idx - 8), idx + 8).join('\n');
      const ports = [...block.matchAll(/(?:from_port|to_port)\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
      const exposed = ports.filter((p) => policy.sensitivePorts.includes(p));
      const all = ports.some((p) => p === 0) && /protocol\s*=\s*"-1"/.test(block);
      if (exposed.length || all) out.push({ id: 'iac.open-to-world', severity: 'high', title: `network rule open to the world${exposed.length ? ` on port ${exposed[0]}` : ' on all ports'}`, path, line });
      else out.push({ id: 'iac.broad-cidr', severity: 'low', title: 'network rule allows 0.0.0.0/0', path, line });
    }
  });
  return out;
}

export interface InfraFile { path: string; text: string }

export interface InfraPluginOptions {
  domain: 'container' | 'iac';
  policy: InfraPolicy;
  readFiles: () => Promise<readonly InfraFile[]>;
}

/** Plugin for one domain. Finds files by name, never by a fixed location; nothing to analyse is `notApplicable` (planning normally catches it first). */
export function infraPlugin(opts: InfraPluginOptions): CheckProviderPlugin {
  return {
    async run(): Promise<PluginRunOutput> {
      const files = (await opts.readFiles()).filter((f) => (opts.domain === 'container' ? /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/i : /\.tf$/i).test(f.path.replace(/\\/g, '/')));
      if (files.length === 0) return { format: 'json', document: { findings: [] }, notApplicable: opts.domain === 'container' ? 'no Dockerfile in the repository' : 'no Terraform files in the repository' };
      const findings = files.flatMap((f) => (opts.domain === 'container' ? analyzeDockerfile(f.path, f.text, opts.policy) : analyzeTerraform(f.path, f.text, opts.policy)))
        .map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: f.path, line: f.line }));
      return { format: 'json', document: { findings } };
    },
  };
}
