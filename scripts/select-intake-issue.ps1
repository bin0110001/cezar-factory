#!/usr/bin/env pwsh
<##
.SYNOPSIS
Selects one existing open Factory issue for scheduled intake.

.DESCRIPTION
Fetches eligible issues once, orders them oldest first, and writes the selected
issue (or a no-work result) to a bounded worktree-local artifact. The intake
workflow consumes this artifact; issue discovery does not happen in the skill.
##>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo,
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

$excluded = @('factory:blocked', 'factory:needs-plan', 'factory:working', 'factory:needs-help')
$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', 'is:open label:"factory:new"', '--limit', '1000', '--json', 'number,title,body,url,createdAt,labels')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$eligible = @($issues | Where-Object {
    $labels = @(Get-LabelNames $_)
    ($labels -contains 'factory:new') -and @($excluded | Where-Object { $labels -contains $_ }).Count -eq 0
} | Sort-Object @{ Expression = { [DateTimeOffset]::Parse([string]$_.createdAt) } }, @{ Expression = { [int]$_.number } })

$selected = if ($eligible.Count) {
    $issue = $eligible[0]
    [ordered]@{
        issue = [int]$issue.number
        title = [string]$issue.title
        body = [string]$issue.body
        url = [string]$issue.url
        createdAt = [string]$issue.createdAt
        labels = @(Get-LabelNames $issue)
        terminalReason = 'selected-oldest-eligible-issue'
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
