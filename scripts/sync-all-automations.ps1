#!/usr/bin/env pwsh
<#
.SYNOPSIS
Reconciles the Factory automation definitions into every registered Cezar project.

.DESCRIPTION
Runs inside the Cezar container (where FACTORY_RUNTIME_ROOT is the mounted Factory checkout) after
the host fast-forwards that checkout, so automations follow the checkout automatically. Targets come
only from the host-local registry (config/factory-projects.json); a missing or empty registry
changes nothing and fails. $env:CEZ_API_URL (the container-local Cezar address) overrides each
entry's apiUrl, which is the address an operator workstation uses.
#>
[CmdletBinding()]
param(
    [string]$FactoryPath = $(if ($env:FACTORY_RUNTIME_ROOT) { $env:FACTORY_RUNTIME_ROOT } else { Join-Path $PSScriptRoot '..' }),
    [string]$RegistryPath = '',
    [string]$ApiUrl = $env:CEZ_API_URL,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path $FactoryPath).Path
if (-not $RegistryPath) { $RegistryPath = Join-Path $factory 'config/factory-projects.json' }
if (-not (Test-Path -LiteralPath $RegistryPath)) { Write-Error "No target registry at $RegistryPath; nothing was synchronized."; exit 1 }
$targets = @(Get-Content -Raw -LiteralPath $RegistryPath | ConvertFrom-Json)
if (-not $targets.Count) { Write-Error "Target registry $RegistryPath is empty; nothing was synchronized."; exit 1 }

$failed = @()
foreach ($target in $targets) {
    if (-not $target.projectId) { $failed += '(entry without projectId)'; continue }
    $api = if ($ApiUrl) { $ApiUrl } else { [string]$target.apiUrl }
    if (-not $api) { $failed += "$($target.projectId): no apiUrl"; continue }
    $arguments = @('-NoProfile', '-File', (Join-Path $factory 'scripts/sync-automations.ps1'), '-SourceOnly', '-FactoryPath', $factory, '-ApiUrl', $api, '-ProjectId', [string]$target.projectId)
    if ($target.PSObject.Properties.Name -contains 'projectType' -and $target.projectType) { $arguments += @('-ProjectType', [string]$target.projectType) }
    if ($DryRun) { $arguments += '-DryRun' }
    & pwsh @arguments
    if ($LASTEXITCODE -ne 0) { $failed += [string]$target.projectId }
    else { Write-Host "Synchronized automations for $($target.projectId)" }
}
if ($failed.Count) { Write-Error "Automation synchronization failed for: $($failed -join ', ')"; exit 1 }
exit 0
