import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cezarRequire = createRequire(path.join(root, 'cezar', 'package.json'));
const { parseDocument } = cezarRequire('yaml');
const esbuild = cezarRequire('esbuild');
const zod = cezarRequire('zod');
function compileTs(source) {
  return esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
}
function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
// Load Cezar's exact exported schema functions without copying them or loading
// the runtime graph. The tiny constants module is type-transpiled in memory.
let runnerSource = compileTs(await readFile(path.join(root, 'cezar/packages/cezar/src/core/agent-runner.ts'), 'utf8'));
const runnerUrl = dataModule(runnerSource);
let typesSource = compileTs(await readFile(path.join(root, 'cezar/packages/cezar/src/workflows/types.ts'), 'utf8'))
  .replace(/import\s*\{\s*z\s*\}\s*from\s*["']zod["'];?/, 'const z = globalThis.__factoryContractZod.z;')
  .replace(/import\s*\{\s*RUNNER_IDS\s*\}\s*from\s*["']\.\.\/core\/agent-runner\.ts["'];?/, `import { RUNNER_IDS } from '${runnerUrl}';`);
globalThis.__factoryContractZod = zod;
const { workflowFileSchema, normalizeWorkflowDoc, stepsIssue } = await import(dataModule(typesSource));
delete globalThis.__factoryContractZod;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDocument(doc, file) {
  const parsed = workflowFileSchema.safeParse(doc);
  if (!parsed.success) return `${file}: ${parsed.error.issues.map((e) => e.message).join('; ')}`;
  const normalized = normalizeWorkflowDoc(parsed.data);
  const issue = stepsIssue(normalized.steps);
  return issue ? `${file}: ${issue}` : null;
}

async function validateSkills(steps, file) {
  for (const step of steps) {
    if (!step.skill) continue;
    const skillPath = path.join(root, 'skills', step.skill, 'SKILL.md');
    try { await readFile(skillPath, 'utf8'); }
    catch { return `${file}/${step.id}: missing skill file skills/${step.skill}/SKILL.md`; }
  }
  return null;
}

function runPowerShell(inputPath) {
  const executable = process.env.PWSH ?? 'pwsh';
  return spawnSync(executable, [
    '-NoProfile', '-File', path.join(root, 'tests/validate-workflow-commands.ps1'),
    '-InputPath', inputPath, '-FactoryRoot', root,
  ], { encoding: 'utf8' });
}

const workflowDir = path.join(root, 'workflows');
const names = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name)).sort();
const workflows = [];
for (const name of names) {
  const source = await readFile(path.join(workflowDir, name), 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  assert(document.errors.length === 0, `${name}: YAML parse failed: ${document.errors.map((e) => e.message).join('; ')}`);
  const doc = document.toJS();
  const issue = validateDocument(doc, name);
  assert(!issue, issue ?? `${name}: workflow contract invalid`);
  const normalized = normalizeWorkflowDoc(workflowFileSchema.parse(doc));
  const skillIssue = await validateSkills(normalized.steps, name);
  assert(!skillIssue, skillIssue ?? `${name}: workflow refers to a missing skill`);
  workflows.push({ file: name, ...normalized });
}
assert(workflows.length > 0, 'no Factory workflows found');

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'factory-workflow-contracts-'));
try {
  const inputPath = path.join(tempDir, 'workflows.json');
  await writeFile(inputPath, JSON.stringify(workflows), 'utf8');
  const valid = runPowerShell(inputPath);
  assert(valid.status === 0, `PowerShell command contract failed:\n${valid.stdout}\n${valid.stderr}`);
  process.stdout.write(valid.stdout);

  const retryFixture = structuredClone(workflows.find((w) => w.steps.some((s) => s.onFail)));
  const retryStep = retryFixture.steps.find((s) => s.onFail);
  retryStep.onFail.retry = 'missing-step';
  assert(validateDocument({ name: retryFixture.name, steps: retryFixture.steps }, retryFixture.file)?.includes('earlier step'),
    'negative fixture: invalid retry edge was accepted');

  const skillFixture = structuredClone(workflows.find((w) => w.steps.some((s) => s.skill)));
  const skillStep = skillFixture.steps.find((s) => s.skill);
  skillStep.skill = 'missing-factory-skill';
  assert(!validateDocument({ name: skillFixture.name, steps: skillFixture.steps }, skillFixture.file),
    'negative fixture setup: skill name should remain schema-valid');
  const missingSkill = await validateSkills(skillFixture.steps, skillFixture.file);
  assert(missingSkill?.includes('missing skill file'), 'negative fixture: missing skill was not rejected');

  const commandFixture = structuredClone(workflows);
  const command = commandFixture.flatMap((w) => w.steps.map((s) => ({ workflow: w, step: s })))
    .find(({ step }) => step.command && step.command.includes(' -Step '));
  assert(command, 'negative fixture setup: no -Step command found');
  command.step.command = command.step.command.replace(' -Step ', ' -DefinitelyNotAParameter ');
  await writeFile(inputPath, JSON.stringify(commandFixture), 'utf8');
  const invalidParameter = runPowerShell(inputPath);
  assert(invalidParameter.status !== 0 && /unknown parameter/i.test(`${invalidParameter.stdout}\n${invalidParameter.stderr}`),
    'negative fixture: unknown PowerShell parameter was not rejected');

  const preflightFixture = structuredClone(workflows);
  const startup = preflightFixture.flatMap((w) => w.steps.map((s) => ({ workflow: w, step: s })))
    .find(({ step }) => step.command?.includes('factory-startup.ps1'));
  assert(startup, 'negative fixture setup: no startup command found');
  startup.step.command = startup.step.command.replace(/\s+-RequiredScripts\s+[^\s]+/, '');
  await writeFile(inputPath, JSON.stringify(preflightFixture), 'utf8');
  const missingPreflight = runPowerShell(inputPath);
  assert(missingPreflight.status !== 0 && /preflight/i.test(`${missingPreflight.stdout}\n${missingPreflight.stderr}`),
    'negative fixture: incomplete preflight was not rejected');

  const missingScriptFixture = structuredClone(workflows);
  const scriptStep = missingScriptFixture.flatMap((w) => w.steps.map((s) => ({ workflow: w, step: s })))
    .find(({ step }) => step.command && /\/scripts\/[\w/-]+\.ps1/.test(step.command) && !step.command.includes('factory-startup.ps1'));
  assert(scriptStep, 'negative fixture setup: no Factory script command found');
  scriptStep.step.command = scriptStep.step.command.replace(/(\/scripts\/)[\w/-]+\.ps1/, '$1missing-script.ps1');
  await writeFile(inputPath, JSON.stringify(missingScriptFixture), 'utf8');
  const missingScript = runPowerShell(inputPath);
  assert(missingScript.status !== 0 && /missing script/i.test(`${missingScript.stdout}\n${missingScript.stderr}`),
    'negative fixture: missing script was not rejected');

  process.stdout.write('  ok   negative contract fixtures reject invalid retry, missing skill/script, unknown parameter and incomplete preflight\n');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

