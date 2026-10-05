[CmdletBinding()]
param([Parameter(Mandatory)][string]$TaskClass, [string]$LedgerPath = '.factory/evaluations/local-shadow.jsonl', [string]$CatalogPath = (Join-Path $PSScriptRoot '..\routing\automation-catalog.json'), [string]$OutputPath = '.factory/evaluations/promotion-report.json')
$ErrorActionPreference = 'Stop'
$catalog = Get-Content -Raw $CatalogPath | ConvertFrom-Json
$job = @($catalog.jobs | Where-Object { $_.id -eq $TaskClass -and $_.tier -eq 'local' }); if ($job.Count -ne 1) { throw "'$TaskClass' is not a cataloged local task class." }
$gate = $job[0].promotion; if (-not $gate) { throw "'$TaskClass' has no predeclared promotion gate." }
$records = if (Test-Path $LedgerPath) { @(Get-Content $LedgerPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.taskClass -eq $TaskClass }) } else { @() }
$count = $records.Count; $schemaRate = if ($count) { (@($records | Where-Object schemaValid).Count / $count) } else { 0 }; $successRate = if ($count) { (@($records | Where-Object { $_.schemaValid -and $_.validationPassed }).Count / $count) } else { 0 }; $safetyFailures = @($records | Where-Object { $_.risk -eq 'high' -and $_.validationPassed }).Count
$result = [ordered]@{ taskClass=$TaskClass; sampleSize=$count; requiredSampleSize=[int]$gate.sampleSize; schemaValidRate=$schemaRate; requiredSchemaValidRate=[double]$gate.schemaValidRate; verifiedSuccessRate=$successRate; requiredVerifiedSuccessRate=[double]$gate.verifiedSuccessRate; unacceptableSafetyFailures=$safetyFailures; eligibleForAdvisory=($count -ge $gate.sampleSize -and $schemaRate -ge $gate.schemaValidRate -and $successRate -ge $gate.verifiedSuccessRate -and $safetyFailures -eq 0); decision='advisory-promotion-requires-reviewed-policy-change' }
$parent = Split-Path -Parent $OutputPath; if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }; $result | ConvertTo-Json | Set-Content -NoNewline $OutputPath; $result | ConvertTo-Json
