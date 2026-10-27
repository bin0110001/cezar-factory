#!/usr/bin/env pwsh
<#
.SYNOPSIS
Cancel only positively identified Factory issue runs with explicit expired liveness evidence.
.DESCRIPTION
The current Cezar run record does not expose the lease, heartbeat, progress, runner-state,
and deadline fields needed to prove a stall. Such runs are recorded as skipped. Elapsed
wall-clock time alone is never sufficient to cancel a run.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ApiUrl,
    [Parameter(Mandatory)][string]$ProjectId,
    [ValidateRange(5, 10080)][int]$MaxRunMinutes = 15,
    [ValidateRange(1, 10080)][int]$MaxIdleMinutes = 15,
    [switch]$DryRun,
    [string]$OutputPath = '.factory/watchdog-report.json',
    [string]$RunsFixturePath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$factoryWorkflows = @(
    'factory-environment-analysis', 'factory-failure-audit', 'factory-fix-review',
    'factory-godot-upgrade', 'factory-implement', 'factory-intake',
    'factory-investigate', 'factory-maintenance', 'factory-plan', 'factory-review'
)
$base = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
$now = [DateTimeOffset]::UtcNow
$decisions = [System.Collections.Generic.List[object]]::new()
$cancelled = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[object]]::new()

function ConvertTo-RunList($Payload) {
    if ($null -eq $Payload) { throw 'Runs response is null.' }
    if ($Payload -is [System.Array]) { return @($Payload) }
    if ($Payload -is [System.Collections.IDictionary]) {
        if ($Payload.Contains('runs') -and $Payload.runs -is [System.Array]) { return @($Payload.runs) }
        if ($Payload.Contains('data') -and $Payload.data -is [System.Collections.IDictionary] -and
            $Payload.data.Contains('runs') -and $Payload.data.runs -is [System.Array]) { return @($Payload.data.runs) }
    }
    throw 'Runs response must be an array, an object with a runs array, or an object with data.runs array.'
}

function Get-PropertyValue($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Parse-Timestamp($Value, [string]$Field, [string]$RunId) {
    $parsed = [DateTimeOffset]::MinValue
    if (-not $Value -or -not [DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)) {
        throw "Run '$RunId' has missing or invalid $Field evidence."
    }
    return $parsed.ToUniversalTime()
}

function Get-StallDecision($Run, [DateTimeOffset]$At) {
    $id = [string](Get-PropertyValue $Run 'id')
    if ([string]::IsNullOrWhiteSpace($id)) { throw 'Runs response contains an entry without an id.' }
    $workflow = [string](Get-PropertyValue $Run 'workflow')
    if ($workflow -notin $factoryWorkflows) { return @{ eligible = $false; reason = 'not-positive-factory-workflow'; evidence = @("workflow=$workflow") } }
    $issueNumber = 0
    $issueValue = Get-PropertyValue $Run 'issueNumber'
    if (-not [int]::TryParse([string]$issueValue, [ref]$issueNumber) -or $issueNumber -le 0) {
        return @{ eligible = $false; reason = 'no-positive-issue-owner'; evidence = @('issueNumber missing or invalid') }
    }
    if ([string](Get-PropertyValue $Run 'status') -ne 'running') { return @{ eligible = $false; reason = 'run-not-running'; evidence = @("status=$((Get-PropertyValue $Run 'status'))") } }

    $startedValue = Get-PropertyValue $Run 'startedAt'
    if (-not $startedValue) { return @{ eligible = $false; reason = 'insufficient-liveness-evidence'; evidence = @('startedAt missing') } }
    $startedAt = Parse-Timestamp $startedValue 'startedAt' $id
    if (($At - $startedAt).TotalMinutes -lt $MaxRunMinutes) {
        return @{ eligible = $false; reason = 'below-wall-clock-budget'; evidence = @("startedAt=$($startedAt.ToString('o'))") }
    }

    $runner = Get-PropertyValue $Run 'runnerState'
    if ($null -eq $runner) { $runner = Get-PropertyValue (Get-PropertyValue $Run 'runner') 'state' }
    if ([string]$runner -ne 'stalled') { return @{ eligible = $false; reason = 'runner-not-confirmed-stalled'; evidence = @("runnerState=$runner") } }

    $lease = Get-PropertyValue $Run 'lease'
    $leaseRunId = [string](Get-PropertyValue $lease 'runId')
    $missingEvidence = @()
    if (-not $leaseRunId) { $missingEvidence += 'lease.runId' }
    foreach ($field in @('expiresAt')) { if (-not (Get-PropertyValue $lease $field)) { $missingEvidence += "lease.$field" } }
    foreach ($field in @('heartbeatAt','lastProgressAt','deadlineAt')) { if (-not (Get-PropertyValue $Run $field)) { $missingEvidence += $field } }
    if ($missingEvidence.Count) { return @{ eligible = $false; reason = 'insufficient-liveness-evidence'; evidence = @("missing fields: $($missingEvidence -join ', ')") } }
    if ($leaseRunId -ne $id) { return @{ eligible = $false; reason = 'lease-not-owned-by-run'; evidence = @("lease.runId=$leaseRunId") } }
    $leaseExpiry = Parse-Timestamp (Get-PropertyValue $lease 'expiresAt') 'lease.expiresAt' $id
    if ($leaseExpiry -gt $At) { return @{ eligible = $false; reason = 'lease-still-valid'; evidence = @("lease.expiresAt=$($leaseExpiry.ToString('o'))") } }

    $heartbeat = Parse-Timestamp (Get-PropertyValue $Run 'heartbeatAt') 'heartbeatAt' $id
    $progress = Parse-Timestamp (Get-PropertyValue $Run 'lastProgressAt') 'lastProgressAt' $id
    $deadline = Parse-Timestamp (Get-PropertyValue $Run 'deadlineAt') 'deadlineAt' $id
    if (($At - $heartbeat).TotalMinutes -lt $MaxIdleMinutes) { return @{ eligible = $false; reason = 'heartbeat-is-recent'; evidence = @("heartbeatAt=$($heartbeat.ToString('o'))") } }
    if (($At - $progress).TotalMinutes -lt $MaxIdleMinutes) { return @{ eligible = $false; reason = 'progress-is-recent'; evidence = @("lastProgressAt=$($progress.ToString('o'))") } }
    if ($deadline -gt $At) { return @{ eligible = $false; reason = 'deadline-not-expired'; evidence = @("deadlineAt=$($deadline.ToString('o'))") } }

    return @{ eligible = $true; reason = 'factory-run-stalled-past-deadline'; issueNumber = $issueNumber; evidence = @(
        "workflow=$workflow", "issueNumber=$issueNumber", "startedAt=$($startedAt.ToString('o'))",
        "runnerState=$runner", "lease.runId=$leaseRunId", "lease.expiresAt=$($leaseExpiry.ToString('o'))",
        "heartbeatAt=$($heartbeat.ToString('o'))", "lastProgressAt=$($progress.ToString('o'))", "deadlineAt=$($deadline.ToString('o'))"
    ) }
}

function Write-Report([string]$Status) {
    $report = [ordered]@{
        project = $ProjectId
        checkedAt = $now.ToString('o')
        operator = [Environment]::UserName
        status = $Status
        maxRunMinutes = $MaxRunMinutes
        maxIdleMinutes = $MaxIdleMinutes
        decisions = @($decisions)
        cancelled = @($cancelled)
        failures = @($failures)
    }
    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding utf8
    $report | ConvertTo-Json -Depth 10
}

function Get-ApiPayload([string]$Uri) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Get
    ConvertFrom-Json -InputObject $response.Content -AsHashtable -NoEnumerate -DateKind String
}

