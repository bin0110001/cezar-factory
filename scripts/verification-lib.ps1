# Shared helpers for the verify workflow's command steps (select, invoke, evaluate). Dot-source this file.
# It consumes the changed-test ownership map and selection (.ai/factory/test-ownership.json, scripts/lib.ps1
# Get-ChangedValidationSelection) and the policy (policies/verification.json); it implements neither.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib.ps1')

function Read-VerificationPolicy([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Verification policy not found: $Path" }
    $policy = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    if ($policy.schemaVersion -ne 1) { throw "Unsupported verification policy schemaVersion in $Path." }
    if (-not ($policy.mandatoryChecks -is [array])) { throw "Verification policy $Path requires a mandatoryChecks array." }
    if (-not $policy.ContainsKey('checkTimeoutSeconds')) { $policy.checkTimeoutSeconds = 1200 }
    $policy
}

function Read-OwnershipChecks([string]$Root) {
    $mapPath = Join-Path $Root '.ai/factory/test-ownership.json'
    if (-not (Test-Path -LiteralPath $mapPath -PathType Leaf)) { throw "Changed-test ownership map not found: $mapPath" }
    $map = Get-Content -Raw -LiteralPath $mapPath | ConvertFrom-Json -AsHashtable
    $byId = @{}
    foreach ($check in @($map.checks)) { $byId[[string]$check.id] = [string]$check.command }
    $byId
}

function Get-VerificationFileHash([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-VerificationJson($Value, [string]$Path) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -LiteralPath $Path -Value (ConvertTo-Json -InputObject $Value -Depth 12) -Encoding utf8
}

function Read-VerificationJson([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$What not found: $Path" }
    Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
}
