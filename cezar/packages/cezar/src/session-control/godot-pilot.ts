import { z } from 'zod';
import type { DesktopProjectAction } from './desktop-adapter.ts';

/**
 * Godot pilot: a project-owned action registered through the generic desktop-adapter extension point.
 * The adapter core has no Godot knowledge; this module only wraps the project's existing Godot test harness
 * (an injected runner), exposing one native semantic action, `create_room`.
 */
export interface GodotHarnessRunner {
  /** Runs one named harness action inside the session's display and returns its sanitized scalar output. */
  run(action: string, args: Record<string, string | number | boolean>): Promise<Record<string, string | number | boolean>>;
}

const createRoomArgs = z.object({
  name: z.string().regex(/^[A-Za-z0-9 _-]{1,64}$/),
  capacity: z.number().int().min(1).max(64).default(4),
}).strict();

export function godotCreateRoomAction(harness: GodotHarnessRunner): DesktopProjectAction {
  return {
    name: 'create_room',
    argsSchema: createRoomArgs as unknown as z.ZodType<Record<string, unknown>>,
    run: (args) => harness.run('create_room', { name: String(args.name), capacity: Number(args.capacity) }),
  };
}
