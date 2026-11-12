#!/usr/bin/env pwsh
<##
.SYNOPSIS
Checks every open issue against the lifecycle policy, repairs what is mechanical, and reports the rest.

.DESCRIPTION
The invariant is: every open issue is in exactly one lifecycle state, that state has an owner, and the
issue has not sat there past the state's deadline. The lifecycle (policies/lifecycle.json) says what the
states, owners, guards and deadlines are; this script holds no list of its own.

Repairs (each leaves a comment with the evidence, at most -RepairLimit per run):
  - no state label                      -> the profile's initial state, so intake classifies it
  - a guard is not met (for example a ready issue without exactly one complexity label)
                                         -> the guard's `otherwise` state
  - a blocked issue whose stated blockers are all closed
                                         -> the state's `onUnblocked` state
  - an issue in review whose pull request conflicts with the base branch
                                         -> the state's `onConflict` state, so the fix automation repairs the PR

Everything else that breaks the invariant is listed in one rolling issue ("Factory stall report") that a
person can read in a minute: several state labels, work past its deadline, a blocked issue that names no
blocker, a pull request that is a draft or names no issue. The report issue is updated in place, and only
when its content changes.
#>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$BaseBranch = 'dev',
    [string]$OutputPath = '.factory/lifecycle-sweep.json',
    [string]$LifecyclePath = '',
    [string]$LifecycleProfile = '',
    [ValidateRange(0, 50)][int]$RepairLimit = 5,
    [ValidateRange(0, 50)][int]$BlockerCheckLimit = 5,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'gh-cache.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-lib.ps1')

$reportTitle = 'Factory stall report'
$lifecycleArguments = @{}
if ($LifecyclePath) { $lifecycleArguments.Path = $LifecyclePath }
if ($LifecycleProfile) { $lifecycleArguments.Profile = $LifecycleProfile }
$lifecycle = Get-FactoryLifecycle @lifecycleArguments
$stateNames = @($lifecycle.States.Keys)
$markerNames = @($lifecycle.Markers.Keys)
$now = [DateTimeOffset]::UtcNow

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}
function Get-LabelNames($Item) {
    @($Item.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } } | Where-Object { $_ })
}
function Get-Field($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null }
}
function Write-Body([string]$Text) {
    $file = Join-Path ([IO.Path]::GetTempPath()) "factory-sweep-$([guid]::NewGuid().ToString('N')).md"
    [IO.File]::WriteAllText($file, $Text)
    $file
}

# Same listing and field set as the other maintenance steps, so one run pays for it once (gh-cache.ps1).
$listArguments = @('issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,createdAt,updatedAt,labels,url')
$issues = @((Get-GhCachedText "$GhCommand|$Repo|$($listArguments -join ' ')" { Invoke-Gh $listArguments }) | ConvertFrom-Json | Where-Object { $_ })
$openNumbers = @($issues | ForEach-Object { [int]$_.number })
$pullRequests = @((Invoke-Gh @('pr', 'list', '--state', 'open', '--base', $BaseBranch, '--limit', '100', '--json', 'number,title,body,url,isDraft,mergeable')) -join "`n" | ConvertFrom-Json | Where-Object { $_ })

$closingPattern = '(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)'
$blockerPattern = '(?im)\b(?:blocked\s+by|depends\s+on|blocked\s+on|requires)\s*:?\s*((?:#\d+(?:\s*(?:,|and|&)\s*)?)+)'

$repairs = @(); $violations = @(); $repairBudget = $RepairLimit

function Add-Violation([int]$Number, [string]$Title, [string]$Kind, [string]$Detail) {
    $script:violations += [ordered]@{ issue = $Number; title = $Title; kind = $Kind; detail = $Detail }
}
# A repair must land in a state the issue can stay in: if the target has a guard the issue does not meet,
# follow the guard's `otherwise` now, so the next run does not move the issue a second time.
function Resolve-Target([string[]]$Labels, [string]$Target) {
    for ($hop = 0; $hop -lt 4; $hop++) {
        $requires = $lifecycle.States[$Target]['requires']
        if (-not $requires -or -not $requires['exactlyOne'] -or -not $requires['otherwise']) { break }
        $prefix = "$($requires['exactlyOne']):"
        if (@($Labels | Where-Object { $_.StartsWith($prefix) }).Count -eq 1) { break }
        $Target = [string]$requires['otherwise']
    }
    $Target
}
function Invoke-Repair($Issue, [string]$Kind, [string[]]$Remove, [string]$Add, [string]$Evidence) {
    # Work in a local dev window belongs to a person. The sweep says what it sees and leaves the labels alone.
    if (@(Get-LabelNames $Issue) -contains 'factory:interactive') {
        Add-Violation ([int]$Issue.number) ([string]$Issue.title) $Kind "owned by a person (factory:interactive), so not changed: $Evidence"
        return
    }
    $Add = Resolve-Target @(Get-LabelNames $Issue) $Add
    if ($script:repairBudget -le 0) { Add-Violation ([int]$Issue.number) ([string]$Issue.title) "$Kind-pending" "repair deferred to the next run: $Evidence"; return }
    $script:repairBudget--
    if (-not $DryRun) {
        $edit = @('issue', 'edit', [string]$Issue.number)
        foreach ($label in $Remove) { $edit += @('--remove-label', $label) }
        $edit += @('--add-label', $Add)
        Invoke-Gh $edit | Out-Null
        Invoke-Gh @('issue', 'comment', [string]$Issue.number, '--body', "<!-- factory-lifecycle-sweep:$Kind -->`nFactory lifecycle sweep set ``$Add``: $Evidence") | Out-Null
    }
    $script:repairs += [ordered]@{ issue = [int]$Issue.number; kind = $Kind; removed = @($Remove); added = $Add; evidence = $Evidence; action = if ($DryRun) { 'would-repair' } else { 'repaired' } }
}

