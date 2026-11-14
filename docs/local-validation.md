# Local pre-commit validation

Run the Factory test suite and YAML lint locally before committing. The pre-commit
hook runs both checks and blocks the commit when either fails. GitHub Actions does
not run this repository's test or lint scripts, and nothing in this repository may
depend on a GitHub workflow or status check: all validation runs on our own compute
(local hooks, `scripts/factory/test-changed.ps1`, `promote-stable.ps1`, and the
release scheduler's detached worktree). Local receipts are the validation evidence;
do not wait for, poll, or cite GitHub checks.

## One-time setup

Install PowerShell 7 and Python 3, then install the pinned YAML linter:

```powershell
py -3 -m pip install --user yamllint==1.37.1
git config --local core.hooksPath .githooks
```

## Run manually

```powershell
pwsh -NoProfile -File tests/run-tests.ps1
yamllint -c .yamllint.yaml .yamllint.yaml workflows automations routing policies templates
```

The full Factory suite takes several minutes. For a quick static check while
editing, run `pwsh -NoProfile -File tests/run-tests.ps1 -StaticOnly`; run the
full suite and YAML lint before committing.

The static check includes the script and workflow contract (`tests/workflow-contract.ps1`): every
PowerShell script under `scripts/`, `tests/` and `.claude/` must parse, and every workflow `command:` step
must name a script that exists and pass only parameters the script declares, including every mandatory
one. A workflow step is the only caller of most scripts and first runs on the host after merge, so a
renamed parameter is caught here instead of by the next scheduled run. The deploy shell tests need a POSIX
`bash` (Git for Windows provides one); a missing `bash` fails the suite.

Three more static checks cover what a Windows run cannot see by executing code:

- **Portability.** No script may use a construct that only works on Windows: `-WindowStyle` or `-Verb`, a
  Windows-only environment variable read without a fallback on the same line, a drive-letter path, or (in
  `scripts/`) a `.cmd`/`.bat` shim. A line that is deliberately Windows-only ends with `# windows-only`.
- **Host commands.** Every Python entry point started by a workflow `command:` step or by a systemd unit in
  `integrations/bazzite/` must be passed only `--flags` and a first word its argument parser defines.
- **Start-up smoke.** Every script a workflow runs (53 invocations of about 40 scripts today) is started exactly
  as its workflow step starts it, in an empty directory with an empty home, a `gh` that refuses every call and
  no reachable Cezar API, with a 60 second limit. The table is read from `workflows/*.yaml`, so a new step is
  covered the day it is written. A script is expected to stop with its own message; dying on a missing cmdlet,
  parameter, property or unset variable, or a syntax error, fails the suite. Scripts that probe live endpoints
  (`probe-model-endpoint.ps1`, `collect-environment-state.ps1`) and `factory-startup.ps1` are skipped in
  `tests/run-tests.ps1` and left to their own tests.
- **Scratch state.** Every `.factory/<name>` path that a workflow or script mentions (51 today) is created,
  untracked, in a clean repository that carries the real `.gitignore`, and the checkout must still be clean. The
  deploy guard, the promotion gate and Cezar's end-of-run autosave all depend on that. A repository without the
  ignore rule is the control, so the test is known to fail when the rule is missing.

## Linux before merge

The suite passing on Windows does not mean it passes in the Linux container that promotes a candidate.
`pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Validate` runs the host's full suite for a pushed
commit and writes a receipt to `.factory/ship-loop/receipts/linux-<sha>.json`. `AGENTS.md` requires it before
merging a change to scripts, tests, workflows, automations, policies or config.

The fixture lifecycle canary (`scripts/fixture-lifecycle.ps1`) runs against the private sandbox repository `bin0110001/cezar-factory-sandbox`, which `FACTORY_FIXTURE_REPO` overrides.
