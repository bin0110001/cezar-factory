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
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($MaxRunMinutes -lt 5) { throw 'MaxRunMinutes must be at least 5.' }
$base = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
$runs = (Invoke-RestMethod "$base/runs").runs
$now = [DateTimeOffset]::UtcNow
$cancelled = @()
foreach ($run in @($runs)) {
    if ([string]$run.status -ne 'running' -or -not $run.startedAt) { continue }
    $age = $now - [DateTimeOffset]::Parse([string]$run.startedAt)
    if ($age.TotalMinutes -lt $MaxRunMinutes) { continue }
    $item = [ordered]@{ id = $run.id; ageMinutes = [Math]::Round($age.TotalMinutes, 1); reason = "exceeded ${MaxRunMinutes}m liveness budget" }
    if (-not $DryRun -and $PSCmdlet.ShouldProcess($run.id, 'cancel stale Factory run')) {
        Invoke-RestMethod -Method Post "$base/runs/$([uri]::EscapeDataString([string]$run.id))/cancel" | Out-Null
        $item.status = 'cancelled'
    } else { $item.status = 'would-cancel' }
    $cancelled += [pscustomobject]$item
}
[ordered]@{ project = $ProjectId; checkedAt = $now.ToString('o'); maxRunMinutes = $MaxRunMinutes; cancelled = @($cancelled) } | ConvertTo-Json -Depth 5
