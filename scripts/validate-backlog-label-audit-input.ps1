#!/usr/bin/env pwsh
<##
.SYNOPSIS
Validates the bounded backlog-label audit handoff before the model step.

This is intentionally a fail-fast workflow guard. A missing, malformed, stale,
or over-sized input artifact must stop the workflow; the audit skill must not
try to diagnose the runtime or rediscover issues.
##>
[CmdletBinding()]
param(
    [string]$Path = '.factory/backlog-label-audit-input.json',
    [ValidateRange(1, 100)][int]$MaxCandidates = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$fullPath = [IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Backlog audit handoff is missing: $fullPath. Stop before the audit skill; do not retry or rediscover issues."
}

try {
    $input = Get-Content -Raw -LiteralPath $fullPath | ConvertFrom-Json
} catch {
    throw "Backlog audit handoff is not valid JSON: $fullPath. Stop before the audit skill. $($_.Exception.Message)"
}

if (-not $input.PSObject.Properties.Name -contains 'outputPath') {
    throw "Backlog audit handoff is missing outputPath: $fullPath. Stop before the audit skill."
}
$reportedPath = [IO.Path]::GetFullPath([string]$input.outputPath)
if ($reportedPath -ne $fullPath) {
    throw "Backlog audit handoff points outside this run: reported '$reportedPath', expected '$fullPath'. Stop before the audit skill."
}

$candidates = @($input.candidates)
if ($candidates.Count -gt $MaxCandidates) {
    throw "Backlog audit handoff contains $($candidates.Count) candidates; maximum is $MaxCandidates. Stop before the audit skill."
}
foreach ($candidate in $candidates) {
    if (-not $candidate.PSObject.Properties.Name -contains 'number' -or
        [int]$candidate.number -lt 1 -or
        -not $candidate.PSObject.Properties.Name -contains 'body') {
        throw "Backlog audit handoff contains a candidate without positive number/body. Stop before the audit skill."
    }
}

Write-Output (@{
    status = 'valid'
    path = $fullPath
    candidates = $candidates.Count
    terminalReason = [string]$input.terminalReason
} | ConvertTo-Json -Compress)
