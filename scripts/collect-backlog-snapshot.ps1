#!/usr/bin/env pwsh
<#
.SYNOPSIS
Collects a read-only, compact GitHub snapshot for the deterministic backlog reconciler.
#>
[CmdletBinding()]
param(
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$OutputPath = '.factory/github-issues.json',
    # A single truncated or throttled GitHub response ("unexpected end of JSON input") must not fail the health canary and roll
    # back a promotion, so a failed gh call is retried a bounded number of times before the script gives up.
    [ValidateRange(1, 5)][int]$Attempts = 3,
    [ValidateRange(0, 60)][int]$RetryDelaySeconds = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    for ($try = 1; $try -le $Attempts; $try++) {
        $global:LASTEXITCODE = 0
        $output = & $GhCommand @all 2>&1
        if ($LASTEXITCODE -eq 0) { return ($output -join "`n") }
        if ($try -ge $Attempts) { throw "gh $($all -join ' ') failed ($LASTEXITCODE) after $Attempts attempt(s): $($output -join "`n")" }
        Start-Sleep -Seconds ($RetryDelaySeconds * $try)
    }
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

# Two queries instead of one `--state all` listing with every body and comment: only OPEN issues use their labels, body and
# comments (leases), while closed issues are read solely for their state (dependency checks). Pulling the comment threads of
# every closed issue made the snapshot ~2.5 MB for ~200 issues, and the host's gh returned it truncated ("unexpected end of
# JSON input") often enough to fail the health canary and roll back promotions.
$openIssues = @(Invoke-Gh @('issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,state,labels,createdAt,body,comments') | ConvertFrom-Json)
$closedIssues = @(Invoke-Gh @('issue', 'list', '--state', 'closed', '--limit', '1000', '--json', 'number,state') | ConvertFrom-Json)
if ($openIssues.Count -ge 1000 -or $closedIssues.Count -ge 1000) {
    throw 'GitHub issue snapshot reached the 1000-item cap; refusing to emit a partial backlog proposal.'
}
$allIssues = @($closedIssues) + @($openIssues)  # open entries win in $byNumber below
$byNumber = @{}
foreach ($issue in $allIssues) { $byNumber[[string]$issue.number] = $issue }

$open = @($openIssues | Where-Object { $_.state -eq 'OPEN' } | ForEach-Object {
    $labels = @(Get-LabelNames $_)
    $states = @($labels | Where-Object { $_ -in @('factory:new','factory:needs-plan','factory:needs-help','factory:ready','factory:working','factory:review','factory:changes-requested','factory:human-review','factory:blocked','factory:done','factory:investigate','factory:implemented','factory:pr-open') })
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
