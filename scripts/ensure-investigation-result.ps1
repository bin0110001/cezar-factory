#!/usr/bin/env pwsh
<#
.SYNOPSIS
Preserves a missing or invalid investigation handoff as a conservative result after its retry.
.DESCRIPTION
The first missing or invalid result fails validation so the workflow can retry the investigator.
If the result is still missing or invalid when validation runs again, this writes an explicit
unknown/low-confidence result that routes the issue back to planning without inventing a conclusion.
#>
[CmdletBinding()]
param(
    [string]$Path = '.factory/investigate-result.json',
    [Parameter(Mandatory)][string]$Task
)

$ErrorActionPreference = 'Stop'

# Already-resolved issue (see check-already-resolved.ps1): nothing to do.
if (Test-Path -LiteralPath '.factory/already-resolved.json' -PathType Leaf) {
    '{"status":"skipped","reason":"already-resolved"}'
    exit 0
}

$retryStatePath = "$Path.validation-attempt.json"

function Read-MissingAttempts {
    if (-not (Test-Path -LiteralPath $retryStatePath -PathType Leaf)) { return 0 }
    try { return [int](Get-Content -Raw -LiteralPath $retryStatePath | ConvertFrom-Json).missingAttempts }
    catch { return 0 }
}

function Write-ConservativeFallback([string]$Reason) {
    $issueMatch = [regex]::Match($Task, '(?:GitHub\s+issue\s*#|/issues/|#)([1-9][0-9]*)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $issueMatch.Success) {
        throw 'The investigation task does not contain a positive GitHub issue number; cannot preserve the handoff.'
    }
    $directory = Split-Path -Parent $Path
    if ($directory) { New-Item -ItemType Directory -Force $directory | Out-Null }
    $result = [ordered]@{
        issue = [int]$issueMatch.Groups[1].Value
        failureClassification = 'unknown'
        evidence = "The investigation worker did not produce a valid structured result after its bounded retry: $Reason"
        attemptsReviewed = 'The investigator was retried once after its result was missing or invalid; no validated investigation evidence was available.'
        rootCauseHypothesis = 'Unknown: the investigation worker did not persist a valid result artifact.'
        confidence = 'low'
        recommendedAction = 'Return the issue to planning automatically. Inspect this run if a missing or invalid handoff recurs.'
        automaticRetryAppropriate = $false
    }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
    Remove-Item -LiteralPath $retryStatePath -Force -ErrorAction SilentlyContinue
    & "$PSScriptRoot/validate-result.ps1" -Kind investigation -Path $Path
    exit $LASTEXITCODE
}

if (Test-Path -LiteralPath $Path -PathType Leaf) {
    & "$PSScriptRoot/validate-result.ps1" -Kind investigation -Path $Path
    $validationExit = $LASTEXITCODE
    if ($validationExit -eq 0) {
        Remove-Item -LiteralPath $retryStatePath -Force -ErrorAction SilentlyContinue
        exit 0
    }
    if ((Read-MissingAttempts) -lt 1) {
        @{ missingAttempts = 1 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $retryStatePath -Encoding utf8
        '{"status":"invalid","kind":"investigation","errors":["investigation result is invalid; retrying the investigator once"]}'
        exit 1
    }
    Write-ConservativeFallback 'the result artifact remained invalid after retry'
}

if ((Read-MissingAttempts) -lt 1) {
    $directory = Split-Path -Parent $Path
    if ($directory) { New-Item -ItemType Directory -Force $directory | Out-Null }
    @{ missingAttempts = 1 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $retryStatePath -Encoding utf8
    '{"status":"invalid","kind":"investigation","errors":["investigation result file is missing; retrying the investigator once"]}'
    exit 1
}

Write-ConservativeFallback 'the result artifact was still missing after retry'
