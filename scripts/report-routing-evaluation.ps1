<#
.SYNOPSIS
  Model/tier comparison report over the routing dataset (#137). Read-only; changes no routing.
.DESCRIPTION
  Per model and per tier: runs, attempts, retries, accepted and merged changes, duration, accepted-change throughput
  and retry-inclusive effective cost per accepted change (total known cost of every attempt / accepted changes).
  If any run in a group lacks cost, that group's cost is 'unknown': unknown is never treated as zero.
  Groups under -MinSample runs are flagged low-sample.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DatasetPath,
    [Parameter(Mandatory)][string]$OutPath,
    [int]$MinSample = 5
)
$ErrorActionPreference = 'Stop'
$unknown = 'unknown'
$ds = Get-Content -Raw -LiteralPath $DatasetPath | ConvertFrom-Json
if ($ds.schemaVersion -ne 1) { throw "Unsupported dataset schemaVersion '$($ds.schemaVersion)'." }
$records = @($ds.records)

function Sum-Known($Items, [string]$Field) {
    $vals = @($Items | ForEach-Object { $_.$Field })
    if ($vals.Count -eq 0 -or @($vals | Where-Object { $_ -is [string] }).Count -gt 0) { return $unknown }
    [math]::Round(($vals | Measure-Object -Sum).Sum, 6)
}
function Summarize($Items, [string]$Key, [string]$Value) {
    $items = @($Items)
    $attempts = Sum-Known $items 'attempts'
    $accepted = @($items | Where-Object { $_.accepted -eq $true }).Count
    $merged = @($items | Where-Object { $_.merged -eq $true }).Count
    $cost = Sum-Known $items 'costUsd'
    $duration = Sum-Known $items 'durationSeconds'
    [ordered]@{
        $Key                       = $Value
        runs                       = $items.Count
        attempts                   = $attempts
        retries                    = if ($attempts -is [string]) { $unknown } else { [int64]$attempts - $items.Count }
        acceptedChanges            = $accepted
        mergedChanges              = $merged
        totalDurationSeconds       = $duration
        acceptedPerRun             = if ($items.Count) { [math]::Round($accepted / $items.Count, 4) } else { $unknown }
        totalCostUsd               = $cost
        effectiveCostPerAccepted   = if ($cost -is [string] -or $accepted -eq 0) { $unknown } else { [math]::Round($cost / $accepted, 6) }
        lowSample                  = ($items.Count -lt $MinSample)
    }
}
function Group-Report([string]$Field, [string]$Key) {
    @($records | Group-Object -Property $Field -CaseSensitive | Sort-Object Name -CaseSensitive | ForEach-Object { Summarize $_.Group $Key $_.Name })
}
$report = [ordered]@{
    schemaVersion = 1
    datasetRecords = $records.Count
    minSample = $MinSample
    note = 'Read-only evidence. Unknown telemetry stays unknown; no subscription cost or quota is estimated. Compare tiers (#92) and capacity (#89-#93) with this; it does not change live routing.'
    byModel = Group-Report 'model' 'model'
    byTier = Group-Report 'tier' 'tier'
    byCapacityAlias = Group-Report 'subscriptionAlias' 'subscriptionAlias'
}
$json = ($report | ConvertTo-Json -Depth 6) -replace "`r`n", "`n"
$parent = Split-Path -Parent $OutPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[IO.File]::WriteAllText($OutPath, $json + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Wrote report for $($records.Count) record(s) to $OutPath"