# Reading an issue's description costs a call, so only a few blocked issues are checked per run. Which ones
# rotates with the hour: an issue that cannot be unblocked must not keep the others from being looked at.
$blockerCandidates = @($issues | Where-Object {
        $candidateStates = @(Get-LabelNames $_ | Where-Object { $stateNames -contains $_ })
        $candidateStates.Count -eq 1 -and $lifecycle.States[$candidateStates[0]]['onUnblocked']
    } | Sort-Object { [int]$_.number } | ForEach-Object { [int]$_.number })
$blockerTurn = @()
if ($blockerCandidates.Count -and $BlockerCheckLimit -gt 0) {
    $startAt = [int]([Math]::Floor($now.ToUnixTimeSeconds() / 3600) % $blockerCandidates.Count)
    $blockerTurn = @(0..([Math]::Min($BlockerCheckLimit, $blockerCandidates.Count) - 1) | ForEach-Object { $blockerCandidates[($startAt + $_) % $blockerCandidates.Count] })
}

foreach ($issue in $issues) {
    $number = [int]$issue.number; $title = [string]$issue.title
    if ($title -eq $reportTitle) { continue }
    $labels = @(Get-LabelNames $issue)
    $states = @($labels | Where-Object { $stateNames -contains $_ })
    $markers = @($labels | Where-Object { $markerNames -contains $_ })
    if ($markers -contains 'factory:tracking') { continue }
    $idleHours = [Math]::Round(($now - [DateTimeOffset]::Parse([string]$issue.updatedAt)).TotalHours, 1)

    if ($states.Count -gt 1) { Add-Violation $number $title 'multiple-states' "carries $($states -join ', '); exactly one state is allowed"; continue }
    if ($states.Count -eq 0) {
        # A reservation or a person in a dev window owns it for now; anything else has no owner at all.
        if ($markers.Count) { if ($idleHours -ge 24) { Add-Violation $number $title 'no-state' "only $($markers -join ', ') and no state for $idleHours h" }; continue }
        Invoke-Repair $issue 'no-state' @() $lifecycle.Initial 'it had no lifecycle state, so no automation owned it.'
        continue
    }

    $name = $states[0]; $state = $lifecycle.States[$name]
    if ($state['kind'] -eq 'terminal') { continue }

    $requires = $state['requires']
    if ($requires -and $requires['exactlyOne']) {
        $prefix = "$($requires['exactlyOne']):"
        $matching = @($labels | Where-Object { $_.StartsWith($prefix) })
        if ($matching.Count -ne 1) {
            if ($matching.Count -eq 0 -and $requires['otherwise']) {
                Invoke-Repair $issue 'guard' @($name) ([string]$requires['otherwise']) "``$name`` needs exactly one ``$prefix*`` label and it had none, so its automation could never select it."
            } else {
                Add-Violation $number $title 'guard' "$name needs exactly one $prefix* label and has $($matching.Count)"
            }
            continue
        }
    }

    if ($state['onUnblocked'] -and $blockerTurn -contains $number) {
        $body = [string](Get-Field ((Invoke-Gh @('issue', 'view', [string]$number, '--json', 'body')) -join "`n" | ConvertFrom-Json) 'body')
        $blockers = @([regex]::Matches($body, $blockerPattern) | ForEach-Object { [regex]::Matches($_.Groups[1].Value, '#(\d+)') | ForEach-Object { [int]$_.Groups[1].Value } } | Where-Object { $_ -ne $number } | Sort-Object -Unique)
        if (-not $blockers.Count) {
            if ($idleHours -ge [double]$state['maxDwellHours']) { Add-Violation $number $title 'blocked-without-blocker' "blocked for $idleHours h and its description names no blocking issue" }
        } elseif (-not @($blockers | Where-Object { $openNumbers -contains $_ }).Count) {
            Invoke-Repair $issue 'unblocked' @($name) ([string]$state['onUnblocked']) "every issue it names as a blocker is closed ($(($blockers | ForEach-Object { "#$_" }) -join ', '))."
        }
        continue
    }

    $deadline = [double]$state['maxDwellHours']
    $action = [string]$state['onTimeout']
    # A re-triggered state is refreshed about once a day; three deadlines without progress means its
    # automation is not consuming it (paused, or refusing the issue).
    $limit = if ($action -eq 'retrigger') { 3 * $deadline } else { $deadline }
    if ($idleHours -ge $limit) {
        $owner = @(Get-FactoryLifecycleOwnerWorkflows $state)
        $who = if ($owner.Count) { "automation $($owner -join ' / ')" } else { "a person ($($state['owner']['role']))" }
        Add-Violation $number $title 'overdue' "in $name for $idleHours h with no activity (deadline $deadline h, owner: $who)"
    }
}

