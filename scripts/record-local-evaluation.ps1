[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [string]$CatalogPath = (Join-Path $PSScriptRoot '..\routing\automation-catalog.json'),
    [string]$LedgerPath = '.factory/evaluations/local-shadow.jsonl'
)

$ErrorActionPreference = 'Stop'
$record = Get-Content -Raw $InputPath | ConvertFrom-Json
$required = 'taskClass','difficulty','risk','contextChars','worker','model','schemaValid','validationPassed','retries','durationSeconds','premiumFallback'
foreach ($field in $required) { if ($null -eq $record.$field) { throw "Evaluation is missing '$field'." } }
if ($record.PSObject.Properties.Name -contains 'prompt') { throw 'Prompts must not be stored in local-evaluation records.' }
if ($record.contextChars -lt 0 -or $record.contextChars -gt 12000) { throw 'contextChars must be between zero and 12,000.' }
if ($record.retries -lt 0 -or $record.retries -gt 3) { throw 'retries must be between zero and three.' }
$catalog = Get-Content -Raw $CatalogPath | ConvertFrom-Json
$job = @($catalog.jobs | Where-Object { $_.id -eq $record.taskClass -and $_.tier -eq 'local' })
if ($job.Count -ne 1) { throw "'$($record.taskClass)' is not a cataloged local task class." }
if ($record.contextChars -gt $job[0].maxContextChars) { throw 'Evaluation exceeds the catalog context cap.' }
$safe = [ordered]@{ recordedAt = [DateTimeOffset]::UtcNow.ToString('o'); taskClass = $record.taskClass; difficulty = $record.difficulty; risk = $record.risk; contextChars = $record.contextChars; worker = $record.worker; model = $record.model; schemaValid = [bool]$record.schemaValid; validationPassed = [bool]$record.validationPassed; correctionReason = if ($record.correctionReason) { ([string]$record.correctionReason).Substring(0, [Math]::Min(500, ([string]$record.correctionReason).Length)) } else { '' }; retries = [int]$record.retries; durationSeconds = [double]$record.durationSeconds; tokenEstimate = if ($null -ne $record.tokenEstimate) { [int]$record.tokenEstimate } else { 0 }; premiumFallback = [bool]$record.premiumFallback; humanReviewOutcome = if ($record.humanReviewOutcome) { $record.humanReviewOutcome } else { 'not-required' } }
$parent = Split-Path -Parent $LedgerPath; if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
Add-Content -Path $LedgerPath -Value ($safe | ConvertTo-Json -Compress)
$safe | ConvertTo-Json -Depth 4
