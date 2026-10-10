#!/usr/bin/env pwsh
<##
.SYNOPSIS
First step of every issue-scoped workflow: detects an issue that is already resolved.

.DESCRIPTION
An issue that is CLOSED (or already labelled factory:done) needs no plan, implementation,
review, fix, or investigation. When detected, this script reconciles the lifecycle label to
factory:done (so the poller stops re-selecting it) and writes the marker
.factory/already-resolved.json. Every later script step and the agent prompt treat that
marker as "nothing to do" and finish successfully. When the issue is still open, any stale
marker left in a reused worktree is removed.
##>
[CmdletBinding()]
param(
    [int]$Issue = 0,
    [string]$Task,
    [string]$GhCommand = 'gh',
    [string]$OutputPath = '.factory/already-resolved.json'
)
$ErrorActionPreference = 'Stop'

# Workflow commands pass the raw task text ("GitHub issue #N (...) at <url>") so no agent has to extract it.
if ($Issue -lt 1 -and $Task -match 'GitHub issue #(\d+)|/issues/(\d+)|#(\d+)') {
    $Issue = [int](($Matches[1], $Matches[2], $Matches[3]) | Where-Object { $_ } | Select-Object -First 1)
}
if ($Issue -lt 1) { throw 'An issue number is required: pass -Issue or a -Task containing "GitHub issue #N".' }

Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue

$output = & $GhCommand issue view ([string]$Issue) --json 'number,state,labels' 2>&1
if ($LASTEXITCODE -ne 0) { throw "gh issue view $Issue failed ($LASTEXITCODE): $($output -join "`n")" }
$record = [string]::Join("`n", [string[]]$output) | ConvertFrom-Json
$labels = @($record.labels | ForEach-Object { $_.name })

$reason = $null
if ([string]$record.state -eq 'CLOSED') { $reason = 'issue is closed' }
elseif ($labels -contains 'factory:done') { $reason = 'issue is labelled factory:done' }

if (-not $reason) {
    Write-Output (@{ status = 'open'; issue = $Issue } | ConvertTo-Json -Compress)
    exit 0
}

# Reconcile the lifecycle label first so a stale factory:ready/changes-requested cannot re-trigger this issue.
& "$PSScriptRoot/route-state.ps1" -Event already-resolved -Issue $Issue -GhCommand $GhCommand | Out-Null
if ($LASTEXITCODE -ne 0) { throw "route-state already-resolved failed for issue #$Issue" }

$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$marker = [ordered]@{ resolved = $true; issue = $Issue; reason = $reason; checkedAt = (Get-Date).ToUniversalTime().ToString('o') }
$marker | ConvertTo-Json | Set-Content -Path $OutputPath -Encoding utf8
Write-Output (@{ status = 'already-resolved'; issue = $Issue; reason = $reason } | ConvertTo-Json -Compress)
