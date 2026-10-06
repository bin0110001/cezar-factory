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

# Use the installed script beside this one, not FACTORY_RUNTIME_ROOT. The
# latter is only available to Cezar check steps and was absent in the pilot.
$labelArgs = @{ GhCommand = $GhCommand }
if ($Repo) { $labelArgs.Repo = $Repo }
if ($DryRun) { $labelArgs.DryRun = $true }
& (Join-Path $PSScriptRoot 'create-labels.ps1') @labelArgs

$factoryMarkers = @('factory:new', 'factory:needs-plan', 'factory:needs-help', 'factory:ready', 'factory:working', 'factory:review', 'factory:changes-requested', 'factory:human-review', 'factory:blocked', 'factory:done', 'factory:investigate', 'factory:auditing', 'factory:tracking')
$search = 'is:open ' + (($factoryMarkers | ForEach-Object { "-label:`"$_`"" }) -join ' ')
$raw = Invoke-Gh @('issue', 'list', '--state', 'open', '--search', $search, '--limit', [string]$Limit, '--json', 'number,title,labels')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$candidates = @($issues |
    Where-Object {
        $names = @($_.labels | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.name } })
        -not ($names | Where-Object { $_ -like 'factory:*' })
    } |
    Sort-Object number |
    Select-Object -First $Limit |
    ForEach-Object {
        $labels = @($_.labels | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.name } })
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

# Reserve every fetched candidate before the model sees it. This makes the
# update durable even if the agent later fails, and makes a subsequent run
# exclude the issue. This is an audit marker, never a human-escalation state.
$staged = @()
foreach ($candidate in $candidates) {
    if (-not $DryRun) { Invoke-Gh @('issue', 'edit', [string]$candidate.number, '--add-label', 'factory:auditing') | Out-Null }
    $staged += [ordered]@{ issue = $candidate.number; added = @('factory:auditing') }
}

$result = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    limit = $Limit
    candidates = $candidates
    staged = $staged
    terminalReason = if ($candidates.Count) { 'candidates-staged' } else { 'no-unmarked-open-issues' }
}
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 6 | Set-Content -NoNewline $OutputPath
$result | ConvertTo-Json -Depth 6
