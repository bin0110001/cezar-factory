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
$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', $search, '--limit', '1000', '--json', 'number,title,labels,updatedAt')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$unmarked = @($issues |
    Where-Object {
        $names = @(Get-LabelNames $_)
        @($names | Where-Object { $_ -like 'factory:*' }).Count -eq 0
    } |
    Sort-Object number |
    ForEach-Object {
        $labels = @(Get-LabelNames $_)
        $typeHint = if ($labels -contains 'bug') { 'bug' }
            elseif ($labels -contains 'test') { 'test' }
            elseif ($labels -contains 'enhancement') { 'feature' }
            elseif ($labels -contains 'migration' -or $labels -contains 'architecture') { 'refactor' }
            elseif ($labels -contains 'documentation' -or $labels -contains 'localization') { 'docs' }
            else { $null }
        $riskHint = if ($labels -contains 'test' -and $labels -notcontains 'bug') { 'low' } else { 'medium' }
        [ordered]@{
            number = [int]$_.number
            title = [string]$_.title
            labels = $labels
            updatedAt = $_.updatedAt
            typeHint = $typeHint
            riskHint = $riskHint
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
    legacy_decomposition_marker = 0
    legacy_type_marker = 0
}
foreach ($candidate in $unmarked) {
    $legacyLabels = @($candidate.labels)
    $state = $null
    $reason = $null
    $ruleId = $null
    $add = @()
    if ($legacyLabels -contains 'blocked' -or $legacyLabels -contains 'blocker') {
        $state = 'factory:blocked'
        $reason = 'legacy blocked marker'
        $ruleId = 'legacy_blocked_marker'
    } elseif ($legacyLabels -contains 'needs-decomp' -or $legacyLabels -contains 'needs-decomposition') {
        $state = 'factory:needs-plan'
        $reason = 'legacy decomposition marker'
        $ruleId = 'legacy_decomposition_marker'
        $add += 'complexity:large'
    } elseif ($candidate.typeHint) {
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
$result = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    workingDirectory = (Get-Location).Path
    outputPath = $resolvedOutputPath
    limit = $Limit
    candidates = $remainingCandidates
    resolved = $resolved
    staged = $staged
    classificationMetrics = [ordered]@{
        eligibleIssues = @($unmarked).Count
        deterministicRuleHits = @($resolved).Count
        ambiguousIssues = [Math]::Max(0, @($unmarked).Count - @($resolved).Count)
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
