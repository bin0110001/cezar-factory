#!/usr/bin/env pwsh
<#
.SYNOPSIS
Promotes the current commit to the `stable` branch only after the full Factory test suite passes.

.DESCRIPTION
`stable` is the only ref the Bazzite host deploys (scripts/deploy/factory-autodeploy.sh fast-forwards
the mounted Factory checkout to it, and Cezar loads Factory workflows and skills straight from that
checkout). This script is the gate: HEAD must be a clean checkout, the automation catalog and the
full test suite must pass, and `stable` may only move forward (fast-forward). A failed gate changes
nothing. There is deliberately no switch to skip the tests.
#>
[CmdletBinding()]
param(
    [string]$FactoryPath = (Join-Path $PSScriptRoot '../..'),
    [string]$Remote = 'origin',
    [string]$Branch = 'stable',
    # Test hook: the script that must exit 0. Defaults to the repository's full suite.
    [string]$TestScript = '',
    [string]$ReportPath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path $FactoryPath).Path
if (-not $TestScript) { $TestScript = Join-Path $factory 'tests/run-tests.ps1' }
if (-not $ReportPath) { $ReportPath = Join-Path $factory '.factory/release-reports/promote-stable.jsonl' }

function Invoke-Git([string[]]$Arguments) {
    $output = & git -C $factory @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}
function Write-Report([string]$Status, [string]$Detail, [string]$Sha) {
    $record = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); status = $Status; sha = $Sha; branch = $Branch; detail = $Detail }
    $json = $record | ConvertTo-Json -Compress
    Write-Host "PROMOTE_STATUS $json"
    $parent = Split-Path -Parent $ReportPath
    if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
    Add-Content -LiteralPath $ReportPath -Value $json -Encoding utf8
}

$sha = ((Invoke-Git @('rev-parse', 'HEAD')) -join '').Trim()
$dirty = @(& git -C $factory status --porcelain --untracked-files=no 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'git status failed while checking the Factory working tree.' }
if ($dirty.Count) { Write-Report 'refused' 'Working tree has uncommitted tracked changes; commit them so the tested tree is the promoted commit.' $sha; exit 1 }

& pwsh -NoProfile -File (Join-Path $factory 'scripts/validate-automation-catalog.ps1')
if ($LASTEXITCODE -ne 0) { Write-Report 'failed' 'Automation catalog validation failed.' $sha; exit 1 }
& pwsh -NoProfile -File $TestScript
if ($LASTEXITCODE -ne 0) { Write-Report 'failed' 'Test suite failed; stable was not moved.' $sha; exit 1 }

& git -C $factory fetch --quiet $Remote $Branch 2>$null
if ($LASTEXITCODE -eq 0) {
    $remoteSha = ((Invoke-Git @('rev-parse', 'FETCH_HEAD')) -join '').Trim()
    & git -C $factory merge-base --is-ancestor $remoteSha $sha
    if ($LASTEXITCODE -ne 0) { Write-Report 'refused' "$Remote/$Branch ($remoteSha) is not an ancestor of HEAD; stable only moves forward. Merge or rebase first." $sha; exit 1 }
    if ($remoteSha -eq $sha) { Write-Report 'unchanged' "$Branch already at HEAD." $sha; exit 0 }
}
if ($DryRun) { Write-Report 'dry-run' "Tests passed; would push $sha to $Remote/$Branch." $sha; exit 0 }
Invoke-Git @('push', $Remote, "${sha}:refs/heads/$Branch") | Out-Null
Write-Report 'promoted' "Tests passed; $Remote/$Branch now at $sha." $sha
exit 0
