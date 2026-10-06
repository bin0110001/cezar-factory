#!/usr/bin/env pwsh
<#
.SYNOPSIS
Builds the bounded input for the legacy backlog-label audit.

.DESCRIPTION
Ensures the Factory taxonomy exists, then fetches only open issues that do not
already have a Factory label. A Factory label is the durable audit marker: the
agent must put one on every candidate it considers, including skipped work.
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

# Use the installed script beside this one, not FACTORY_RUNTIME_ROOT. The
# latter is only available to Cezar check steps and was absent in the pilot.
$labelArgs = @{ GhCommand = $GhCommand }
if ($Repo) { $labelArgs.Repo = $Repo }
if ($DryRun) { $labelArgs.DryRun = $true }
& (Join-Path $PSScriptRoot 'create-labels.ps1') @labelArgs

$factoryMarkers = @('factory:new', 'factory:needs-plan', 'factory:needs-help', 'factory:ready', 'factory:working', 'factory:review', 'factory:changes-requested', 'factory:human-review', 'factory:blocked', 'factory:done', 'factory:investigate', 'factory:auditing', 'factory:tracking')
$search = 'is:open ' + (($factoryMarkers | ForEach-Object { "-label:`"$_`"" }) -join ' ')
$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', $search, '--limit', '1000', '--json', 'number,title,labels')
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
            typeHint = $typeHint
            riskHint = $riskHint
        }
    })

# Close every classification that can be made entirely from existing labels
# before handing anything to an agent. The LLM limit applies only to the
# ambiguous remainder; it must never prevent static normalization of later
# issues in the fetched backlog.
$resolved = @()
$remainingCandidates = @()
$staged = @()
foreach ($candidate in $unmarked) {
    $legacyLabels = @($candidate.labels)
    $state = $null
    $reason = $null
    $add = @()
    if ($legacyLabels -contains 'blocked' -or $legacyLabels -contains 'blocker') {
        $state = 'factory:blocked'
        $reason = 'legacy blocked marker'
    } elseif ($legacyLabels -contains 'needs-decomp' -or $legacyLabels -contains 'needs-decomposition') {
        $state = 'factory:needs-plan'
        $reason = 'legacy decomposition marker'
        $add += 'complexity:large'
    } elseif ($candidate.typeHint) {
        $state = 'factory:new'
        $reason = 'unambiguous legacy type marker'
    }

    if ($state) {
        $add += $state
        if ($candidate.typeHint) { $add += "type:$($candidate.typeHint)" }
        if ($candidate.riskHint) { $add += "risk:$($candidate.riskHint)" }
        $add = @($add | Select-Object -Unique)
        if (-not $DryRun) { Invoke-Gh (@('issue', 'edit', [string]$candidate.number) + ($add | ForEach-Object { @('--add-label', $_) })) | Out-Null }
        $resolved += [ordered]@{ issue = $candidate.number; added = $add; reason = $reason }
        continue
    }

    # Reservation is only for genuinely ambiguous items. The LLM receives
    # only the first requested number of unresolved issues.
    if ($remainingCandidates.Count -ge $Limit) { continue }
    if (-not $DryRun) { Invoke-Gh @('issue', 'edit', [string]$candidate.number, '--add-label', 'factory:auditing') | Out-Null }
    $staged += [ordered]@{
        issue = $candidate.number
        added = @('factory:auditing')
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
    unreviewedAmbiguousCount = [Math]::Max(0, @($unmarked).Count - @($resolved).Count - @($remainingCandidates).Count)
    terminalReason = if ($remainingCandidates.Count) { 'candidates-staged' } elseif ($resolved.Count) { 'candidates-resolved' } else { 'no-unmarked-open-issues' }
}
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 6 | Set-Content -NoNewline $OutputPath
$result | ConvertTo-Json -Depth 6
