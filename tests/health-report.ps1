#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) "health-report-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$script:failures = 0
function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ }
}
function Report([hashtable]$Extra = @{}) {
    $arguments = @{ FailureInputPath = (Join-Path $temp 'in.json'); PublicationPath = (Join-Path $temp 'pub.json'); BacklogPath = (Join-Path $temp 'backlog.json'); OutputPath = (Join-Path $temp 'out/health-report.json') } + $Extra
    $text = & (Join-Path $factory 'scripts/write-health-report.ps1') @arguments | Out-String
    [pscustomobject]@{ text = $text; report = (Get-Content -LiteralPath $arguments.OutputPath -Raw | ConvertFrom-Json) }
}
try {
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    @{ schemaVersion = 1; status = 'ready'; projectId = 'p1'; windowHours = 24; runsInspected = 3; limitations = @()
       failures = @(@{ runId = 'a'; classification = 'factory-defect' }, @{ runId = 'b'; classification = 'environment' }, @{ runId = 'c' }) } | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $temp 'in.json')
    @{ status = 'published'; action = 'created'; issueNumber = 7; message = 'ok' } | ConvertTo-Json | Set-Content (Join-Path $temp 'pub.json')
    @{ candidates = @(); invalid = @() } | ConvertTo-Json | Set-Content (Join-Path $temp 'backlog.json')
    $r = Report
    Check 'report counts classifications; unclassified legacy rows count as factory-defect' ($r.report.failures.classifications.'factory-defect' -eq 2 -and $r.report.failures.classifications.environment -eq 1)
    Check 'report carries publication and backlog state' ($r.report.failures.publication.issueNumber -eq 7 -and $r.report.backlog.reconciliationStatus -eq 'ready' -and (Test-Path (Join-Path $temp 'out/health-report.md')))
    Remove-Item (Join-Path $temp 'backlog.json'), (Join-Path $temp 'pub.json')
    $r = Report
    Check 'missing inputs become limitations, not failures' ($r.report.backlog.reconciliationStatus -eq 'missing' -and (@($r.report.limitations) -join ' ') -match 'backlog reconciliation artifact is missing' -and $r.report.failures.publication.status -eq 'missing')
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($script:failures) { exit 1 }
