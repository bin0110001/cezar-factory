import { classifyGodotOutput } from '../../../../verification/godot-adapter.ts';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Godot/GDScript parser and warning adapter (#648) behind the check-provider contract. It reuses the existing Godot output
 * classifier: a script parse error is a project defect (blocking finding), warnings are quality debt, and editor or start-up
 * noise is an environment failure (an error status, never a project verdict). Whether a Godot binary exists is capability
 * planning's decision (#645, looked up by name), so an absent Godot never reaches here and is reported NOT_APPLICABLE.
 */

export function buildGodotArgv(projectPath: string): string[] {
  return ['godot', '--headless', '--path', projectPath, '--quit'];
}

export interface GodotExecResult { exitCode: number; output: string }

export interface GodotPluginOptions {
  projectPath: string;
  exec: (argv: string[], signal: AbortSignal) => Promise<GodotExecResult>;
}

export function godotCheckPlugin(opts: GodotPluginOptions): CheckProviderPlugin {
  return {
    async run({ signal }): Promise<PluginRunOutput> {
      const res = await opts.exec(buildGodotArgv(opts.projectPath), signal);
      const { parse, editor, warnings } = classifyGodotOutput(res.output);
      if (editor.length > 0 && parse.length === 0) {
        throw new Error(`godot could not run the project: ${editor[0]!.message}`.slice(0, 300));
      }
      if (res.exitCode !== 0 && parse.length === 0 && warnings.length === 0) {
        throw new Error(`godot exited with code ${res.exitCode} without a diagnosable result`);
      }
      const findings = [
        ...parse.map((d) => ({ id: 'gdscript-parse-error', severity: 'high', title: d.message, path: d.file, line: d.line })),
        ...warnings.map((d) => ({ id: 'gdscript-warning', severity: 'low', title: d.message })),
      ];
      return { format: 'json', document: { findings } };
    },
  };
}
