#!/usr/bin/env pwsh
<#
.SYNOPSIS
Policy evaluation for the verify workflow: derives the verdict and appends it to the verification ledger.
.DESCRIPTION
The verdict is `pass` only when every policy-mandatory check ran and passed and every selected check passed.
Mandatory ids are re-read from the policy here, so a selection that dropped one cannot pass. The verdict is
appended as a hash-chained JSON line to the ledger and written to the result file; a `fail` exits non-zero.
#>
[CmdletBinding()]
param(
    [string]$SelectionPath = '.factory/verification/selection.json',
    [string]$ResultsPath = '.factory/verification/results.json',
    [string]$OutputPath = '.factory/verification/verdict.json',
    [string]$PolicyPath = '',
    [string]$LedgerPath = '',
    [string]$Task = ''
)
$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
. (Join-Path $PSScriptRoot 'verification-lib.ps1')
if (-not $PolicyPath) { $PolicyPath = Join-Path $PSScriptRoot '../policies/verification.json' }
$policy = Read-VerificationPolicy $PolicyPath
if (-not $LedgerPath) { $LedgerPath = if ($policy.ContainsKey('ledger')) { [string]$policy.ledger } else { '.factory/ledger/verification-verdicts.jsonl' } }
$selection = Read-VerificationJson $SelectionPath 'Verification selection'
$run = Read-VerificationJson $ResultsPath 'Verification results'
$byId = @{}
foreach ($r in @($run.results)) { $byId[[string]$r.id] = $r }
$reasons = [System.Collections.Generic.List[string]]::new()
foreach ($id in @($policy.mandatoryChecks | ForEach-Object { [string]$_ })) {
    if (-not $byId.ContainsKey($id)) { $reasons.Add("mandatory check '$id' did not run") }
}
foreach ($check in @($selection.selected)) {
    if (-not $byId.ContainsKey([string]$check.id)) { $reasons.Add("selected check '$($check.id)' has no result") }
}
foreach ($id in ($byId.Keys | Sort-Object)) {
    if ($byId[$id].status -ne 'passed') { $reasons.Add("check '$id' $($byId[$id].status) (exit $($byId[$id].exitCode))") }
}
$issue = 0
if ($Task -match '(?:issues/|#)?([1-9][0-9]*)$') { $issue = [int]$Matches[1] }
$verdict = [ordered]@{
    schemaVersion = 1; verdict = $(if ($reasons.Count) { 'fail' } else { 'pass' }); issue = $issue
    headSha = [string]$selection.headSha; baseCommit = [string]$selection.baseCommit
    policySha256 = [string]$selection.policy.sha256
    mandatoryChecks = @($policy.mandatoryChecks | ForEach-Object { [string]$_ })
    checks = @($byId.Keys | Sort-Object | ForEach-Object { [ordered]@{ id = $_; status = $byId[$_].status; exitCode = $byId[$_].exitCode } })
    reasons = @($reasons); recordedAt = (Get-Date).ToUniversalTime().ToString('o')
}
# Append-only, hash-chained: each entry carries the digest of the previous line.
$previous = ''
if (Test-Path -LiteralPath $LedgerPath -PathType Leaf) {
    $last = @(Get-Content -LiteralPath $LedgerPath | Where-Object { $_.Trim() }) | Select-Object -Last 1
    if ($last) { $previous = (Get-TextHash ([string]$last)) }
}
$verdict.previousDigest = $previous
$parent = Split-Path -Parent $LedgerPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
Add-Content -LiteralPath $LedgerPath -Value (ConvertTo-Json -InputObject $verdict -Depth 8 -Compress) -Encoding utf8
$verdict.ledgerPath = $LedgerPath
Write-VerificationJson $verdict $OutputPath
Write-Output (ConvertTo-Json -InputObject ([ordered]@{ status = $verdict.verdict; reasons = @($reasons) }) -Compress)
if ($reasons.Count) { exit 1 }
