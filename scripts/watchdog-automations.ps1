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
    [switch]$DryRun,
    [switch]$RouteCancelledRuns,
    [string]$GhCommand = 'gh'
)
$ErrorActionPreference = 'Stop'
if ($MaxRunMinutes -lt 5) { throw 'MaxRunMinutes must be at least 5.' }
$base = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
$runs = (Invoke-RestMethod "$base/runs").runs
$now = [DateTimeOffset]::UtcNow
$cancelled = @()
function Invoke-Gh([string[]]$Arguments) {
    $output = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "GitHub routing failed: $($output -join "`n")" }
}
foreach ($run in @($runs)) {
    if ([string]$run.status -ne 'running' -or -not $run.startedAt) { continue }
    $age = $now - [DateTimeOffset]::Parse([string]$run.startedAt)
    if ($age.TotalMinutes -lt $MaxRunMinutes) { continue }
    $item = [ordered]@{ id = $run.id; ageMinutes = [Math]::Round($age.TotalMinutes, 1); reason = "exceeded ${MaxRunMinutes}m liveness budget"; outcome = 'cancelled'; route = 'factory:investigate' }
    if (-not $DryRun -and $PSCmdlet.ShouldProcess($run.id, 'cancel stale Factory run')) {
        Invoke-RestMethod -Method Post "$base/runs/$([uri]::EscapeDataString([string]$run.id))/cancel" | Out-Null
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
