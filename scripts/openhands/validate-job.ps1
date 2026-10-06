#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('request','result')][string]$Kind,
    [Parameter(Mandatory)][string]$Path
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Path)) { throw "OpenHands $Kind file not found: $Path" }
$v = Get-Content -Raw $Path | ConvertFrom-Json
$required = if ($Kind -eq 'request') { 'provider','agent','project','issue','task','branch','validation','risk' } else { 'provider','agent','status','issue','branch','attempts','validationPassed' }
foreach ($name in $required) {
    if (-not $v.PSObject.Properties.Name -contains $name -or $null -eq $v.$name -or "$($v.$name)" -eq '') { throw "OpenHands $Kind missing '$name'" }
}
if ($v.provider -ne 'openhands') { throw "OpenHands $Kind provider must be openhands" }
if ([int]$v.issue -lt 1) { throw 'issue must be positive' }
if ($Kind -eq 'result' -and $v.status -eq 'success' -and -not $v.validationPassed) { throw 'successful OpenHands result must pass validation' }
Write-Output (@{ status = 'valid'; kind = $Kind; issue = [int]$v.issue } | ConvertTo-Json -Compress)
