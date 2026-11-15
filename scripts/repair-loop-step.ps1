#!/usr/bin/env pwsh
# One round of the bounded triage/repair loop (issue #105). Run from a workflow command: step only.
# Reads the current impacted-check results, classifies, applies policies/retry.yaml bounds, records the round in
# the attempt ledger and writes the decision (concise context, impacted checks to rerun, handoff). Exit 0 always
# when it decided; non-zero only when it failed closed (unreadable policy, ledger or input).
[CmdletBinding()]
param(
    [string]$ChecksPath = '.factory/verification-checks.json',
    [string]$LedgerPath = '.factory/repair-ledger.json',
    [string]$PolicyPath = (Join-Path $PSScriptRoot '../policies/retry.yaml'),
    [string]$OutputPath = '.factory/repair-decision.json',
    [string]$HandoffPath = '.factory/repair-loop-handoff.json',
    [string]$HindsightPath = '',
    [double]$AttemptSeconds = 0
)
$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
. (Join-Path $PSScriptRoot 'repair-loop-lib.ps1')
$policy = Get-RepairPolicy $PolicyPath
if (-not (Test-Path -LiteralPath $ChecksPath)) { throw "Check results not found: $ChecksPath" }
$data = Get-Content -Raw -LiteralPath $ChecksPath | ConvertFrom-Json -Depth 10
$checks = if ($null -ne $data.checks) { @($data.checks) } else { @($data) }
$ledger = Read-RepairLedger $LedgerPath $policy
$decision = Invoke-RepairDecision -Checks $checks -Ledger $ledger -Policy $policy -AttemptSeconds $AttemptSeconds
# Hindsight recall (#55) is optional context; absence or damage never fails the loop.
$decision.hindsight = $null
if ($HindsightPath -and (Test-Path -LiteralPath $HindsightPath)) {
    try { $decision.hindsight = Get-Content -Raw -LiteralPath $HindsightPath | ConvertFrom-Json -Depth 6 } catch { $decision.hindsight = $null }
}
foreach ($p in $LedgerPath, $OutputPath, $HandoffPath) { New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($p))) -Force | Out-Null }
Set-Content -LiteralPath $LedgerPath -Value ($ledger | ConvertTo-Json -Depth 8)
Set-Content -LiteralPath $OutputPath -Value ($decision | ConvertTo-Json -Depth 8)
if (@($decision.handoff.findings).Count -gt 0) { Set-Content -LiteralPath $HandoffPath -Value ($decision.handoff | ConvertTo-Json -Depth 8) }
Write-Host "repair-loop: action=$($decision.action) impacted=$(@($decision.impactedChecks) -join ',') stop=$($decision.stopReason)"
