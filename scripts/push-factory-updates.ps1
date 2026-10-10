#!/usr/bin/env pwsh
<#
.SYNOPSIS
Pushes the current Factory version into explicitly configured projects.

.DESCRIPTION
Updates each local project's factory.version pin and managed files, or, for a
remote-only target, reconciles live Cezar automations directly from this
Factory checkout. Targets must be explicit: pass -ProjectPath or maintain a
host-local targets JSON file.
#>
[CmdletBinding()]
param(
    [string[]]$ProjectPath,
    [string]$TargetsPath = (Join-Path $PSScriptRoot '../config/factory-projects.json'),
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..'),
    [switch]$SyncAutomations,
    [switch]$Enable,
    [switch]$DryRun,
    [switch]$ForceManagedRefresh,
    [string]$ReportPath = '',
    [switch]$SkipBazziteRuntime
)

$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path $FactoryPath).Path
$version = (Get-Content -Raw (Join-Path $factory 'VERSION')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Factory VERSION '$version' is not semver." }
if (-not $ReportPath) { $ReportPath = Join-Path $factory '.factory/release-reports/release-status.jsonl' }

function Write-ReleaseStatus([string]$Target, [string]$Mode, [string]$Status, [string]$Detail, [bool]$ForceRefreshRequired = $false) {
    $record = [ordered]@{
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        factoryVersion = $version
        target = $Target
        mode = $Mode
        status = $Status
        forceRefreshRequired = $ForceRefreshRequired
        detail = $Detail
    }
    $json = $record | ConvertTo-Json -Compress
    Write-Host "RELEASE_STATUS $json"
    $parent = Split-Path -Parent $ReportPath
    if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
    Add-Content -LiteralPath $ReportPath -Value $json -Encoding utf8
}

$targets = @()
if ($ProjectPath) {
    $targets = @($ProjectPath | ForEach-Object { [pscustomobject]@{ projectPath = $_; apiUrl = $null; projectId = $null } })
}
elseif (Test-Path $TargetsPath) {
    $targets = @(Get-Content -Raw $TargetsPath | ConvertFrom-Json)
}
else {
    throw "No targets supplied. Pass -ProjectPath or create the host-local target registry '$TargetsPath' from config/factory-projects.json.example."
}
if (-not $targets.Count) { throw 'No Factory update targets configured.' }

& (Join-Path $factory 'scripts/validate-automation-catalog.ps1')

function Get-TopologyValue([string]$Name) {
    $topologyPath = Join-Path $factory 'config/server-topology.env'
    if (-not (Test-Path $topologyPath)) { throw "Bazzite runtime synchronization requires $topologyPath." }
    $line = Get-Content -LiteralPath $topologyPath | Where-Object { $_ -match "^$([regex]::Escape($Name))=(.+)$" } | Select-Object -Last 1
    if (-not $line) { throw "Bazzite runtime synchronization requires $Name in $topologyPath." }
    (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

function Sync-BazziteRuntime($Deployment) {
    $sshTarget = if ($Deployment.bazziteSshTarget) { [string]$Deployment.bazziteSshTarget } else { Get-TopologyValue 'FACTORY_CONTROL_PLANE_SSH_TARGET' }
    $remoteFactory = Get-TopologyValue 'FACTORY_CONTROL_PLANE_FACTORY_DIR'
    if ($remoteFactory -notmatch '^[A-Za-z0-9_./-]+$') { throw "Unsafe FACTORY_CONTROL_PLANE_FACTORY_DIR '$remoteFactory'." }
    if ($DryRun) {
        Write-Host "[DRY-RUN] Would verify and deploy Factory $version on Bazzite target $sshTarget ($remoteFactory)."
        return
    }

    # The remote checkout is the deployment authority. Never copy this working
    # tree over it or pull/reset it: a dirty or mismatched checkout is a hard
    # release blocker and needs its own reviewed synchronization.
    $preflight = "cd '$remoteFactory' && git diff --quiet && git diff --cached --quiet || { echo 'Bazzite Factory checkout is dirty.' >&2; exit 20; }; test `"`$(tr -d '\\r\\n' < VERSION)`" = '$version' || { echo 'Bazzite Factory version mismatch.' >&2; exit 21; }; test -f scripts/factory-startup.ps1 && test -f scripts/maintain-repository.ps1"
    & ssh -o BatchMode=yes -o ConnectTimeout=10 $sshTarget $preflight
    if ($LASTEXITCODE -ne 0) { throw "Bazzite runtime preflight failed for $sshTarget; no deployment was attempted." }

    & ssh -o BatchMode=yes -o ConnectTimeout=10 $sshTarget "cd '$remoteFactory' && bash ./scripts/deploy/deploy-bazzite.sh && podman exec cezar test -f /projects/cezar-factory/scripts/factory-startup.ps1 && podman exec cezar test -f /projects/cezar-factory/scripts/maintain-repository.ps1"
    if ($LASTEXITCODE -ne 0) { throw "Bazzite runtime deployment or container parity check failed for $sshTarget." }
    Write-Host "Deployed and verified Factory $version runtime on Bazzite target $sshTarget" -ForegroundColor Green
}

$bazziteDeployments = @{}

foreach ($target in $targets) {
    if (-not $target.projectPath -and -not $target.projectId) { throw 'Each update target requires projectPath or projectId.' }
    # mode 'shared': the project uses the mounted Factory (Cezar loads workflows and skills from it), so only
    # automations are synchronized even when a local checkout exists.
    if (-not $target.projectPath -or ($target.PSObject.Properties.Name -contains 'mode' -and $target.mode -eq 'shared')) {
        if (-not $SyncAutomations) { throw "Remote Cezar target '$($target.projectId)' requires -SyncAutomations." }
        if (-not $target.apiUrl) { throw "Remote Cezar target '$($target.projectId)' requires apiUrl." }
        $syncArgs = @('-NoProfile', '-File', (Join-Path $factory 'scripts/sync-automations.ps1'), '-SourceOnly', '-FactoryPath', $factory, '-ApiUrl', $target.apiUrl, '-ProjectId', $target.projectId)
        if ($target.PSObject.Properties.Name -contains 'projectType' -and $target.projectType) { $syncArgs += @('-ProjectType', [string]$target.projectType) }
        if ($Enable) { $syncArgs += '-Enable' }
        if ($DryRun) { $syncArgs += '-DryRun' }
        & pwsh @syncArgs
        if ($LASTEXITCODE -ne 0) {
            Write-ReleaseStatus $target.projectId 'remote-automation' 'failed' 'Automation synchronization failed.'
            throw "Remote Cezar target $($target.projectId): automation synchronization failed."
        }
        Write-ReleaseStatus $target.projectId 'remote-automation' 'synchronized' 'Factory automation definitions accepted by Cezar.'
        Write-Host "Synchronized Factory $version automations to Cezar project $($target.projectId)" -ForegroundColor Green
        if (-not $SkipBazziteRuntime -and $target.deployment -and $target.deployment.mode -eq 'remote-cezar-plus-bazzite-host') {
            $key = if ($target.deployment.bazziteSshTarget) { [string]$target.deployment.bazziteSshTarget } else { Get-TopologyValue 'FACTORY_CONTROL_PLANE_SSH_TARGET' }
            $bazziteDeployments[$key] = $target.deployment
        }
        continue
    }
    $project = (Resolve-Path $target.projectPath).Path
    $configPath = Join-Path $project '.ai/factory/factory.config.yaml'
    if (-not (Test-Path $configPath)) { throw "${project}: Factory is not installed (.ai/factory/factory.config.yaml is missing)." }

    $originalConfig = [IO.File]::ReadAllText($configPath)
    $updatedConfig = [regex]::Replace($originalConfig, '(?m)^(\s*version:\s*)"?\d+\.\d+\.\d+"?\s*$', "`$1`"$version`"")
    if ($updatedConfig -eq $originalConfig) { throw "${project}: could not update factory.version in $configPath." }
    if ($DryRun) {
        Write-Host "[DRY-RUN] Would pin $project to Factory $version, update and verify managed files$(if ($SyncAutomations) { ', then synchronize automations' })."
        continue
    }

    try {
        [IO.File]::WriteAllText($configPath, $updatedConfig)
        $updateScript = if ($ForceManagedRefresh) { 'force-update.ps1' } else { 'update.ps1' }
        $updateArgs = @('-NoProfile', '-File', (Join-Path $factory "scripts/$updateScript"), '-ProjectPath', $project, '-FactoryPath', $factory)
        & pwsh @updateArgs
        if ($LASTEXITCODE -ne 0) {
            $forceNeeded = -not $ForceManagedRefresh
            $detail = if ($forceNeeded) { 'Managed update was blocked. Review drift, then rerun with -ForceManagedRefresh to archive and replace only Factory-owned files.' } else { 'Forced managed refresh failed; inspect the recovery backup reported by force-update.ps1.' }
            Write-ReleaseStatus $project 'full-project' 'failed' $detail $forceNeeded
            throw "${project}: Factory update failed. $detail"
        }

        if ($SyncAutomations) {
            $apiUrl = if ($target.apiUrl) { $target.apiUrl } else { $env:CEZ_API_URL }
            $projectId = if ($target.projectId) { $target.projectId } else { $env:CEZ_PROJECT_ID }
            if (-not $apiUrl) { throw "${project}: -SyncAutomations requires apiUrl in the target registry or CEZ_API_URL." }
            $syncArgs = @('-NoProfile', '-File', (Join-Path $factory 'scripts/sync-automations.ps1'), '-ProjectPath', $project, '-ApiUrl', $apiUrl)
            if ($projectId) { $syncArgs += @('-ProjectId', $projectId) }
            if ($Enable) { $syncArgs += '-Enable' }
            & pwsh @syncArgs
            if ($LASTEXITCODE -ne 0) { throw "${project}: automation synchronization failed." }
        }
        Write-Host "Pushed Factory $version to $project" -ForegroundColor Green
        Write-ReleaseStatus $project 'full-project' 'synchronized' $(if ($ForceManagedRefresh) { 'Forced managed refresh completed and verified.' } else { 'Normal managed update completed and verified.' })
    }
    catch {
        [IO.File]::WriteAllText($configPath, $originalConfig)
        throw
    }
}

if (-not $SkipBazziteRuntime) {
    foreach ($deployment in $bazziteDeployments.Values) { Sync-BazziteRuntime $deployment }
}
