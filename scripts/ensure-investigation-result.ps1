#!/usr/bin/env pwsh
<#
.SYNOPSIS
Preserves a missing investigation handoff as a conservative, valid result after its retry.
.DESCRIPTION
The first missing result fails validation so the workflow can retry the investigator. If the
artifact is still absent when validation runs again, this writes an explicit unknown/low-confidence
result that routes the issue back to planning without inventing an investigation conclusion.
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
if (Test-Path -LiteralPath $Path -PathType Leaf) {
    & "$PSScriptRoot/validate-result.ps1" -Kind investigation -Path $Path
    $validationExit = $LASTEXITCODE
    if ($validationExit -eq 0) {
        Remove-Item -LiteralPath $retryStatePath -Force -ErrorAction SilentlyContinue
    } elseif (-not (Test-Path -LiteralPath $retryStatePath -PathType Leaf)) {
        @{ missingAttempts = 1 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $retryStatePath -Encoding utf8
    }
    exit $validationExit
}

$missingAttempts = 0
if (Test-Path -LiteralPath $retryStatePath -PathType Leaf) {
    try {
        $retryState = Get-Content -Raw -LiteralPath $retryStatePath | ConvertFrom-Json
        $missingAttempts = [int]$retryState.missingAttempts
    } catch {
        $missingAttempts = 0
    }
}

$directory = Split-Path -Parent $Path
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }

if ($missingAttempts -lt 1) {
    @{ missingAttempts = 1 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $retryStatePath -Encoding utf8
    '{"status":"invalid","kind":"investigation","errors":["investigation result file is missing; retrying the investigator once"]}'
    exit 1
}

$issueMatch = [regex]::Match($Task, '(?:GitHub\s+issue\s*#|/issues/|#)([1-9][0-9]*)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $issueMatch.Success) {
    throw 'The investigation task does not contain a positive GitHub issue number; cannot preserve the missing handoff.'
}
$issue = [int]$issueMatch.Groups[1].Value
$result = [ordered]@{
    issue = $issue
    failureClassification = 'unknown'
    evidence = 'The investigation step completed, but its required result artifact was still missing after the workflow retry.'
    attemptsReviewed = 'The investigator was retried once after the missing artifact was detected; no structured investigation evidence was available to review.'
    rootCauseHypothesis = 'Unknown: the investigation worker did not persist the required result artifact.'
    confidence = 'low'
    recommendedAction = 'Return the issue to planning automatically and require a validated handoff from the next worker. Inspect this run if the missing artifact recurs.'
    automaticRetryAppropriate = $false
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
Remove-Item -LiteralPath $retryStatePath -Force -ErrorAction SilentlyContinue
& "$PSScriptRoot/validate-result.ps1" -Kind investigation -Path $Path
exit $LASTEXITCODE
