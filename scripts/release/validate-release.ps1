#!/usr/bin/env pwsh
[CmdletBinding()]
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$version = (Get-Content -Raw (Join-Path $root 'VERSION')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "VERSION is not semver: $version" }
$changelog = Get-Content -Raw (Join-Path $root 'CHANGELOG.md')
if ($changelog -notmatch "(?m)^## \[$([regex]::Escape($version))\](?: - \d{4}-\d{2}-\d{2})?$") {
    throw "CHANGELOG.md has no release heading for $version"
}
foreach ($path in @('VERSION','CHANGELOG.md','.github/workflows/ci.yml','tests/run-tests.ps1','scripts/install.ps1','scripts/update.ps1','scripts/diff.ps1','scripts/verify.ps1')) {
    if (-not (Test-Path (Join-Path $root $path))) { throw "release-required file missing: $path" }
}
if (-not $SkipTests) {
    & pwsh -NoProfile -File (Join-Path $root 'tests/run-tests.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "Release metadata valid for $version" -ForegroundColor Green
