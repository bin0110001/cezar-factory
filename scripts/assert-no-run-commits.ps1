#!/usr/bin/env pwsh
<##
.SYNOPSIS
Fails a housekeeping run that made a commit.

.DESCRIPTION
A housekeeping run (maintenance, health) reads and labels; it has nothing to commit. Two things have put
commits on `cez/<id>` branches, on `main`, and once on the root `stable` checkout:

  - Cezar's end-of-run autosave ("cezar autosave (run finalize)") commits whatever scratch is not ignored.
    That is closed by `.gitignore` (everything under `.factory/` is ignored unless deliberately tracked) and
    by a suite test; this step cannot see it, because the autosave happens after the last step.
  - An agent step that commits, pushes and opens a pull request itself, with an improvised message. In
    November 2026 the label-audit step did this every hour. This step is the check for that.

The run's branch was created when the run started, so the first entry in the branch's reflog is the commit
it started from. Anything between that commit and HEAD was committed by this run's own steps.
#>
[CmdletBinding()]
param(
    [string]$OutputPath = '.factory/run-commits.json',
    [string]$RepositoryPath = (Get-Location).Path
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Git([string[]]$Arguments) {
    $output = & git -C $RepositoryPath @Arguments 2>&1
    [pscustomobject]@{ Code = $LASTEXITCODE; Lines = @($output | ForEach-Object { [string]$_ }) }
}
function Write-Result($Result) {
    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $Result | ConvertTo-Json -Depth 5 | Set-Content -NoNewline $OutputPath
    $Result | ConvertTo-Json -Depth 5
}

$branch = Invoke-Git @('branch', '--show-current')
$name = if ($branch.Code -eq 0 -and $branch.Lines.Count) { $branch.Lines[0].Trim() } else { '' }
if (-not $name) {
    # A detached checkout has no branch reflog to read a starting point from. Say so; do not guess.
    Write-Result ([ordered]@{ status = 'unknown'; reason = 'not on a branch; the starting commit of this run cannot be determined'; commits = @() })
    exit 0
}
$reflog = Invoke-Git @('reflog', 'show', '--format=%H', $name)
$entries = @($reflog.Lines | Where-Object { $_ -match '^[0-9a-f]{40}$' })
if ($reflog.Code -ne 0 -or -not $entries.Count) {
    Write-Result ([ordered]@{ status = 'unknown'; branch = $name; reason = 'the branch has no reflog; the starting commit of this run cannot be determined'; commits = @() })
    exit 0
}
$start = $entries[-1]
$made = Invoke-Git @('log', '--format=%h %an: %s', "$start..HEAD")
if ($made.Code -ne 0) { throw "git log $start..HEAD failed: $($made.Lines -join "`n")" }
$commits = @($made.Lines | Where-Object { $_ })
$result = [ordered]@{
    status = if ($commits.Count) { 'commits-found' } else { 'clean' }
    branch = $name
    startedFrom = $start
    commits = $commits
}
Write-Result $result
if ($commits.Count) {
    Write-Error "this run made $($commits.Count) commit(s) on $name. A housekeeping run must not commit, push or open a pull request: $($commits -join '; ')"
    exit 1
}
