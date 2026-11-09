#!/usr/bin/env pwsh
<#
.SYNOPSIS
Removes a project's installed copy of the Factory so it uses the shared, mounted Factory instead.

.DESCRIPTION
Cezar loads Factory workflows and skills from the mounted Factory checkout (CEZ_SHARED_WORKFLOWS_DIRS /
CEZ_SHARED_SKILL_DIRS), but a project's own `.ai/cezar/workflows` and `.ai/skills` files shadow shared
ones by name - so a stale installed copy would keep winning. This deletes exactly the files listed in
the project's `.ai/factory/manifest.json` (plus the manifest, VERSION and gitignore fragment) and
keeps the project-owned `.ai/factory/factory.config.yaml` and `overrides/`. A managed file that was
edited locally is reported and left in place unless -Force. Review and commit the result.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$project = Resolve-ProjectPath $ProjectPath
$fdir = Get-FactoryDir $project
$manifest = Read-Manifest $fdir
if (-not $manifest) { throw "${project}: no Factory manifest (.ai/factory/manifest.json); nothing to migrate." }

# Classify first and delete nothing unless every managed file is clean (or -Force): all or nothing.
$removed = @(); $modified = @(); $missing = 0
foreach ($file in $manifest.files) {
    $path = Join-Path $project $file.path
    if (-not (Test-Path -LiteralPath $path)) { $missing++; continue }
    if ((Get-FileTextHash $path) -ne $file.sha256 -and -not $Force) { $modified += $file.path; continue }
    $removed += $file.path
}
foreach ($extra in 'manifest.json', 'VERSION', 'gitignore.fragment') {
    if (Test-Path -LiteralPath (Join-Path $fdir $extra)) { $removed += ".ai/factory/$extra" }
}
if ($modified.Count -or $DryRun) { $removalList = @() } else { $removalList = $removed }
foreach ($rel in $removalList) { Remove-Item -LiteralPath (Join-Path $project $rel) -Force }
if (-not $DryRun -and -not $modified.Count) {
    # Tidy directories the removal emptied (never the project-owned config or overrides).
    foreach ($dir in Get-ChildItem -LiteralPath $project -Directory -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '[\\/]\.ai[\\/]' } | Sort-Object { $_.FullName.Length } -Descending) {
        if (-not (Get-ChildItem -LiteralPath $dir.FullName -Force)) { Remove-Item -LiteralPath $dir.FullName -Force }
    }
}

$prefix = if ($DryRun) { '[DRY-RUN] Would remove' } else { 'Removed' }
if ($modified.Count) {
    Write-Host "Nothing was removed from $project."
} else {
    Write-Host "$prefix $($removed.Count) Factory-managed file(s) from $project ($missing already absent)."
}
if ($modified.Count) {
    Write-Host 'Left in place (edited locally; move the change into the project or rerun with -Force):' -ForegroundColor Yellow
    $modified | ForEach-Object { Write-Host "  $_" }
    exit 1
}
exit 0
