#!/usr/bin/env pwsh
<##
.SYNOPSIS
Applies the deterministic, repository-independent portion of Factory maintenance.

.DESCRIPTION
This script is deliberately the only maintenance-sweep mutation point. It moves
`factory:working` issues to `factory:investigate` when they are stale or their
latest Cezar run failed (so they can be re-attempted), and writes one summary
issue for stale non-terminal work. It does not inspect source code, infer
documentation drift, run tests, or create speculative TODO issues: those need
project-specific checks and must be surfaced by the normal issue intake path.
#>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$OutputPath = '.factory/repository-maintenance.json',
    [string]$ApiUrl = $(if ($env:CEZAR_API_URL) { $env:CEZAR_API_URL } else { 'http://127.0.0.1:4321' }),
    [string]$ProjectId = $env:CEZAR_PROJECT_ID,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This workflow is synced to every project, so derive the Cezar project id from the
# isolated worktree path (<project>/.ai/cezar/worktrees/<id>) like audit-factory-failures.ps1.
if (-not $ProjectId -and (Get-Location).Path -match '^(?<root>.+)[\\/]\.ai[\\/]cezar[\\/]worktrees[\\/][^\\/]+$') {
    $ProjectId = (Split-Path $Matches.root -Leaf).ToLowerInvariant()
}

$workingCutoff =[DateTimeOffset]::UtcNow.AddHours(-24)
$staleCutoff = [DateTimeOffset]::UtcNow.AddDays(-60)
$summaryTitle = 'Factory maintenance: stale open issues'

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}

function Get-Labels($Issue) {
    @($Issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } })
}

function Write-Result($Result) {
    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $Result | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
    $Result | ConvertTo-Json -Depth 8
}

$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,updatedAt,labels,url')
$issues = @($raw -join "`n" | ConvertFrom-Json)

# Latest Cezar run status per issue, so failed runs can release `factory:working` without waiting 24 hours.
$latestRunStatus = @{}
$limitations = @()
if ($ProjectId) {
    try {
        $apiBase = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
        $payload = (Invoke-WebRequest -UseBasicParsing -Uri "$apiBase/runs" -Method Get).Content | ConvertFrom-Json
        $runs = if ($payload.PSObject.Properties.Name -contains 'runs') { @($payload.runs) } else { @($payload) }
        foreach ($run in ($runs | Where-Object {
            $_.PSObject.Properties.Name -contains 'issueNumber' -and
            $null -ne $_.issueNumber -and
            [string]$_.issueNumber -ne ''
        } | Sort-Object { [DateTimeOffset]::Parse([string]$_.createdAt) })) {
            $latestRunStatus[[int]$run.issueNumber] = [string]$run.status
        }
    } catch {
        $limitations += 'Cezar run API unavailable; failed-run release skipped: ' + $_.Exception.Message
    }
} else {
    $limitations += 'No Cezar project id configured; failed-run release skipped.'
}

$moved = @()
foreach ($issue in $issues) {
    $labels = @(Get-Labels $issue)
    if ($labels -notcontains 'factory:working') { continue }
    $updated = [DateTimeOffset]::Parse([string]$issue.updatedAt)
    $runFailed = $latestRunStatus[[int]$issue.number] -eq 'failed'
    if ($runFailed -or $updated -le $workingCutoff) {
        $reason = if ($runFailed) { 'its latest Cezar run failed' } else { '24 hours without activity' }
        if (-not $DryRun) {
            Invoke-Gh @('issue', 'edit', [string]$issue.number, '--remove-label', 'factory:working', '--add-label', 'factory:investigate') | Out-Null
            Invoke-Gh @('issue', 'comment', [string]$issue.number, '--body', "Factory maintenance moved this work to ``factory:investigate`` because $reason.") | Out-Null
        }
        $moved += [ordered]@{ issue = [int]$issue.number; action = if ($DryRun) { 'would-investigate' } else { 'investigated' }; reason = if ($runFailed) { 'failed-run' } else { 'inactive' }; updatedAt = [string]$issue.updatedAt }
    }
}

$stale = @($issues | Where-Object {
    $labels = @(Get-Labels $_)
    [DateTimeOffset]::Parse([string]$_.updatedAt) -le $staleCutoff -and $labels -notcontains 'factory:done'
} | Sort-Object { [DateTimeOffset]::Parse([string]$_.updatedAt) }, number | Select-Object -First 50 | ForEach-Object {
    [ordered]@{ issue = [int]$_.number; title = [string]$_.title; url = [string]$_.url; updatedAt = [string]$_.updatedAt }
})

$summary = $null
if ($stale.Count) {
    $existingRaw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', "in:title `"$summaryTitle`"", '--limit', '10', '--json', 'number,title,url')
    $existing = @($existingRaw -join "`n" | ConvertFrom-Json | Where-Object { $_.title -eq $summaryTitle } | Select-Object -First 1)
    if ($existing.Count) {
        $summary = [ordered]@{ action = 'already-open'; issue = [int]$existing[0].number; url = [string]$existing[0].url }
    } elseif ($DryRun) {
        $summary = [ordered]@{ action = 'would-create'; issueCount = $stale.Count }
    } else {
        $body = "## Stale open issues`n`n" + (($stale | ForEach-Object { "- #$($_.issue) — $($_.title) (last updated $($_.updatedAt))" }) -join "`n") + "`n`nGenerated deterministically by Factory maintenance. Triage or close each item."
        $created = Invoke-Gh @('issue', 'create', '--title', $summaryTitle, '--body', $body, '--label', 'factory:new', '--label', 'type:maintenance', '--label', 'risk:low')
        $summary = [ordered]@{ action = 'created'; url = ($created -join "`n").Trim(); issueCount = $stale.Count }
    }
}

Write-Result ([ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    workingCutoff = $workingCutoff.ToString('o')
    staleCutoff = $staleCutoff.ToString('o')
    considered = $issues.Count
    movedToInvestigate = $moved
    limitations = $limitations
    staleIssues = $stale
    staleSummary = $summary
    unsupportedChecks = @('TODO/FIXME discovery', 'documentation drift', 'flaky-test detection')
    terminalReason = 'deterministic-maintenance-complete'
})
