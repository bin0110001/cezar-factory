#!/usr/bin/env pwsh
<#
.SYNOPSIS
Builds the bounded input for the legacy backlog-label audit.

.DESCRIPTION
Reads only open issues without a Factory label and emits a bounded proposal
input. It makes no GitHub changes; a separate workflow consumer validates and
applies deterministic classifications and audit reservations.
#>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo,
    [ValidateRange(1, 100)][int]$Limit = 3,
    [string]$OutputPath = '.factory/backlog-label-audit-input.json',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}

function Get-LabelNames($Issue) {
    @($Issue.labels | ForEach-Object {
        if ($_ -is [string]) { [string]$_ } else { [string]$_.name }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-IssueBody([int]$IssueNumber) {
    $rawBody = Invoke-Gh @('issue', 'view', [string]$IssueNumber, '--json', 'body')
    $view = ($rawBody -join "`n") | ConvertFrom-Json
    [string]$view.body
}

$factoryMarkers = @('factory:new', 'factory:needs-plan', 'factory:needs-help', 'factory:ready', 'factory:working', 'factory:review', 'factory:changes-requested', 'factory:human-review', 'factory:blocked', 'factory:done', 'factory:investigate', 'factory:auditing', 'factory:tracking')
$search = 'is:open ' + (($factoryMarkers | ForEach-Object { "-label:`"$_`"" }) -join ' ')
$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', $search, '--limit', '1000', '--json', 'number,title,labels,updatedAt,blockedBy,closedByPullRequestsReferences')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$unmarked = @($issues |
    Where-Object {
        $names = @(Get-LabelNames $_)
        @($names | Where-Object { $_ -like 'factory:*' }).Count -eq 0
    } |
    Sort-Object number |
    ForEach-Object {
        $labels = @(Get-LabelNames $_)
        $typeHints = @(
            if ($labels -contains 'bug') { 'bug' }
            if ($labels -contains 'test') { 'test' }
            if ($labels -contains 'enhancement') { 'feature' }
            if ($labels -contains 'migration' -or $labels -contains 'architecture') { 'refactor' }
            if ($labels -contains 'documentation' -or $labels -contains 'localization') { 'docs' }
        )
        $typeHints = @($typeHints | Select-Object -Unique)
        $typeHintConflict = $typeHints.Count -gt 1
        $typeHint = if ($typeHints.Count -eq 1) { $typeHints[0] } else { $null }
        $riskHint = if ($typeHintConflict) { $null }
            elseif ($labels -contains 'test' -and $labels -notcontains 'bug') { 'low' }
            else { 'medium' }
        [ordered]@{
            number = [int]$_.number
            title = [string]$_.title
            labels = $labels
            updatedAt = $_.updatedAt
            blockedByStates = @($_.blockedBy | Where-Object { $_ } | ForEach-Object { [string]$_.state } | Where-Object { $_ -in @('OPEN', 'CLOSED') })
            dependencyStateUnknown = (@($_.blockedBy | Where-Object { $_ } | Where-Object { [string]$_.state -notin @('OPEN', 'CLOSED') }).Count -gt 0)
            linkedClosingPullRequestCount = @($_.closedByPullRequestsReferences | Where-Object { $_ }).Count
            typeHint = $typeHint
            riskHint = $riskHint
            ruleConflicts = if ($typeHintConflict) { @('legacy labels map to multiple issue types') } else { @() }
        }
    })

# Build deterministic proposals for clear legacy markers; a downstream
# consumer owns all label edits and reservations. The LLM limit applies only
# to the ambiguous remainder.
$resolved = @()
$remainingCandidates = @()
$staged = @()
$ruleHits = [ordered]@{
    legacy_blocked_marker = 0
    github_dependency_open = 0
    open_issue_with_closed_linked_pr = 0
    legacy_decomposition_marker = 0
    legacy_type_marker = 0
}
foreach ($candidate in $unmarked) {
    $legacyLabels = @($candidate.labels)
    $state = $null
    $reason = $null
    $ruleId = $null
    $add = @()
    $hasBlockedMarker = $legacyLabels -contains 'blocked' -or $legacyLabels -contains 'blocker'
    $hasDecompositionMarker = $legacyLabels -contains 'needs-decomp' -or $legacyLabels -contains 'needs-decomposition'
    $blockedByStates = @($candidate.blockedByStates | Where-Object { $_ })
    $linkedClosingPullRequestCount = [int]$candidate.linkedClosingPullRequestCount
    $unknownDependencyState = [bool]$candidate.dependencyStateUnknown
    $hasOpenDependency = @($blockedByStates | Where-Object { [string]$_ -eq 'OPEN' }).Count -gt 0
    if ($hasOpenDependency -and $linkedClosingPullRequestCount -gt 0) {
        $candidate['ruleConflicts'] = @($candidate.ruleConflicts) + 'open dependency conflicts with a linked closing pull request'
    } elseif ($unknownDependencyState) {
        $candidate['ruleConflicts'] = @($candidate.ruleConflicts) + 'GitHub dependency state is missing or unsupported'
    } elseif ($linkedClosingPullRequestCount -gt 0) {
        # An open issue with a linked closing PR needs outcome review; never infer
        # completion from a PR reference while the issue itself remains open.
        $state = 'factory:needs-help'
        $reason = 'open issue has a linked closing pull request; verify its merge outcome'
        $ruleId = 'open_issue_with_closed_linked_pr'
    } elseif ($hasOpenDependency) {
        $state = 'factory:blocked'
        $reason = 'GitHub reports an open blocking dependency'
        $ruleId = 'github_dependency_open'
    } elseif ($hasBlockedMarker -and $hasDecompositionMarker) {
        $candidate['ruleConflicts'] = @($candidate.ruleConflicts) + 'legacy labels imply conflicting lifecycle states'
    } elseif ($hasBlockedMarker) {
        $state = 'factory:blocked'
        $reason = 'legacy blocked marker'
        $ruleId = 'legacy_blocked_marker'
    } elseif ($hasDecompositionMarker) {
        $state = 'factory:needs-plan'
        $reason = 'legacy decomposition marker'
        $ruleId = 'legacy_decomposition_marker'
        $add += 'complexity:large'
    } elseif ($candidate.typeHint -and @($candidate.ruleConflicts).Count -eq 0) {
        $state = 'factory:new'
        $reason = 'unambiguous legacy type marker'
        $ruleId = 'legacy_type_marker'
    }

    if ($state) {
        $add += $state
        if ($candidate.typeHint) { $add += "type:$($candidate.typeHint)" }
        if ($candidate.riskHint) { $add += "risk:$($candidate.riskHint)" }
        $add = @($add | Select-Object -Unique)
        $ruleHits[$ruleId]++
        $resolved += [ordered]@{ issue = $candidate.number; added = $add; reason = $reason; ruleId = $ruleId; sourceLabels = @($candidate.labels) }
        continue
    }

    # Reservation is only for genuinely ambiguous items. The LLM receives
    # only the first requested number of unresolved issues. Fetch their bodies
    # here, before the LLM step, so the LLM never performs issue discovery.
    if ($remainingCandidates.Count -ge $Limit) { continue }
        $detail = Invoke-Gh @('issue', 'view', [string]$candidate.number, '--json', 'body,labels,updatedAt') | Out-String | ConvertFrom-Json
        $detailLabels = @(Get-LabelNames $detail)
        if ([string]$detail.updatedAt -ne [string]$candidate.updatedAt -or (@($detailLabels | Sort-Object) -join "`n") -ne (@($candidate.labels | Sort-Object) -join "`n")) {
            throw "Issue $($candidate.number) changed while the audit snapshot was being collected (list revision '$($candidate.updatedAt)' vs detail '$($detail.updatedAt)'). Rerun the collector."
        }
        $candidate.body = [string]$detail.body
    $staged += [ordered]@{
        issue = $candidate.number
        sourceLabels = @($candidate.labels)
        reservation = 'factory:auditing'
    }
    $remainingCandidates += $candidate
}

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$eligibleIssueCount = @($unmarked).Count
$deterministicRuleHitCount = @($resolved).Count
$ambiguousIssueCount = [Math]::Max(0, $eligibleIssueCount - $deterministicRuleHitCount)
$result = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    workingDirectory = (Get-Location).Path
    outputPath = $resolvedOutputPath
    limit = $Limit
    candidates = $remainingCandidates
    resolved = $resolved
    staged = $staged
    classificationMetrics = [ordered]@{
        eligibleIssues = $eligibleIssueCount
        deterministicRuleHits = $deterministicRuleHitCount
        deterministicRuleHitRate = if ($eligibleIssueCount) { [Math]::Round($deterministicRuleHitCount / $eligibleIssueCount, 4) } else { $null }
        ambiguousIssues = $ambiguousIssueCount
        ambiguousRate = if ($eligibleIssueCount) { [Math]::Round($ambiguousIssueCount / $eligibleIssueCount, 4) } else { $null }
        ambiguousIssuesSelectedForReview = @($remainingCandidates).Count
        ruleHits = $ruleHits
    }
    unreviewedAmbiguousCount = [Math]::Max(0, @($unmarked).Count - @($resolved).Count - @($remainingCandidates).Count)
    terminalReason = if ($remainingCandidates.Count) { 'candidates-staged' } elseif ($resolved.Count) { 'candidates-resolved' } else { 'no-unmarked-open-issues' }
}
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 6 | Set-Content -NoNewline $OutputPath
$result | ConvertTo-Json -Depth 6
