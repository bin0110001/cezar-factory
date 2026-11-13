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

# Which states are re-triggered comes from the lifecycle policy, not from a list in this script: a
# state is workable when its deadline action is `retrigger`. The initial state is left to the
# scheduled intake pull. Every other state belongs to a run in progress, a person, or delivery.
. (Join-Path $PSScriptRoot 'lifecycle-lib.ps1')
$lifecycle = Get-FactoryLifecycle
$workableStates = @($lifecycle.States.Keys | Where-Object { $_ -ne $lifecycle.Initial -and $lifecycle.States[$_]['onTimeout'] -eq 'retrigger' })
$manualOrTerminalStates = @($lifecycle.States.Keys | Where-Object { $_ -ne $lifecycle.Initial -and $workableStates -notcontains $_ })
# States whose consumer needs exactly one complexity label (the policy's `requires.exactlyOne`).
$complexityGuardedStates = @($workableStates | Where-Object { $lifecycle.States[$_]['requires'] -and $lifecycle.States[$_]['requires']['exactlyOne'] -eq 'complexity' })
$complexityLabels = @('complexity:small', 'complexity:medium', 'complexity:large')

. (Join-Path $PSScriptRoot 'gh-cache.ps1')

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
# Same listing (and field set) as sync-issue-delivery.ps1 and maintain-repository.ps1, so one
# maintenance run pays for it once. See gh-cache.ps1.
$listArguments = @('issue','list','--state','open','--limit','1000','--json','number,title,createdAt,updatedAt,labels,url')
$raw = Get-GhCachedText "$GhCommand|$Repo|$($listArguments -join ' ')" { Invoke-Gh $listArguments }
$issues = @($raw | ConvertFrom-Json)
$candidates = @()
$excluded = @()

foreach ($issue in $issues) {
    $labels = @(Get-LabelNames $issue)
    $states = @($labels | Where-Object { $_ -like 'factory:*' -and $_ -in ($workableStates + $manualOrTerminalStates) })
    $created = [DateTimeOffset]::Parse([string]$issue.createdAt)
    # Staleness is "nothing has happened for the cutoff", not "created long ago". A refresh edits the
    # labels, which moves updatedAt, so a refreshed issue drops to the back of the queue and every
    # workable issue gets its turn. Sorting by createdAt re-triggered the same two issues forever.
    $updatedText = if ($issue.PSObject.Properties['updatedAt'] -and $issue.updatedAt) { [string]$issue.updatedAt } else { [string]$issue.createdAt }
    $updated = [DateTimeOffset]::Parse($updatedText)
    $reason = $null
    if ($updated -gt $cutoff) { $reason = 'younger-than-cutoff' }
    elseif ($states.Count -ne 1) { $reason = if ($states.Count -eq 0) { 'no-single-lifecycle-state' } else { 'multiple-lifecycle-states' } }
    elseif ($manualOrTerminalStates -contains $states[0]) { $reason = 'manual-or-terminal-state' }
    elseif ($labels -contains 'factory:auditing' -or $labels -contains 'factory:tracking') { $reason = 'audit-or-tracking-marker' }
    elseif ($complexityGuardedStates -contains $states[0] -and @($labels | Where-Object { $complexityLabels -contains $_ }).Count -ne 1) { $reason = 'ready-without-one-complexity-label' }

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
        updatedAt = $updated.ToString('o')
        ageHours = [Math]::Round(([DateTimeOffset]::UtcNow - $created).TotalHours, 1)
        idleHours = [Math]::Round(([DateTimeOffset]::UtcNow - $updated).TotalHours, 1)
        labels = $labels
    }
}

# Order the queue (STABILIZATION-PLAN.md item 3.2): an issue labelled `priority:N` (0 is the most urgent) goes before one
# that is not, and within a priority the least recently touched goes first, so every workable issue is still re-triggered in turn.
function Get-IssuePriority($Labels) {
    $ranks = @(@($Labels) | ForEach-Object { if ([string]$_ -match '^priority:(\d+)$') { [int]$Matches[1] } })
    if ($ranks.Count) { ($ranks | Measure-Object -Minimum).Minimum } else { 1000 }
}
$selected = @($candidates | Sort-Object @{ Expression = { Get-IssuePriority $_.labels }; Ascending = $true }, @{ Expression = { [DateTimeOffset]::Parse($_.updatedAt) }; Ascending = $true }, issue | Select-Object -First $Limit)
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

if ($refreshed.Count -or $failures.Count) { Clear-GhCache }

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
