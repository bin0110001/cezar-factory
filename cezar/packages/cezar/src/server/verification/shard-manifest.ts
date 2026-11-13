import { z } from 'zod';
import { jobRequirementsSchema } from './worker-capabilities.ts';

/**
 * Shardable verification manifest (#216). Project adapters report discovery; the core
 * knows nothing about frameworks. Anything an adapter does not state is treated
 * conservatively: not parallel-safe, not idempotent, mandatory.
 */
export const SHARD_MANIFEST_VERSION = 1;

export const shardTestSchema = z.object({
  /** Stable identity across runs and environments. */
  id: z.string().min(1),
  /** Tests sharing a group run in one partition, serially. Shared mutable state goes here. */
  isolationGroup: z.string().min(1).optional(),
  parallelSafe: z.boolean().default(false),
  /** Adapter says this test may be split away from its siblings. */
  shardable: z.boolean().default(false),
  /** Tests sharing a setup id need the same setup/teardown, so they stay together. */
  setup: z.string().min(1).optional(),
  teardown: z.string().min(1).optional(),
  mandatory: z.boolean().default(true),
  /** Re-running it has no external side effects. */
  idempotent: z.boolean().default(false),
  durationMsOverride: z.number().positive().optional(),
  /** Renderer/display/capability needs; graphical cases are ordinary tests with these set. */
  requires: jobRequirementsSchema.default({}),
  /** Tests that must never be dropped or retried away. */
  protected: z.boolean().default(false),
});
export type ShardTest = z.infer<typeof shardTestSchema>;

export const shardManifestSchema = z.object({
  version: z.literal(SHARD_MANIFEST_VERSION).default(SHARD_MANIFEST_VERSION),
  revision: z.string().min(1),
  /** `unsupported`: the adapter cannot enumerate; the project-owned full command runs instead. */
  discovery: z.enum(['supported', 'unsupported']).default('unsupported'),
  tests: z.array(shardTestSchema).default([]),
  /** Project-owned full-suite command, used for the fallback. */
  fullSuiteCommand: z.string().min(1).optional(),
});
export type ShardManifest = z.infer<typeof shardManifestSchema>;

export function parseShardManifest(input: unknown): ShardManifest {
  const m = shardManifestSchema.parse(input);
  const seen = new Set<string>();
  for (const t of m.tests) {
    if (seen.has(t.id)) throw new Error(`duplicate test id in shard manifest: ${t.id}`);
    seen.add(t.id);
  }
  return m;
}
