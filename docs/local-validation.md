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
