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
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path $FactoryPath).Path
$version = (Get-Content -Raw (Join-Path $factory 'VERSION')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Factory VERSION '$version' is not semver." }

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

foreach ($target in $targets) {
    if (-not $target.projectPath -and -not $target.projectId) { throw 'Each update target requires projectPath or projectId.' }
    if (-not $target.projectPath) {
        if (-not $SyncAutomations) { throw "Remote Cezar target '$($target.projectId)' requires -SyncAutomations." }
        if (-not $target.apiUrl) { throw "Remote Cezar target '$($target.projectId)' requires apiUrl." }
        $syncArgs = @('-NoProfile', '-File', (Join-Path $factory 'scripts/sync-automations.ps1'), '-SourceOnly', '-FactoryPath', $factory, '-ApiUrl', $target.apiUrl, '-ProjectId', $target.projectId)
        if ($Enable) { $syncArgs += '-Enable' }
        if ($DryRun) { $syncArgs += '-DryRun' }
        & pwsh @syncArgs
        if ($LASTEXITCODE -ne 0) { throw "Remote Cezar target $($target.projectId): automation synchronization failed." }
        Write-Host "Synchronized Factory $version automations to Cezar project $($target.projectId)" -ForegroundColor Green
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
        $updateArgs = @('-NoProfile', '-File', (Join-Path $factory 'scripts/update.ps1'), '-ProjectPath', $project, '-FactoryPath', $factory)
        & pwsh @updateArgs
        if ($LASTEXITCODE -ne 0) { throw "${project}: Factory update failed." }

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
    }
    catch {
        [IO.File]::WriteAllText($configPath, $originalConfig)
        throw
    }
}
