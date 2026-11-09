---
name: workflow-iterate
description: Run one Factory workflow locally (headless, from this checkout), read why it failed, edit the workflow or its scripts, and run it again, without pushing or deploying. Use when iterating on or debugging a Cezar workflow.
---

# Iterate on a workflow locally

This is for the edit, run, read-the-failure loop on the Windows dev box. It never deploys, promotes or
touches Bazzite; hand off to `ship-fix` once the workflow passes.

```powershell
pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Run -Workflow <name> -Task "<task text>" [-Target <dir>] [-Model <id>] [-DryRun]
```

- `-Workflow` is the file name (`health`) or the workflow's own name (`factory-health`).
- `-Task` is the text the workflow receives as `{{task}}`; pass the same shape the automation would
  (for example the issue reference), not a new description.
- Workflows load from this checkout's `workflows/` and `skills/`, and their `command:` steps get
  `FACTORY_RUNTIME_ROOT` pointing at this checkout, so your uncommitted edits are what runs.
- `-Target` runs it against another project checkout instead of this one.
- Every call restarts from the first step. There is no resume; steps are expected to be idempotent.

Needs the built CLI at `cezar/packages/cezar/dist/index.js` (exit 4 otherwise: build it first).

## Output and exit codes

`ITER_RUN` (with the log path), then the live step output, then one of:

- `ITER_DONE`, exit 0: the workflow completed.
- `ITER_STEP_FAILED <last step>` + up to three `ITER_ERROR` lines + `ITER_FAILED`, exit 5.
- Exit 3: the attempt budget (`maxRunAttempts`, 10) for that workflow is spent. Stop and tell the user.
- Exit 2: bad input (unknown workflow lists the available ones). Exit 4: CLI not built.

Read the failing step's section of the log file named in the output, not the whole log.

## The loop

1. Run the workflow. On `ITER_FAILED`, find the cause in the log's last step.
2. Fix the workflow YAML, the script it calls, or the skill. Change one thing per attempt.
3. Run again. Repeat until `ITER_DONE` or the budget is spent.
4. Run `tests/run-tests.ps1` before committing, then use `ship-fix` to push and verify in the real Cezar.

Local runs write the same `.factory/` artifacts a real run would; attempt state and logs are under
`.factory/ship-loop/` (gitignored). Delete `.factory/ship-loop/<project>-run-<workflow>.json` to reset the budget.
A run that reaches an agent step uses the local provider login and spends real tokens.
