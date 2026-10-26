#!/usr/bin/env pwsh
<##
.SYNOPSIS
Ensures the implementation step leaves a result artifact for later workflow steps.

If the model did not write one, preserve the failure as a valid structured result
so the workflow can route the issue to investigation instead of terminating on a
missing ignored file.
##>
[CmdletBinding()]
param(
    [string]$Path = '.factory/implement-result.json',
    [string]$ContextPath = '.factory/implementation-context.json',
    [switch]$FinalizationRecovery
)

$ErrorActionPreference = 'Stop'

if (-not $FinalizationRecovery -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Output (@{ status = 'present'; path = $Path } | ConvertTo-Json -Compress)
    exit 0
}

$contractFailure = $null
if ($FinalizationRecovery) {
    try {
        if ([string]::IsNullOrWhiteSpace($env:CEZAR_INPUT_JSON)) { throw 'finalizer input is missing' }
        $inputObject = $env:CEZAR_INPUT_JSON | ConvertFrom-Json -AsHashtable -Depth 40
        $finalization = $inputObject.finalization
        $outcome = $finalization.outcome
        if ($finalization.terminal -ne 'failed' -or $outcome.kind -ne 'contract_failure' -or $outcome.stepId -ne 'implement') {
            Write-Output (@{ status = 'skipped'; reason = 'not-implementation-contract-failure' } | ConvertTo-Json -Compress)
            exit 0
        }
        $contractFailure = [string]$outcome.reasonCode
    } catch {
        throw "Cannot classify implementation finalizer recovery: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
    throw "Neither implementation result nor prepared context was found: $Path; $ContextPath"
}

if ($FinalizationRecovery -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
    try { $existing = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
    catch { $existing = $null }
    if ($existing.status -eq 'failure' -and $existing.summary -eq 'Cezar rejected the implementation result contract before a validated handoff was available.') {
        Write-Output (@{ status = 'present'; path = $Path; recovery = 'already-recorded' } | ConvertTo-Json -Compress)
        exit 0
    }
}

$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$issue = 0
if ($context.issue -and $context.issue.number) { $issue = [int]$context.issue.number }
if ($issue -lt 1) { throw "Prepared implementation context does not contain a positive issue number: $ContextPath" }

$directory = Split-Path -Parent $Path
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result = [ordered]@{
    issue = $issue
    status = 'failure'
    summary = if ($FinalizationRecovery) { 'Cezar rejected the implementation result contract before a validated handoff was available.' } else { 'The implementation step completed without writing .factory/implement-result.json.' }
    filesChanged = @()
    testsRun = @()
    testResult = 'not-run'
    acceptanceCriteriaStatus = 'Not met'
    documentationUpdated = $false
    knownConcerns = if ($FinalizationRecovery) { "The implementation output failed Cezar contract validation ($contractFailure); inspect the recorded terminal reason before retrying through investigation." } else { 'The implementation worker did not provide its required structured handoff; inspect the workflow run and retry through investigation.' }
    followUpSuggestions = 'Retry implementation after reviewing the worker handoff failure.'
    durableKnowledgeCandidates = 'Implementation result artifacts are required before workflow verification can proceed.'
}
$directory = Split-Path -Parent $Path
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$temp = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding utf8
    Move-Item -LiteralPath $temp -Destination $Path -Force
} finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
Write-Output (@{ status = 'created-failure'; issue = $issue; path = $Path; reason = $contractFailure } | ConvertTo-Json -Compress)
