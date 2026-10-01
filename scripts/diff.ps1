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

$desired = @{}; foreach ($d in (Get-DesiredFiles $factory $cfg $version)) { $desired[$d.Target] = $d }
$drift = [ordered]@{ Modified = @(); Missing = @(); Obsolete = @(); Unmanaged = @() }
$manifest = Read-Manifest $fdir
$owned = @{}; if ($manifest) { foreach ($f in $manifest.files) { $owned[$f.path] = $true } }

foreach ($t in $desired.Keys) {
    $p = Join-Path $fdir $t
    if (-not (Test-Path $p)) { $drift.Missing += $t }
    elseif ((Get-FileTextHash $p) -ne $desired[$t].Hash) { $drift.Modified += $t }
}
foreach ($t in $owned.Keys) {
    if (-not $desired.ContainsKey($t) -and (Test-Path (Join-Path $fdir $t))) { $drift.Obsolete += $t }
}
foreach ($dir in 'skills', 'workflows', 'automations', 'policies', 'schemas') {
    $root = Join-Path $fdir $dir
    if (-not (Test-Path $root)) { continue }
    foreach ($f in Get-ChildItem $root -File -Recurse) {
        $rel = $f.FullName.Substring($fdir.Length).TrimStart('\', '/') -replace '\\', '/'
        if (-not $desired.ContainsKey($rel) -and -not $owned.ContainsKey($rel)) { $drift.Unmanaged += $rel }
    }
}
$total = 0
foreach ($k in $drift.Keys) {
    $items = @(@($drift[$k]) | Sort-Object)
    if ($items.Count) { Write-Host "${k}:"; $items | ForEach-Object { Write-Host "  $_" }; $total += $items.Count }
}
if ($total) { Write-Host "DRIFT: $total file(s)" -ForegroundColor Red; exit 1 }
Write-Host 'PASS: installed factory matches pinned source' -ForegroundColor Green
