#!/usr/bin/env pwsh
<#
.SYNOPSIS
Scoped selection for the verify workflow: impacted checks plus policy-mandatory checks.
.DESCRIPTION
Impact selection is the existing changed-test selection (scripts/lib.ps1 Get-ChangedValidationSelection over
.ai/factory/test-ownership.json). Mandatory checks come only from the policy file. Writes the selection record
that verification-invoke.ps1 runs and verification-evaluate.ps1 judges.
#>
[CmdletBinding()]
param(
    [string]$Root = '.',
    [string]$PolicyPath = '',
    [string]$OutputPath = '.factory/verification/selection.json',
    [string]$Task = ''
)
$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
. (Join-Path $PSScriptRoot 'verification-lib.ps1')
if (-not $PolicyPath) { $PolicyPath = Join-Path $PSScriptRoot '../policies/verification.json' }
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$policy = Read-VerificationPolicy $PolicyPath
$config = Read-FactoryConfig (Join-Path $rootPath '.ai/factory/factory.config.yaml')
$impact = Get-ChangedValidationSelection $rootPath $config
if (-not $impact) { throw 'No changed-test ownership map; verification cannot select checks.' }
$owned = Read-OwnershipChecks $rootPath
$selected = [System.Collections.Generic.List[object]]::new()
foreach ($check in $impact.checks) {
    $reason = if ($policy.mandatoryChecks -contains $check.id) { 'impact+mandatory' } else { 'impact' }
    $selected.Add([ordered]@{ id = [string]$check.id; command = [string]$check.command; reason = $reason; paths = @($check.paths) })
}
foreach ($id in @($policy.mandatoryChecks | ForEach-Object { [string]$_ })) {
    if (-not $owned.ContainsKey($id)) { throw "Mandatory check '$id' from the policy is not defined in the ownership map." }
    if (-not @($selected | Where-Object { $_.id -eq $id }).Count) {
        $selected.Add([ordered]@{ id = $id; command = $owned[$id]; reason = 'mandatory'; paths = @() })
    }
}
$head = ((& git -C $rootPath rev-parse HEAD 2>$null) -join '').Trim()
$record = [ordered]@{
    schemaVersion = 1; headSha = $head; baseCommit = [string]$impact.baseCommit
    changedPaths = @($impact.changedPaths); unmappedPaths = @($impact.unmappedPaths)
    policy = [ordered]@{ path = 'policies/verification.json'; sha256 = (Get-VerificationFileHash $PolicyPath) }
    selected = @($selected)
}
Write-VerificationJson $record $OutputPath
Write-Output (ConvertTo-Json -InputObject ([ordered]@{ status = 'selected'; checks = @($selected | ForEach-Object { $_.id }) }) -Compress)
