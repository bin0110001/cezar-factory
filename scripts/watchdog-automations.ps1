#!/usr/bin/env pwsh
<#!
.SYNOPSIS
Cancel Factory runs that have exceeded the bounded wall-clock liveness budget.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ApiUrl,
    [Parameter(Mandatory)][string]$ProjectId,
    [int]$MaxRunMinutes = 15,
    # Only runs of these workflows are considered (comma separated; empty = every workflow). Agent
    # implementation runs legitimately take longer than a housekeeping budget, so scheduled use
    # names the bounded deterministic workflows.
    [string[]]$Workflow = @(),
    # The calling run, so a watchdog step never cancels the run it is part of.
    [string]$ExcludeRunId = '',
    [switch]$DryRun,
    [switch]$RouteCancelledRuns,
    [string]$GhCommand = 'gh'
)
$ErrorActionPreference = 'Stop'
if ($MaxRunMinutes -lt 5) { throw 'MaxRunMinutes must be at least 5.' }
# Cezar passes command arguments as shell text, so "a,b" arrives as one string.
$Workflow = @($Workflow | ForEach-Object { @($_ -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) })
$base = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
$runs = (Invoke-RestMethod "$base/runs" -TimeoutSec 30).runs
$now = [DateTimeOffset]::UtcNow
$cancelled = @()
function Invoke-Gh([string[]]$Arguments) {
    $output = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "GitHub routing failed: $($output -join "`n")" }
}
foreach ($run in @($runs)) {
    if ([string]$run.status -ne 'running' -or -not $run.startedAt) { continue }
    if ($ExcludeRunId -and [string]$run.id -eq $ExcludeRunId) { continue }
    if ($Workflow.Count -and $Workflow -notcontains [string]$run.workflow) { continue }
    # ConvertFrom-Json turns an ISO timestamp into a DateTime; round-tripping it through [string] drops the
    # zone and makes the age depend on the host's timezone. Convert the DateTime itself.
    $startedAt = if ($run.startedAt -is [datetime]) { [DateTimeOffset]::new($run.startedAt.ToUniversalTime()) } else { [DateTimeOffset]::Parse([string]$run.startedAt) }
    $age = $now - $startedAt
    if ($age.TotalMinutes -lt $MaxRunMinutes) { continue }
    $item = [ordered]@{ id = $run.id; ageMinutes = [Math]::Round($age.TotalMinutes, 1); reason = "exceeded ${MaxRunMinutes}m liveness budget"; outcome = 'cancelled'; route = 'factory:investigate' }
    if (-not $DryRun -and $PSCmdlet.ShouldProcess($run.id, 'cancel stale Factory run')) {
        Invoke-RestMethod -Method Post -TimeoutSec 30 "$base/runs/$([uri]::EscapeDataString([string]$run.id))/cancel" | Out-Null
        $item.status = 'cancelled'
        if ($RouteCancelledRuns) {
            $issue = if ($run.issue) { [int]$run.issue } elseif ($run.issueNumber) { [int]$run.issueNumber } elseif ($run.metadata -and $run.metadata.issue) { [int]$run.metadata.issue } else { 0 }
            if ($issue -gt 0) {
                Invoke-Gh @('issue','edit',[string]$issue,'--add-label','factory:investigate','--remove-label','factory:working')
                Invoke-Gh @('issue','comment',[string]$issue,'--body',"Factory watchdog cancelled stale run $($run.id); routed to factory:investigate for bounded recovery.")
                $item.routedIssue = $issue
            } else { $item.route = 'factory:investigate (issue id unavailable; maintenance fallback required)' }
        }
    } else { $item.status = 'would-cancel' }
    $cancelled += [pscustomobject]$item
}
[ordered]@{ project = $ProjectId; checkedAt = $now.ToString('o'); maxRunMinutes = $MaxRunMinutes; cancelled = @($cancelled) } | ConvertTo-Json -Depth 5
