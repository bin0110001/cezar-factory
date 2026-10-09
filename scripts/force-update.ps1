#!/usr/bin/env pwsh
<#
.SYNOPSIS
Rebuilds a project's Factory-managed layer after an explicitly authorized
deployment recovery.

.DESCRIPTION
Unlike update.ps1, this command archives and replaces conflicting
Factory-managed files. It never removes project-owned skills or workflows.
Use only with -ForceManagedRefresh in the release command after reviewing the
drift report. Normal updates remain fail-closed.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..'),
    [string]$BackupRoot = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$project = Resolve-ProjectPath $ProjectPath
$factory = (Resolve-Path $FactoryPath).Path
$factoryDir = Get-FactoryDir $project
$configPath = Join-Path $factoryDir 'factory.config.yaml'
if (-not (Test-Path $configPath)) { throw "${project}: Factory is not installed (.ai/factory/factory.config.yaml is missing)." }
$config = Read-FactoryConfig $configPath
$errors = Test-FactoryConfig $config
if ($errors) { throw "${project}: invalid Factory config: $($errors -join '; ')" }
$version = Get-FactoryVersion $factory
if ($config.factory.version -ne $version) { throw "${project}: config pins Factory $($config.factory.version), but source is $version." }

if (-not $BackupRoot) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $BackupRoot = Join-Path $project ".factory/factory-force-backups/$stamp"
}
$backup = [IO.Path]::GetFullPath($BackupRoot)
$workflowDir = Join-Path $project '.ai/cezar/workflows'
$skillsDir = Join-Path $project '.ai/skills'
$workflowFiles = if (Test-Path $workflowDir) { @(Get-ChildItem -LiteralPath $workflowDir -File -Filter 'factory-*.yaml') } else { @() }
$skillDirs = if (Test-Path $skillsDir) { @(Get-ChildItem -LiteralPath $skillsDir -Directory -Filter 'factory-*') } else { @() }

if ($DryRun) {
    Write-Host "[DRY-RUN] Would archive Factory-managed files to $backup"
    Write-Host "[DRY-RUN] Would replace $factoryDir, $($workflowFiles.Count) Factory workflow(s), and $($skillDirs.Count) Factory skill(s) with Factory $version."
    exit 0
}

New-Item -ItemType Directory -Force $backup | Out-Null
if (Test-Path $factoryDir) { Copy-Item -LiteralPath $factoryDir -Destination (Join-Path $backup 'factory') -Recurse -Force }
if ($workflowFiles.Count) {
    $workflowBackup = Join-Path $backup 'workflows'
    New-Item -ItemType Directory -Force $workflowBackup | Out-Null
    foreach ($file in $workflowFiles) { Copy-Item -LiteralPath $file.FullName -Destination $workflowBackup -Force }
}
if ($skillDirs.Count) {
    $skillBackup = Join-Path $backup 'skills'
    New-Item -ItemType Directory -Force $skillBackup | Out-Null
    foreach ($dir in $skillDirs) { Copy-Item -LiteralPath $dir.FullName -Destination $skillBackup -Recurse -Force }
}

$projectConfig = [IO.File]::ReadAllText($configPath)
Remove-Item -LiteralPath $factoryDir -Recurse -Force
foreach ($file in $workflowFiles) { if (Test-Path $file.FullName) { Remove-Item -LiteralPath $file.FullName -Force } }
foreach ($dir in $skillDirs) { if (Test-Path $dir.FullName) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force } }
Write-Utf8 $configPath $projectConfig

try {
    & (Join-Path $factory 'scripts/install.ps1') -ProjectPath $project -FactoryPath $factory
    if ($LASTEXITCODE -ne 0) { throw "${project}: forced Factory installation failed; recovery backup is at $backup." }
    & (Join-Path $factory 'scripts/verify.ps1') -ProjectPath $project -FactoryPath $factory
    if ($LASTEXITCODE -ne 0) { throw "${project}: forced Factory installation did not verify; recovery backup is at $backup." }
}
catch {
    throw "$_ Recovery backup: $backup"
}
Write-Host "Forced Factory $version refresh completed for $project. Recovery backup: $backup" -ForegroundColor Yellow
