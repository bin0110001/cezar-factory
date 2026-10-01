#!/usr/bin/env pwsh
<#
.SYNOPSIS
Detect drift between a project's installed factory files and the pinned source version. Exits 1 on drift.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$project = Resolve-ProjectPath $ProjectPath
$factory = (Resolve-Path $FactoryPath).Path
$fdir = Get-FactoryDir $project
$cfg = Read-FactoryConfig (Join-Path $fdir 'factory.config.yaml')
$version = Get-FactoryVersion $factory
if ($cfg['factory']['version'] -ne $version) { throw "Config pins $($cfg['factory']['version']) but factory source is $version" }

$desired = @{}; foreach ($d in (Get-DesiredFiles $factory $cfg $version $project)) { $desired[$d.Target] = $d }
$drift = [ordered]@{ Modified = @(); Missing = @(); Obsolete = @(); Unmanaged = @() }
$manifest = Read-Manifest $fdir
$owned = @{}; if ($manifest) { foreach ($f in $manifest.files) { $owned[$f.path] = $true } }

foreach ($t in $desired.Keys) {
    $p = Join-Path $project $t
    if (-not (Test-Path $p)) { $drift.Missing += $t }
    elseif ((Get-FileTextHash $p) -ne $desired[$t].Hash) { $drift.Modified += $t }
}
foreach ($t in $owned.Keys) {
    if (-not $desired.ContainsKey($t) -and (Test-Path (Join-Path $project $t))) { $drift.Obsolete += $t }
}
# Unmanaged files inside factory-owned namespaces: .ai/factory/*, factory-* workflows and skills.
$scanRoots = @(
    @{ Dir = '.ai/factory/policies'; Filter = '*' }, @{ Dir = '.ai/factory/schemas'; Filter = '*' },
    @{ Dir = '.ai/factory/scripts'; Filter = '*' }, @{ Dir = '.ai/factory/automations'; Filter = '*' },
    @{ Dir = '.ai/cezar/workflows'; Filter = 'factory-*' }, @{ Dir = '.ai/skills'; Filter = 'factory-*' }
)
foreach ($sr in $scanRoots) {
    $root = Join-Path $project $sr.Dir
    if (-not (Test-Path $root)) { continue }
    foreach ($item in Get-ChildItem $root -Filter $sr.Filter -Force) {
        $files = if ($item.PSIsContainer) { Get-ChildItem $item.FullName -File -Recurse } else { @($item) }
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($project.Length).TrimStart([char[]]'\/') -replace '\\', '/'
            if (-not $desired.ContainsKey($rel) -and -not $owned.ContainsKey($rel)) { $drift.Unmanaged += $rel }
        }
    }
}
$total = 0
foreach ($k in $drift.Keys) {
    $items = @(@($drift[$k]) | Sort-Object)
    if ($items.Count) { Write-Host "${k}:"; $items | ForEach-Object { Write-Host "  $_" }; $total += $items.Count }
}
if ($total) { Write-Host "DRIFT: $total file(s)" -ForegroundColor Red; exit 1 }
Write-Host 'PASS: installed factory matches pinned source' -ForegroundColor Green
