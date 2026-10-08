#!/usr/bin/env pwsh
<##
.SYNOPSIS
Retriggers a small batch of old, executable Factory issues.

.DESCRIPTION
Finds open issues older than the configured age with exactly one executable Factory
lifecycle state. Manual-gate, blocked, working, done, malformed, and unroutable issues
are excluded. For each selected issue, the lifecycle label is removed and then added
again in separate GitHub edits; the add emits the issue.labeled event consumed by Cezar.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 100)][int]$Limit = 2,
    [ValidateRange(1, 8760)][int]$OlderThanHours = 24,
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$OutputPath = '.factory/stale-workable-refresh.json',
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workableStates = @(
    'factory:new',
    'factory:needs-plan',
    'factory:ready',
    'factory:review',
    'factory:changes-requested',
    'factory:investigate'
)
$manualOrTerminalStates = @(
    'factory:needs-help',
    'factory:working',
    'factory:human-review',
    'factory:blocked',
    'factory:done'
)
$complexityLabels = @('complexity:small', 'complexity:medium', 'complexity:large')

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")"
    }
    $output
}

function Get-LabelNames($Issue) {
    @($Issue.labels | ForEach-Object {
        if ($_ -is [string]) { [string]$_ } else { [string]$_.name }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Write-Result($Result) {
    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $Result | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
    $Result | ConvertTo-Json -Depth 8
}

$cutoff = [DateTimeOffset]::UtcNow.AddHours(-$OlderThanHours)
$raw = Invoke-Gh @('issue','list','--state','open','--limit','1000','--json','number,title,createdAt,labels,url')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$candidates = @()
$excluded = @()

foreach ($issue in $issues) {
    $labels = @(Get-LabelNames $issue)
    $states = @($labels | Where-Object { $_ -like 'factory:*' -and $_ -in ($workableStates + $manualOrTerminalStates) })
    $created = [DateTimeOffset]::Parse([string]$issue.createdAt)
    $reason = $null
    if ($created -gt $cutoff) { $reason = 'younger-than-cutoff' }
    elseif ($states.Count -ne 1) { $reason = if ($states.Count -eq 0) { 'no-single-lifecycle-state' } else { 'multiple-lifecycle-states' } }
    elseif ($manualOrTerminalStates -contains $states[0]) { $reason = 'manual-or-terminal-state' }
    elseif ($labels -contains 'factory:auditing' -or $labels -contains 'factory:tracking') { $reason = 'audit-or-tracking-marker' }
    elseif ($states[0] -eq 'factory:ready' -and @($labels | Where-Object { $complexityLabels -contains $_ }).Count -ne 1) { $reason = 'ready-without-one-complexity-label' }

    if ($reason) {
        if ($reason -notin @('younger-than-cutoff')) {
            $excluded += [ordered]@{ issue = [int]$issue.number; state = if ($states.Count) { $states -join ',' } else { $null }; reason = $reason }
        }
        continue
    }
    $candidates += [ordered]@{
        issue = [int]$issue.number
        title = [string]$issue.title
        url = [string]$issue.url
        state = [string]$states[0]
        createdAt = [string]$issue.createdAt
        ageHours = [Math]::Round(([DateTimeOffset]::UtcNow - $created).TotalHours, 1)
        labels = $labels
    }
}

$selected = @($candidates | Sort-Object @{ Expression = { [DateTimeOffset]::Parse($_.createdAt) }; Ascending = $true }, issue | Select-Object -First $Limit)
$refreshed = @()
$failures = @()
foreach ($candidate in $selected) {
    try {
        if (-not $DryRun) {
            Invoke-Gh @('issue','edit',[string]$candidate.issue,'--remove-label',$candidate.state) | Out-Null
            Invoke-Gh @('issue','edit',[string]$candidate.issue,'--add-label',$candidate.state) | Out-Null
        }
        $candidate.action = if ($DryRun) { 'would-refresh' } else { 'refreshed' }
        $refreshed += $candidate
    }
    catch {
        $failures += [ordered]@{ issue = $candidate.issue; state = $candidate.state; error = $_.Exception.Message }
    }
}

$result = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    cutoff = $cutoff.ToString('o')
    olderThanHours = $OlderThanHours
    limit = $Limit
    dryRun = [bool]$DryRun
    considered = @($issues).Count
    eligible = @($candidates).Count
    refreshed = $refreshed
    excluded = $excluded
    failures = $failures
    terminalReason = if ($failures.Count) { 'refresh-failures' } elseif ($refreshed.Count) { 'refreshed-bounded-batch' } else { 'no-stale-workable-issues' }
}
Write-Result $result
if ($failures.Count) { exit 1 }
