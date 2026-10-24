#!/usr/bin/env pwsh
<#
.SYNOPSIS
Collects a read-only, compact GitHub snapshot for the deterministic backlog reconciler.
#>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$OutputPath = '.factory/github-issues.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $global:LASTEXITCODE = 0
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output -join "`n"
}

function Get-LabelNames($Issue) {
    @($Issue.labels | ForEach-Object {
        if ($_ -is [string]) { [string]$_ } else { [string]$_.name }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-Dependencies([string]$Body) {
    $numbers = [System.Collections.Generic.List[int]]::new()
    foreach ($line in ($Body -split "`r?`n")) {
        if ($line -match '(?i)\bdependenc(?:y|ies)\b|\bdepends\s+on\b') {
            foreach ($match in [regex]::Matches($line, '#(?<number>\d+)')) {
                $number = [int]$match.Groups['number'].Value
                if (-not $numbers.Contains($number)) { $numbers.Add($number) }
            }
        }
    }
    @($numbers)
}

function Get-Lease($Issue, [int]$Number) {
    $marker = "<!-- factory-lease:$Number -->"
    $comments = @($Issue.comments)
    for ($index = $comments.Count - 1; $index -ge 0; $index--) {
        $body = [string]$comments[$index].body
        if ($body -notlike "*$marker*") { continue }
        $suffix = ($body -split [regex]::Escape($marker), 2)[1].Trim()
        if ($suffix.StartsWith('{')) {
            try { return ($suffix | ConvertFrom-Json -ErrorAction Stop) }
            catch { throw "Malformed Factory lease marker on issue #$Number; refusing an incomplete backlog snapshot." }
        }
        $owner = [regex]::Match($suffix, '(?m)^lease-owner:(?<value>.+?)\s*$')
        $expiry = [regex]::Match($suffix, '(?m)^lease-expires:(?<value>.+?)\s*$')
        if (-not $owner.Success -or -not $expiry.Success) {
            throw "Malformed Factory lease marker on issue #$Number; refusing an incomplete backlog snapshot."
        }
        return [pscustomobject]@{ issue = $Number; owner = $owner.Groups['value'].Value; expiresAt = $expiry.Groups['value'].Value; releasedAt = $null }
    }
    $null
}

$allIssues = @(Invoke-Gh @('issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state,labels,createdAt,body,comments') | ConvertFrom-Json)
if ($allIssues.Count -ge 1000) {
    throw 'GitHub issue snapshot reached the 1000-item cap; refusing to emit a partial backlog proposal.'
}
$byNumber = @{}
foreach ($issue in $allIssues) { $byNumber[[string]$issue.number] = $issue }

$open = @($allIssues | Where-Object { $_.state -eq 'OPEN' } | ForEach-Object {
    $labels = @(Get-LabelNames $_)
    $states = @($labels | Where-Object { $_ -in @('factory:new','factory:needs-plan','factory:needs-help','factory:ready','factory:working','factory:review','factory:changes-requested','factory:human-review','factory:blocked','factory:done','factory:investigate') })
    $priorityLabels = @($labels | ForEach-Object {
        if ($_ -match '^priority:(?<value>-?\d+)$') { [int]$Matches.value }
    })
    $dependencies = @(Get-Dependencies ([string]$_.body))
    $dependenciesReady = $true
    foreach ($dependency in $dependencies) {
        $dependencyIssue = $byNumber[[string]$dependency]
        if (-not $dependencyIssue -or $dependencyIssue.state -ne 'CLOSED') { $dependenciesReady = $false; break }
    }
    $state = if ($states.Count -eq 1) { $states[0] } else { '' }
    [ordered]@{
        number = [int]$_.number
        labels = $labels
        priority = if ($priorityLabels.Count) { [int](($priorityLabels | Measure-Object -Maximum).Maximum) } else { 0 }
        dependenciesReady = $dependenciesReady
        createdAt = ([DateTimeOffset]$_.createdAt).ToUniversalTime().ToString('o')
        blocked = ($state -eq 'factory:blocked' -or $labels -contains 'blocked' -or $labels -contains 'blocker')
        openHumanGate = ($state -eq 'factory:human-review' -or $state -eq 'factory:needs-help')
        lease = Get-Lease $_ ([int]$_.number)
    }
})

$result = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    repository = if ($Repo) { $Repo } else { (Invoke-Gh @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')).Trim() }
    issues = $open
}
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Collected $($open.Count) open issues into $([IO.Path]::GetFullPath($OutputPath))"
