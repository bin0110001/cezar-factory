---
name: ship-status
description: Check on a verification run (by issue or run id), optionally waiting for it to finish, and report passed/failed/running. Use after ship-verify or when asked how a job is going.
---

# Check a verification run

```powershell
pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Status -Issue <N> [-Wait]   # latest attempt for the issue
pwsh -NoProfile -File .claude/ship/ship-loop.ps1 -Action Status -RunId <id> [-Wait]
```

`-Wait` polls every 20 s up to `verifyTimeoutMinutes`. Output is `SHIP_STATUS {runId,status,outcome}`;
exit 0 = passed (run `done`), 5 = failed or cancelled, 6 = still running. With `-Issue` the outcome is
written back to the attempt record.

On failure, read the run's history through the Cezar API (`GET /runs/<id>/history`), summarize the cause,
and return to the `ship-fix` loop if attempts remain. `done` means the workflow completed; for a
failure-driven issue also confirm from the history that the original failure signature is gone before
calling it verified.
