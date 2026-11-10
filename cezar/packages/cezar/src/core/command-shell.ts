import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface BashPathOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  gitExecPath?: string;
  exists?: (path: string) => boolean;
}

/** Resolve Git for Windows' Bash before Windows' WSL `bash.exe` shim. */
export function resolveBashExecutable(options: BashPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'bash';
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const candidates: string[] = [];
  if (env.CEZAR_BASH_PATH?.trim()) candidates.push(env.CEZAR_BASH_PATH.trim());
  if (options.gitExecPath?.trim()) candidates.push(win32.resolve(options.gitExecPath, '..', '..', '..', 'bin', 'bash.exe'));
  if (env.ProgramFiles) candidates.push(win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(win32.join(env['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe'));
  return candidates.find(exists) ?? 'bash';
}