try {
    if ($RunsFixturePath) {
        if (-not $DryRun) { throw 'RunsFixturePath is allowed only with -DryRun.' }
        $payload = Get-Content -LiteralPath $RunsFixturePath -Raw | ConvertFrom-Json -AsHashtable -NoEnumerate -DateKind String
    } else {
        $payload = Get-ApiPayload "$base/runs"
    }
    $runs = @(ConvertTo-RunList $payload)
    foreach ($run in $runs) {
        $id = [string](Get-PropertyValue $run 'id')
        try {
            $decision = Get-StallDecision $run $now
            $entry = [ordered]@{ id = $id; decision = if ($decision.eligible) { 'eligible' } else { 'skipped' }; reason = $decision.reason; evidence = @($decision.evidence); operator = [Environment]::UserName }
            if (-not $decision.eligible) { $decisions.Add($entry); continue }

            if ($DryRun -or -not $PSCmdlet.ShouldProcess($id, 'cancel stalled Factory run')) {
                $entry.decision = 'would-cancel'
                $decisions.Add($entry)
                continue
            }

            # Re-read immediately before the effect. State changes and repeated runs are safe no-ops.
            $current = Get-ApiPayload "$base/runs/$([uri]::EscapeDataString($id))"
            if ([string](Get-PropertyValue $current 'status') -ne 'running') {
                $entry.decision = 'skipped'
                $entry.reason = 'run-no-longer-running'
                $decisions.Add($entry)
                continue
            }
            $currentDecision = Get-StallDecision $current ([DateTimeOffset]::UtcNow)
            if (-not $currentDecision.eligible) {
                $entry.decision = 'skipped'
                $entry.reason = "eligibility-changed:$($currentDecision.reason)"
                $entry.evidence = @($currentDecision.evidence)
                $decisions.Add($entry)
                continue
            }
            $response = Invoke-RestMethod -Method Post "$base/runs/$([uri]::EscapeDataString($id))/cancel"
            if (-not $response.cancelled) { throw "Cezar did not confirm cancellation for run '$id'." }
            $entry.decision = 'cancelled'
            $entry.reason = 'factory-run-stalled-past-deadline'
            $cancelled.Add([pscustomobject]@{ id = $id; issueNumber = $decision.issueNumber; reason = $entry.reason; evidence = @($decision.evidence) })
            $decisions.Add($entry)
        } catch {
            $failures.Add([pscustomobject]@{ id = $id; error = $_.Exception.Message })
            $decisions.Add([pscustomobject]@{ id = $id; decision = 'failed'; reason = 'run-check-or-cancel-failed'; evidence = @($_.Exception.Message); operator = [Environment]::UserName })
        }
    }
} catch {
    $failures.Add([pscustomobject]@{ id = $null; error = $_.Exception.Message })
}

$status = if ($failures.Count) { 'failed' } else { 'complete' }
$json = Write-Report $status
if ($failures.Count) { exit 1 }
Write-Output $json
