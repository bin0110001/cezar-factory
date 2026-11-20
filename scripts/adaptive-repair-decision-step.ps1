#!/usr/bin/env pwsh
# Applies the existing bounded repair policy and emits Cezar's safe decision contract.
[CmdletBinding()]
param(
    [string]$ChecksPath = '.factory/verification-checks.json',
    [string]$ProgressPath = '.factory/progress-evaluation.json',
    [string]$PolicyDecisionPath = '.factory/repair-policy-decision.json',
    [string]$OutputPath = '.factory/adaptive-repair-decision.json',
    [string]$LedgerPath = '.factory/adaptive-repair-ledger.json'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $PolicyDecisionPath -PathType Leaf)) { throw "Bounded repair policy decision not found: $PolicyDecisionPath" }
$policy = Get-Content -Raw -LiteralPath $PolicyDecisionPath | ConvertFrom-Json -Depth 20
$progress = Get-Content -Raw -LiteralPath $ProgressPath | ConvertFrom-Json -Depth 20
$checks = Get-Content -Raw -LiteralPath $ChecksPath | ConvertFrom-Json -Depth 20
$allPassed = @($checks.requiredCheckIds).Count -gt 0 -and @($checks.requiredCheckIds | Where-Object {
    $id = $_; -not (@($checks.receipts | Where-Object { $_.checkId -eq $id -and $_.status -eq 'pass' }).Count)
}).Count -eq 0
$action = if ($checks.artifactChangedDuringValidation) { 'rerun-full-matrix' }
    elseif ($allPassed) { 'done' }
    elseif ($policy.action -in 'repair','replan') { $policy.action }
    elseif ($policy.action -eq 'retry') { 'rerun-full-matrix' }
    elseif ($policy.action -eq 'rerun-full-matrix') { 'rerun-full-matrix' }
    elseif ($progress.classification -in 'regression','oscillation') { 'stop' }
    else { 'handoff' }
$feedback = @($checks.receipts | Where-Object { $_.status -ne 'pass' } | ForEach-Object {
    [ordered]@{ checkId = [string]$_.checkId; category = [string]$_.category; disposition = [string]$_.status; message = ([string]$_.message + ' ' + [string]$_.output).Trim() }
})
$decision = [ordered]@{ schemaVersion = 1; action = $action; reasonCode = [string]$policy.reasonCode; stopReason = [string]$policy.stopReason; feedback = $feedback; summary = @{ entries = @() }; progress = $progress }
New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))) -Force | Out-Null
Set-Content -LiteralPath $OutputPath -Value ($decision | ConvertTo-Json -Depth 20) -Encoding utf8
Write-Output "adaptive-decision: action=$action progress=$($progress.classification)"
