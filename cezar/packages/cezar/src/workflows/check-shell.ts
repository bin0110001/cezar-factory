import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** Resolve the interpreter used by workflow check steps. */
export function resolveWorkflowCheckShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const configured = env.CEZ_CHECK_SHELL?.trim();
  if (configured) return configured;
  if (platform !== 'win32') return 'bash';

  // On Windows, `bash.exe` can resolve to the WSL Store alias even when no
  // distribution is installed. Prefer Git for Windows when present so check
  // commands retain the Bash semantics used by the Linux runtime.
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((root): root is string => Boolean(root?.trim()));
  for (const root of roots) {
    const candidate = win32.join(root, 'Git', 'bin', 'bash.exe');
    if (pathExists(candidate)) return candidate;
  }
  return 'bash';
}
