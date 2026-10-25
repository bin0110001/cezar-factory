#!/usr/bin/env pwsh
<##
.SYNOPSIS
Releases expired backlog-label audit reservations after confirming no matching Cezar run is active.

.DESCRIPTION
`factory:auditing` is a temporary reservation, not a runnable lifecycle state. If a
maintenance run is cancelled after reserving an issue, this script removes only the
expired reservation so the next bounded audit can reconsider it. It never classifies
an issue or makes work implementation-ready.
#>
[CmdletBinding()]
param(
    [ValidateRange(15, 1440)][int]$OlderThanMinutes = 90,
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$ApiUrl = $(if ($env:CEZAR_API_URL) { $env:CEZAR_API_URL } else { 'http://127.0.0.1:4321' }),
    [string]$ProjectId = $env:CEZAR_PROJECT_ID,
    [string]$OutputPath = '.factory/audit-reservation-recovery.json',
    [switch]$DryRun,
    [switch]$SkipRunCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ProjectId -and (Get-Location).Path -match '^(?<root>.+)[\\/]\.ai[\\/]cezar[\\/]worktrees[\\/][^\\/]+$') {
    # Cezar's registered project root is the parent of its isolated worktree.
    # Its leaf is the Cezar project slug; check steps do not receive a project ID env var.
    $ProjectId = (Split-Path $Matches.root -Leaf).ToLowerInvariant()
}
$now = [DateTimeOffset]::UtcNow
$cutoff = $now.AddMinutes(-$OlderThanMinutes)
$lifecycle = @('factory:new','factory:needs-plan','factory:needs-help','factory:ready','factory:working','factory:review','factory:changes-requested','factory:human-review','factory:blocked','factory:done','factory:investigate')
$reservationPrefix = '<!-- factory-audit-reservation:'

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}

function Get-LabelNames($Issue) {
    @($Issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } } | Where-Object { $_ })
}

function Get-Reservation($IssueNumber) {
    $raw = Invoke-Gh @('issue','view',[string]$IssueNumber,'--json','comments')
    $view = ($raw -join "`n") | ConvertFrom-Json
    $comments = @($view.comments)
    for ($i = $comments.Count - 1; $i -ge 0; $i--) {
        $body = [string]$comments[$i].body
        $start = $body.IndexOf($reservationPrefix + $IssueNumber + ' -->')
        if ($start -lt 0) { continue }
        $json = $body.Substring($start + ($reservationPrefix + $IssueNumber + ' -->').Length).Trim()
        try { return ($json | ConvertFrom-Json) } catch { return [pscustomobject]@{ malformed = $true } }
    }
    return $null
}

function Get-ActiveIssueNumbers {
    if ($SkipRunCheck) { return @() }
    if ([string]::IsNullOrWhiteSpace($ApiUrl) -or [string]::IsNullOrWhiteSpace($ProjectId)) {
        throw 'Cannot verify active Cezar runs: ApiUrl and ProjectId are required unless -SkipRunCheck is used.'
    }
    $base = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
    $payload = Invoke-RestMethod -UseBasicParsing "$base/runs"
    $runs = if ($payload.PSObject.Properties.Name -contains 'runs') { @($payload.runs) } else { @($payload) }
    $active = @('queued','starting','running','pending')
    $numbers = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($run in $runs) {
        if ([string]$run.status -notin $active) { continue }
        $number = 0
        $properties = @($run.PSObject.Properties.Name)
        if ($properties -contains 'issue' -and $run.issue) { $number = [int]$run.issue }
        elseif ($properties -contains 'issueNumber' -and $run.issueNumber) { $number = [int]$run.issueNumber }
        elseif ($properties -contains 'metadata' -and $run.metadata -and @($run.metadata.PSObject.Properties.Name) -contains 'issue' -and $run.metadata.issue) { $number = [int]$run.metadata.issue }
        if ($number -gt 0) { [void]$numbers.Add($number) }
    }
    return @($numbers)
}

function Add-Comment([int]$IssueNumber, [string]$Body) {
    $temp = Join-Path ([IO.Path]::GetTempPath()) "factory-audit-recovery-$([guid]::NewGuid()).md"
    try { $Body | Set-Content -NoNewline $temp; Invoke-Gh @('issue','comment',[string]$IssueNumber,'--body-file',$temp) | Out-Null }
    finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

$activeIssues = Get-ActiveIssueNumbers
$raw = Invoke-Gh @('issue','list','--state','open','--limit','1000','--json','number,title,updatedAt,labels,url')
$issues = @($raw -join "`n" | ConvertFrom-Json)
$recovered = @(); $skipped = @()
foreach ($issue in $issues) {
    $labels = @(Get-LabelNames $issue)
    if ($labels -notcontains 'factory:auditing') { continue }
    $states = @($labels | Where-Object { $lifecycle -contains $_ })
    if ($states.Count) { $skipped += [ordered]@{ issue = [int]$issue.number; reason = 'competing-lifecycle-state' }; continue }
    if ($activeIssues -contains [int]$issue.number) { $skipped += [ordered]@{ issue = [int]$issue.number; reason = 'active-cezar-run' }; continue }
    $reservation = Get-Reservation ([int]$issue.number)
    $expired = $false; $reason = 'stale-without-reservation-marker'
    if ($reservation -and @($reservation.PSObject.Properties.Name) -contains 'malformed' -and $reservation.malformed) { $skipped += [ordered]@{ issue = [int]$issue.number; reason = 'malformed-reservation-marker' }; continue }
    if ($reservation -and $reservation.expiresAt) {
        $expired = [DateTimeOffset]::Parse([string]$reservation.expiresAt) -le $now
        $reason = 'reservation-expired'
    } else {
        $expired = [DateTimeOffset]::Parse([string]$issue.updatedAt) -le $cutoff
    }
    if (-not $expired) { $skipped += [ordered]@{ issue = [int]$issue.number; reason = 'reservation-still-fresh' }; continue }
    if (-not $DryRun) {
        Invoke-Gh @('issue','edit',[string]$issue.number,'--remove-label','factory:auditing') | Out-Null
        Add-Comment ([int]$issue.number) "<!-- factory-audit-recovery:$($issue.number) -->`nFactory released an expired ``factory:auditing`` reservation ($reason). The next bounded maintenance audit may reconsider this issue."
    }
    $recovered += [ordered]@{ issue = [int]$issue.number; action = if ($DryRun) { 'would-release' } else { 'released' }; reason = $reason }
}

$result = [ordered]@{ generatedAt = $now.ToString('o'); cutoff = $cutoff.ToString('o'); olderThanMinutes = $OlderThanMinutes; dryRun = [bool]$DryRun; activeRunCheck = -not [bool]$SkipRunCheck; recovered = $recovered; skipped = $skipped; terminalReason = if ($recovered.Count) { 'expired-reservations-released' } else { 'no-expired-reservations' } }
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$result | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
$result | ConvertTo-Json -Depth 8
