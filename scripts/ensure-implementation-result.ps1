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
    [string]$ContextPath = '.factory/implementation-context.json'
)

$ErrorActionPreference = 'Stop'

if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Write-Output (@{ status = 'present'; path = $Path } | ConvertTo-Json -Compress)
    exit 0
}

if (-not (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
    throw "Neither implementation result nor prepared context was found: $Path; $ContextPath"
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
    summary = 'The implementation step completed without writing .factory/implement-result.json.'
    filesChanged = @()
    testsRun = @()
    testResult = 'not-run'
    acceptanceCriteriaStatus = 'Not met'
    documentationUpdated = $false
    knownConcerns = 'The implementation worker did not provide its required structured handoff; inspect the workflow run and retry through investigation.'
    followUpSuggestions = 'Retry implementation after reviewing the worker handoff failure.'
    durableKnowledgeCandidates = 'Implementation result artifacts are required before workflow verification can proceed.'
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
Write-Output (@{ status = 'created-failure'; issue = $issue; path = $Path } | ConvertTo-Json -Compress)