# Pull requests: the job that opened a PR owns it until it merges, so a conflict goes back to the fix automation.
foreach ($pr in $pullRequests) {
    $text = "$([string](Get-Field $pr 'title'))`n$([string](Get-Field $pr 'body'))"
    $closes = @([regex]::Matches($text, $closingPattern) | ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
    $prNumber = [int]$pr.number
    if ([bool](Get-Field $pr 'isDraft')) { Add-Violation $prNumber "PR: $($pr.title)" 'draft-pr' "draft pull request into $BaseBranch; delivery sync ignores drafts"; continue }
    if (-not $closes.Count) { Add-Violation $prNumber "PR: $($pr.title)" 'pr-without-issue' "pull request into $BaseBranch names no issue with a closing keyword"; continue }
    if ([string](Get-Field $pr 'mergeable') -ne 'CONFLICTING') { continue }
    foreach ($closed in $closes) {
        $issue = @($issues | Where-Object { [int]$_.number -eq $closed }) | Select-Object -First 1
        if (-not $issue) { continue }
        $labels = @(Get-LabelNames $issue)
        $states = @($labels | Where-Object { $stateNames -contains $_ })
        $target = if ($states.Count -eq 1) { $lifecycle.States[$states[0]]['onConflict'] } else { $null }
        if ($target) {
            Invoke-Repair $issue 'pr-conflict' @($states[0]) ([string]$target) "pull request #$prNumber conflicts with ``$BaseBranch``; the job that owns the PR merges ``$BaseBranch`` and resolves it."
        } elseif ($states.Count -ne 1 -or $lifecycle.States[$states[0]]['kind'] -notin 'automated', 'in-run') {
            # An issue an automation or a run already holds (for example the fix automation, after the
            # repair above) is being dealt with. A conflict on anything else has no one looking at it.
            Add-Violation $closed ([string]$issue.title) 'pr-conflict' "pull request #$prNumber conflicts with $BaseBranch"
        }
    }
}

if ($repairs.Count -and -not $DryRun) { Clear-GhCache }

# One rolling report, rewritten only when it changes.
$lines = @($violations | Sort-Object kind, issue | ForEach-Object { "- #$($_.issue) **$($_.kind)**: $($_.detail)" })
$content = if ($lines.Count) { ($lines -join "`n") } else { 'Nothing is stalled: every open issue is in one state, inside its deadline.' }
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($content))).ToLowerInvariant().Substring(0, 16)
$reportBody = "Open work that breaks the lifecycle invariant (one state, an owner, inside its deadline). Written by the hourly lifecycle sweep from ``policies/lifecycle.json``; it is replaced, not appended to.`n`n$content`n`n<!-- factory-stall-report:$digest -->"
$existing = @($issues | Where-Object { [string]$_.title -eq $reportTitle }) | Select-Object -First 1
$report = [ordered]@{ action = 'none'; issue = $null }
if ($existing) {
    $report.issue = [int]$existing.number
    $current = [string](Get-Field ((Invoke-Gh @('issue', 'view', [string]$existing.number, '--json', 'body')) -join "`n" | ConvertFrom-Json) 'body')
    if ($current -match "factory-stall-report:$digest") { $report.action = 'unchanged' }
    elseif ($DryRun) { $report.action = 'would-update' }
    else {
        $file = Write-Body $reportBody
        try { Invoke-Gh @('issue', 'edit', [string]$existing.number, '--body-file', $file) | Out-Null } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
        $report.action = 'updated'
    }
} elseif ($lines.Count) {
    if ($DryRun) { $report.action = 'would-create' }
    else {
        $file = Write-Body $reportBody
        try { $created = Invoke-Gh @('issue', 'create', '--title', $reportTitle, '--body-file', $file, '--label', 'factory:tracking') } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
        Clear-GhCache
        $report.action = 'created'; $report.url = ($created -join "`n").Trim()
    }
}

$result = [ordered]@{
    generatedAt = $now.ToString('o')
    profile = $lifecycle.Name
    dryRun = [bool]$DryRun
    considered = $issues.Count
    pullRequests = $pullRequests.Count
    repairs = $repairs
    violations = $violations
    report = $report
    terminalReason = if ($violations.Count) { 'stalled-work-reported' } elseif ($repairs.Count) { 'repaired' } else { 'invariant-holds' }
}
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
$result | ConvertTo-Json -Depth 8
