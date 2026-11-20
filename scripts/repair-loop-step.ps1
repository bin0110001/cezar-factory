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
    [string]$ReceiptsPath = '',
    [string]$ProgressPath = '',
    [string]$RepairPolicyPath = (Join-Path $PSScriptRoot '../policies/repair-policy.json'),
    [string]$Workflow = '',
    [string]$Validator = '',
    [string]$IdempotencyKey = '',
    [ValidateSet('session','worker')][string]$ActorKind = 'session',
    [ValidateSet('validate','repair','takeover')][string]$RequestedAction = 'repair',
    [double]$AttemptSeconds = 0,
    [double]$AttemptTokens = 0,
    [double]$AttemptCostUsd = 0,
    [switch]$SessionUnavailable
)
$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
. (Join-Path $PSScriptRoot 'repair-loop-lib.ps1')
$policy = Get-RepairPolicy $PolicyPath
$matrix = $null
$data = $null
if ($ReceiptsPath) {
    # Standardized check-provider receipts: {receipts:[...], requiredCheckIds:[...], revision, matrix:[...]}; the legacy input stays supported.
    if (-not (Test-Path -LiteralPath $ReceiptsPath)) { throw "Check receipts not found: $ReceiptsPath" }
    $rec = Get-Content -Raw -LiteralPath $ReceiptsPath | ConvertFrom-Json -Depth 10
    $data = $rec
    $checks = @(@($rec.receipts) | ForEach-Object { ConvertFrom-CheckProviderReceipt $_ })
    # Always provide a matrix in receipt mode. Missing mandatory IDs must stay unverified, never be interpreted as a pass.
    $matrix = [pscustomobject]@{ revision = [string]$rec.revision; requiredCheckIds = @($rec.requiredCheckIds); results = @($rec.matrix) }
} else {
    if (-not (Test-Path -LiteralPath $ChecksPath)) { throw "Check results not found: $ChecksPath" }
    $data = Get-Content -Raw -LiteralPath $ChecksPath | ConvertFrom-Json -Depth 10
    $checks = if ($null -ne $data.checks) { @($data.checks) } else { @($data) }
}
$effective = Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath $RepairPolicyPath -Workflow $Workflow -Validator $Validator
$progress = if ($ProgressPath) {
    if (-not (Test-Path -LiteralPath $ProgressPath)) { throw "Progress evaluation not found: $ProgressPath" }
    Get-Content -Raw -LiteralPath $ProgressPath | ConvertFrom-Json -Depth 10
} elseif ($data.PSObject.Properties['progress']) { $data.progress } else { $null }
if ($null -ne $progress -and $progress.PSObject.Properties['classification']) {
    $outcome = switch ([string]$progress.classification) {
        { $_ -in 'resolved','net_progress','mixed_progress','partial_progress' } { 'progress'; break }
        { $_ -in 'stagnation','regression','oscillation' } { 'no_progress'; break }
        default { 'unknown' }
    }
    $progress = [pscustomobject]@{ outcome = $outcome; relevantChange = [bool]$progress.artifactChanged }
}
$authorization = Test-RepairSessionAction $null $ActorKind $RequestedAction
if (-not $authorization.allowed) { throw $authorization.reason }
foreach ($p in $LedgerPath, $OutputPath, $HandoffPath) { New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($p))) -Force | Out-Null }
# Read, decide and write under one lock so concurrent evaluations cannot overspend the budget.
$decision = Use-RepairLock $LedgerPath {
    $ledger = Read-RepairLedger $LedgerPath $policy
    $d = Invoke-RepairDecision -Checks $checks -Ledger $ledger -Policy $policy -AttemptSeconds $AttemptSeconds -Effective $effective -Progress $progress -IdempotencyKey $IdempotencyKey -AttemptTokens $AttemptTokens -AttemptCostUsd $AttemptCostUsd -SessionAvailable (-not $SessionUnavailable) -Matrix $matrix
    Write-RepairLedger $LedgerPath $ledger
    $d
}
# Hindsight recall (#55) is optional context; absence or damage never fails the loop.
$decision.hindsight = $null
if ($HindsightPath -and (Test-Path -LiteralPath $HindsightPath)) {
    try { $decision.hindsight = Get-Content -Raw -LiteralPath $HindsightPath | ConvertFrom-Json -Depth 6 } catch { $decision.hindsight = $null }
}
Set-Content -LiteralPath $OutputPath -Value ($decision | ConvertTo-Json -Depth 12)
if (@($decision.handoff.findings).Count -gt 0) { Set-Content -LiteralPath $HandoffPath -Value ($decision.handoff | ConvertTo-Json -Depth 8) }
Write-Host "repair-loop: action=$($decision.action) impacted=$(@($decision.impactedChecks) -join ',') stop=$($decision.stopReason) reason=$($decision.reasonCode)"
