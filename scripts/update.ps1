#!/usr/bin/env pwsh
<#
.SYNOPSIS
Upgrade a project's installed factory files to the version pinned in .ai/factory/factory.config.yaml.
.DESCRIPTION
Never tracks main: edit factory.version first, then run this with -FactoryPath pointing at a checkout
of that version. Only files listed in the install manifest are overwritten or removed; project-owned
files and overrides are never touched. Refuses when ownership is ambiguous or managed files were edited.
Rollback = restore the previous pin and run this against a checkout of the previous version.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..'),
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$project = Resolve-ProjectPath $ProjectPath
$factory = (Resolve-Path $FactoryPath).Path
$fdir = Get-FactoryDir $project
$configPath = Join-Path $fdir 'factory.config.yaml'
if (-not (Read-Manifest $fdir)) { throw 'No manifest found; run install.ps1 first.' }

$r = Invoke-FactorySync -ProjectPath $project -FactoryRoot $factory -ConfigPath $configPath -DryRun:$DryRun
Write-SyncSummary $r -DryRun:$DryRun
if ($r.Blocked) {
    Write-Host 'REFUSED: ambiguous or locally modified managed files; nothing was written.' -ForegroundColor Red
    foreach ($f in @($r.Ambiguous) + @($r.Modified)) { Write-Host "  $f" }
    exit 1
}
if (-not $DryRun) {
    & (Join-Path $PSScriptRoot 'verify.ps1') -ProjectPath $project -FactoryPath $factory
    exit $LASTEXITCODE
}
