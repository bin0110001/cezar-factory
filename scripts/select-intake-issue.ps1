#!/usr/bin/env pwsh
<##
.SYNOPSIS
Selects the issue named by an event task, or the oldest eligible issue for scheduled intake.

.DESCRIPTION
Fetches eligible issues once. Event-triggered intake selects the issue named by
-Task; scheduled intake selects the oldest eligible issue. Writes the selected
issue (or a no-work result) to a bounded worktree-local artifact. The intake
workflow consumes this artifact; issue discovery does not happen in the skill.
##>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo,
    [string]$Task = '',
    [string]$OutputPath = '.factory/intake-issue.json'
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

$excluded = @('factory:blocked', 'factory:needs-plan', 'factory:working', 'factory:needs-help', 'factory:tracking')
$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', 'is:open label:"factory:new"', '--limit', '1000', '--json', 'number,title,body,url,createdAt,labels')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$targetIssue = $null
if (-not [string]::IsNullOrWhiteSpace($Task)) {
    $match = [regex]::Match($Task, '(?i)https?://github\.com/[^/\s]+/[^/\s]+/issues/(?<number>\d+)')
    if (-not $match.Success) { $match = [regex]::Match($Task, '(?i)\bissue\s+#(?<number>\d+)\b') }
    if (-not $match.Success) { throw 'The intake task must identify its GitHub issue by URL or issue number.' }
    $targetIssue = [int]$match.Groups['number'].Value
}
$eligible = @($issues | Where-Object {
    $labels = @(Get-LabelNames $_)
    $types = @($labels | Where-Object { $_ -like 'type:*' })
    $risks = @($labels | Where-Object { $_ -like 'risk:*' })
    ($labels -contains 'factory:new') -and
    ($labels -notcontains 'epic') -and
    @($excluded | Where-Object { $labels -contains $_ }).Count -eq 0 -and
    $types.Count -eq 1 -and $risks.Count -eq 1
} | Sort-Object @{ Expression = { [DateTimeOffset]::Parse([string]$_.createdAt) } }, @{ Expression = { [int]$_.number } })

$selectedIssue = if ($null -ne $targetIssue) {
    @($eligible | Where-Object { [int]$_.number -eq $targetIssue } | Select-Object -First 1)
} else {
    @($eligible | Select-Object -First 1)
}
$selected = if ($selectedIssue.Count) {
    $issue = $selectedIssue[0]
    [ordered]@{
        issue = [int]$issue.number
        title = [string]$issue.title
        body = [string]$issue.body
        url = [string]$issue.url
        createdAt = [string]$issue.createdAt
        labels = @(Get-LabelNames $issue)
        terminalReason = if ($null -ne $targetIssue) { 'selected-triggered-issue' } else { 'selected-oldest-eligible-issue' }
    }
} else {
    [ordered]@{
        issue = $null
        title = $null
        body = $null
        url = $null
        createdAt = $null
        labels = @()
        terminalReason = 'no-eligible-open-factory-new-issues'
    }
}

$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$selected | ConvertTo-Json -Depth 6 | Set-Content -NoNewline $OutputPath
$selected | ConvertTo-Json -Depth 6
