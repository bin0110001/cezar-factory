#!/usr/bin/env pwsh
<#
.SYNOPSIS
Create (or update in place) the factory's GitHub labels from policies/labels.yaml. Idempotent.
.EXAMPLE
./.ai/factory/scripts/create-labels.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$PoliciesDir = (Join-Path $PSScriptRoot '../policies'),
    [string]$Repo,
    [switch]$DryRun
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$colors = @{ 'factory-state' = '1d76db'; 'factory-classification' = '6f42c1'; type = '0e8a16'; risk = 'fbca04'; complexity = 'd4c5f9'; agent = '5319e7' }
$riskColors = @{ 'risk:low' = '0e8a16'; 'risk:medium' = 'fbca04'; 'risk:high' = 'b60205' }
$descriptions = @{
    'factory:new'               = 'Factory: newly filed, not yet triaged'
    'factory:needs-plan'        = 'Factory: ready for the planning agent'
    'factory:needs-help'        = 'Factory: major architectural decision required'
    'factory:ready'             = 'Factory: planned and ready for implementation'
    'factory:working'           = 'Factory: implementation in progress'
    'factory:review'            = 'Factory: PR awaiting independent review'
    'factory:changes-requested' = 'Factory: review requested changes'
    'factory:human-review'      = 'Factory: major architectural decision hold'
    'factory:blocked'           = 'Factory: blocked by an external dependency'
    'factory:done'              = 'Factory: complete'
    'factory:investigate'       = 'Factory: repeated failure awaiting investigation'
    'factory:implemented'       = 'Factory: work complete on a pushed branch, no PR yet'
    'factory:pr-open'           = 'Factory: PR open against dev, awaiting merge'
    'factory:interactive'       = 'Factory: worked in a local dev window; automations and stale sweeps skip it'
    'factory:auditing'          = 'Factory: bounded backlog-label audit in progress'
    'factory:tracking'          = 'Factory: tracking parent, not executable work'
    'complexity:small'          = 'Factory: isolated, low-complexity change'
    'complexity:medium'         = 'Factory: substantial multi-step change'
    'complexity:large'          = 'Factory: large or cross-cutting change'
}

$group = $null
$labels = [System.Collections.Generic.List[object]]::new()
foreach ($l in Get-Content (Join-Path $PoliciesDir 'labels.yaml')) {
    if ($l -match '^([\w-]+):\s*$') { $group = $Matches[1]; continue }
    if ($group -and $l -match '^\s+-\s+(\S+)') {
        $name = $Matches[1]
        $color = if ($riskColors.ContainsKey($name)) { $riskColors[$name] } else { $colors[$group] }
        $desc = if ($descriptions.ContainsKey($name)) { $descriptions[$name] } else { "Factory $group label" }
        $labels.Add([pscustomobject]@{ Name = $name; Color = $color; Description = $desc })
    }
}
if (-not $labels.Count) { throw 'no labels found in policies/labels.yaml' }
# States a lifecycle profile adds (a sign-off gate, say) need their labels too, or the router cannot apply them.
. (Join-Path $PSScriptRoot 'lifecycle-lib.ps1')
try {
    $profileLifecycle = Get-FactoryLifecycle -Path (Join-Path $PoliciesDir 'lifecycle.json')
    foreach ($stateName in $profileLifecycle.States.Keys) {
        if (@($labels | Where-Object { $_.Name -eq $stateName }).Count) { continue }
        $stateDescription = if ($profileLifecycle.States[$stateName]['description']) { [string]$profileLifecycle.States[$stateName]['description'] } else { "Factory: $stateName" }
        $labels.Add([pscustomobject]@{ Name = $stateName; Color = $colors['factory-state']; Description = $stateDescription })
    }
} catch { Write-Warning "lifecycle states not added to the label set: $($_.Exception.Message)" }

# This runs in every hourly maintenance. Creating every label every time cost one GitHub call per label
# and failed the whole run when any one of them hit a server error. Read the labels once and write only
# the ones that are missing or differ; if the listing itself fails, fall back to writing them all.
$existing = $null
if (-not $DryRun) {
    $listArgs = @('label', 'list', '--limit', '300', '--json', 'name,color,description')
    if ($Repo) { $listArgs += '--repo', $Repo }
    try {
        $listed = & $GhCommand @listArgs 2>$null
        if ($LASTEXITCODE -eq 0 -and $listed) {
            $existing = @{}
            foreach ($item in @(($listed -join "`n") | ConvertFrom-Json)) { $existing[[string]$item.name] = $item }
        }
    } catch { $existing = $null }
}
$written = 0
foreach ($lb in $labels) {
    $args2 = @('label', 'create', $lb.Name, '--color', $lb.Color, '--description', $lb.Description, '--force')
    if ($Repo) { $args2 += '--repo', $Repo }
    if ($DryRun) { Write-Host "[DRY-RUN] gh $($args2 -join ' ')"; continue }
    if ($null -ne $existing -and $existing.ContainsKey($lb.Name)) {
        $have = $existing[$lb.Name]
        if (([string]$have.color).TrimStart('#') -ieq $lb.Color -and [string]$have.description -eq $lb.Description) { continue }
    }
    # GitHub answers 502 or 503 now and then; that is not a reason to fail a maintenance run.
    for ($attempt = 1; ; $attempt++) {
        & $GhCommand @args2 | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        if ($attempt -ge 3) { throw "failed to create label $($lb.Name)" }
        Start-Sleep -Seconds (2 * $attempt)
    }
    $written++
    Write-Host "label $($lb.Name)"
}
Write-Host "$($labels.Count) labels $(if ($DryRun) { 'would be ' })ensured ($written written)"
