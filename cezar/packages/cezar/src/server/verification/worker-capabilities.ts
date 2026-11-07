import { z } from 'zod';

/**
 * Framework-agnostic verification worker capability descriptor and
 * requirement matching (#112). Versioned so later profile work can extend it.
 * Anything not detected is simply not advertised.
 */

export const CAPABILITY_DESCRIPTOR_VERSION = 1;

export const workerCapabilitiesSchema = z.object({
  version: z.literal(CAPABILITY_DESCRIPTOR_VERSION).default(CAPABILITY_DESCRIPTOR_VERSION),
  os: z.string().min(1).optional(),
  godot: z.object({ headless: z.boolean().default(false), gui: z.boolean().default(false) }).optional(),
  dotnet: z.boolean().default(false),
  gpu: z.boolean().default(false),
  /** Display identifiers (e.g. ":0") usable for GUI jobs. */
  displays: z.array(z.string().min(1)).default([]),
});
export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;

export const jobRequirementsSchema = z.object({
  os: z.string().min(1).optional(),
  godotHeadless: z.boolean().optional(),
  godotGui: z.boolean().optional(),
  dotnet: z.boolean().optional(),
  gpu: z.boolean().optional(),
  /** Display the job needs exclusively; implies the worker advertises it. */
  display: z.string().min(1).optional(),
});
export type JobRequirements = z.infer<typeof jobRequirementsSchema>;

export type MatchResult = { schedulable: true } | { schedulable: false; missing: string[] };

export function parseWorkerCapabilities(input: unknown): WorkerCapabilities {
  return workerCapabilitiesSchema.parse(input ?? {});
}

export function matchRequirements(caps: WorkerCapabilities, req: JobRequirements): MatchResult {
  const missing: string[] = [];
  if (req.os && caps.os !== req.os) missing.push(`os:${req.os}`);
  if (req.godotHeadless && !caps.godot?.headless) missing.push('godot:headless');
  if (req.godotGui && !caps.godot?.gui) missing.push('godot:gui');
  if (req.dotnet && !caps.dotnet) missing.push('dotnet');
  if (req.gpu && !caps.gpu) missing.push('gpu');
  if (req.display && !caps.displays.includes(req.display)) missing.push(`display:${req.display}`);
  return missing.length ? { schedulable: false, missing } : { schedulable: true };
}

/** Detect capabilities from the environment; undetected means not advertised. */
export function detectWorkerCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): WorkerCapabilities {
  const display = env.DISPLAY?.trim();
  const displays = display ? [display] : [];
  const godotBin = Boolean(env.GODOT_BIN?.trim());
  return parseWorkerCapabilities({
    os: platform,
    godot: godotBin ? { headless: true, gui: displays.length > 0 } : undefined,
    dotnet: Boolean(env.DOTNET_ROOT?.trim()),
    gpu: env.CEZAR_WORKER_GPU === '1',
    displays,
  });
}
