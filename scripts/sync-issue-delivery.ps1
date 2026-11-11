#!/usr/bin/env pwsh
<##
.SYNOPSIS
Reflects pull-request progress on the issues they reference, so each issue shows where it is.

.DESCRIPTION
Delivery stages, in order: `factory:working` -> `factory:implemented` (finished on a pushed
branch, no PR; set by whoever finishes) -> `factory:pr-open` (this step) -> closed with
`factory:done` (this step). Factory-run PRs use `factory:review` for the open-PR stage, which
this step leaves alone.

Open pass: a non-draft PR into the integration branch that references an issue with a closing
keyword moves that issue to `factory:pr-open`, but only from a pre-PR state (new, needs-plan,
ready, working, implemented, or no state). States that mean something else (review,
changes-requested, blocked, human-review, needs-help, investigate, done) are never overwritten.

Merged pass: GitHub only honours "Closes #N" when a PR merges into the repository's default
branch, and Factory PRs merge into `dev`, so the keyword never fires. This step closes each
still-open referenced issue as completed with `factory:done` and a comment naming the PR.

Guards: epics/tracking issues (`factory:tracking`) are never touched; an issue this step already
closed and a person reopened is left open; at most -MaxCloses issues close per run; one failure
is recorded without stopping the others. Idempotent, so the next scheduled run retries failures.
#>
[CmdletBinding()]
param(
    [string]$BaseBranch = 'dev',
    [ValidateRange(1, 200)][int]$PrLimit = 50,
    [ValidateRange(1, 365)][int]$LookbackDays = 14,
    [ValidateRange(1, 100)][int]$MaxCloses = 25,
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$OutputPath = '.factory/sync-issue-delivery.json',
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gh-cache.ps1')

$stateLabels = @('factory:new', 'factory:needs-plan', 'factory:needs-help', 'factory:ready', 'factory:working', 'factory:review', 'factory:changes-requested', 'factory:human-review', 'factory:blocked', 'factory:investigate', 'factory:implemented', 'factory:pr-open')
$prePrStates = @('factory:new', 'factory:needs-plan', 'factory:ready', 'factory:working', 'factory:implemented')
$closingPattern = '(?im)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b'

function Invoke-Gh([string[]]$Arguments) {
    $full = if ($Repo) { $Arguments + @('--repo', $Repo) } else { $Arguments }
    $output = & $GhCommand @full 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($Arguments -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    if ($null -eq $output) { return '' }
    [string]::Join("`n", [string[]]$output)
}

function Get-ClosingReferences([string]$Text) {
    # Ignore fenced code and HTML comments so quoted templates and examples do not close anything.
    $clean = [regex]::Replace($Text, '(?s)```.*?```|<!--.*?-->', '')
    @([regex]::Matches($clean, $closingPattern) | ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
}

function Set-IssueStateLabel([int]$Number, [string[]]$Labels, [string]$Desired) {
    $remove = @($Labels | Where-Object { $stateLabels -contains $_ -and $_ -ne $Desired })
    $edit = @('issue', 'edit', [string]$Number)
    if ($Labels -notcontains $Desired) { $edit += @('--add-label', $Desired) }
    if ($remove.Count) { $edit += @('--remove-label', ($remove -join ',')) }
    if ($edit.Count -gt 3) { Invoke-Gh $edit | Out-Null; $script:mutated = $true }
}

function Get-DeliveryMap($PullRequests) {
    # The first PR to reference an issue is its delivery record.
    $map = [ordered]@{}
    foreach ($pr in $PullRequests) {
        foreach ($n in (Get-ClosingReferences ([string]$pr.title + "`n" + [string]$pr.body))) {
            if (-not $map.Contains([string]$n)) { $map[[string]$n] = $pr }
        }
    }
    $map
}

$since = [DateTimeOffset]::UtcNow.AddDays(-$LookbackDays)
$merged = @((Invoke-Gh @('pr', 'list', '--state', 'merged', '--base', $BaseBranch, '--limit', [string]$PrLimit, '--json', 'number,title,body,mergedAt,url')) | ConvertFrom-Json | Where-Object { $_ })
$merged = @($merged | Where-Object { $_.mergedAt -and [DateTimeOffset]::Parse([string]$_.mergedAt) -ge $since } | Sort-Object { [DateTimeOffset]::Parse([string]$_.mergedAt) })
$open = @((Invoke-Gh @('pr', 'list', '--state', 'open', '--base', $BaseBranch, '--limit', [string]$PrLimit, '--json', 'number,title,body,url,isDraft')) | ConvertFrom-Json | Where-Object { $_ })
$open = @($open | Where-Object { -not $_.isDraft } | Sort-Object { [int]$_.number })

$mergedBy = Get-DeliveryMap $merged
$openBy = Get-DeliveryMap $open

$mutated = $false

if (-not $DryRun -and ($mergedBy.Count -or $openBy.Count)) {
    # gh refuses to add a label that does not exist. One listing finds which are missing, so a run
    # with nothing to create makes one call instead of four; creating is idempotent with --force.
    $existingLabels = $null
    try { $existingLabels = @((Invoke-Gh @('label', 'list', '--limit', '200', '--json', 'name') | ConvertFrom-Json) | ForEach-Object { [string]$_.name }) } catch { Write-Warning "Could not list labels: $($_.Exception.Message)" }
    foreach ($label in @(
        @('factory:pr-open', '1d76db', 'Factory: PR open against dev, awaiting merge'),
        @('factory:done', '1d76db', 'Factory: complete'),
        @('factory:implemented', '1d76db', 'Factory: work complete on a pushed branch, no PR yet'),
        @('factory:interactive', '6f42c1', 'Factory: worked in a local dev window; automations and stale sweeps skip it'))) {
        if ($null -ne $existingLabels -and $existingLabels -contains $label[0]) { continue }
        try { Invoke-Gh @('label', 'create', $label[0], '--color', $label[1], '--description', $label[2], '--force') | Out-Null } catch { Write-Warning "Could not ensure label $($label[0]): $($_.Exception.Message)" }
    }
}

# Every referenced issue used to cost one `gh issue view`, including the many already closed by an
# earlier run. One open-issue listing (shared with the other maintenance scripts through
# gh-cache.ps1) answers "is it still open, and with which labels" for all of them; only an open
# issue that may have been closed by a merge needs its comments read. This script runs first and
# mutates, so it always reads fresh. A listing that hit its limit may be missing open issues, so
# then an absent issue is looked up directly.
$openIssues = @{}
$openListComplete = $false
if ($mergedBy.Count -or $openBy.Count) {
    try {
        $listArguments = @('issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,createdAt,updatedAt,labels,url')
        $openList = @((Get-GhCachedText "$GhCommand|$Repo|$($listArguments -join ' ')" { Invoke-Gh $listArguments } -Refresh) | ConvertFrom-Json | Where-Object { $_ })
        foreach ($listed in $openList) { $openIssues[[string]$listed.number] = $listed }
        $openListComplete = $openList.Count -lt 1000
    } catch { Write-Warning "Could not list open issues; reading each referenced issue directly: $($_.Exception.Message)" }
}

function Get-OpenIssueLabels([int]$Number) {
    # $null: the issue is closed (or unknown). Otherwise its label names.
    $listed = $openIssues[[string]$Number]
    # The comma keeps an empty label set an empty array instead of unrolling to $null ("closed").
    if ($null -ne $listed) { return , @($listed.labels | ForEach-Object { [string]$_.name }) }
    if ($openListComplete) { return $null }
    $issue = Invoke-Gh @('issue', 'view', [string]$Number, '--json', 'state,labels') | ConvertFrom-Json
    if ($issue.state -ne 'OPEN') { return $null }
    , @($issue.labels | ForEach-Object { [string]$_.name })
}

$promoted = @(); $closed = @(); $skipped = @(); $errors = @()

foreach ($key in @($openBy.Keys)) {
    $n = [int]$key; $pr = $openBy[$key]
    if ($mergedBy.Contains($key)) { continue }
    try {
        $labels = Get-OpenIssueLabels $n
        if ($null -eq $labels) { continue }
        if ($labels -contains 'factory:tracking') { $skipped += [ordered]@{ issue = $n; pr = [int]$pr.number; reason = 'tracking-issue' }; continue }
        $states = @($labels | Where-Object { $stateLabels -contains $_ })
        if ($states -contains 'factory:pr-open') { continue }
        if ($states.Count -and @($states | Where-Object { $prePrStates -notcontains $_ }).Count) { continue }
        if (-not $DryRun) { Set-IssueStateLabel $n $labels 'factory:pr-open' }
        $promoted += [ordered]@{ issue = $n; pr = [int]$pr.number; from = @($states) }
    }
    catch {
        $errors += [ordered]@{ issue = $n; pr = [int]$pr.number; error = $_.Exception.Message }
        Write-Warning "Could not mark issue #${n} PR-open: $($_.Exception.Message)"
    }
}

foreach ($key in @($mergedBy.Keys)) {
    $n = [int]$key; $pr = $mergedBy[$key]
    try {
        $labels = Get-OpenIssueLabels $n
        if ($null -eq $labels) { continue }
        if ($labels -contains 'factory:tracking') { $skipped += [ordered]@{ issue = $n; pr = [int]$pr.number; reason = 'tracking-issue' }; continue }
        # Only an open, non-tracking issue needs its comments (to honour a person's reopen).
        $issue = Invoke-Gh @('issue', 'view', [string]$n, '--json', 'state,labels,comments,title') | ConvertFrom-Json
        if ($issue.state -ne 'OPEN') { continue }
        $labels = @($issue.labels | ForEach-Object { [string]$_.name })
        $marker = "<!-- factory-closed-by-merge:$n -->"
        if (@($issue.comments | Where-Object { ([string]$_.body).Contains($marker) }).Count) {
            $skipped += [ordered]@{ issue = $n; pr = [int]$pr.number; reason = 'reopened-after-factory-close' }; continue
        }
        if ($closed.Count -ge $MaxCloses) { $skipped += [ordered]@{ issue = $n; pr = [int]$pr.number; reason = 'max-closes-reached' }; continue }
        if ($DryRun) { $closed += [ordered]@{ issue = $n; pr = [int]$pr.number; dryRun = $true }; continue }

        Set-IssueStateLabel $n $labels 'factory:done'
        $body = "$marker`nDelivered by $($pr.url), merged into ``$BaseBranch`` at $($pr.mergedAt). Closed automatically because GitHub only closes issues on merges to the default branch. Reopen this issue if the work is incomplete."
        Invoke-Gh @('issue', 'close', [string]$n, '--reason', 'completed', '--comment', $body) | Out-Null
        $script:mutated = $true
        $closed += [ordered]@{ issue = $n; pr = [int]$pr.number }
    }
    catch {
        $errors += [ordered]@{ issue = $n; pr = [int]$pr.number; error = $_.Exception.Message }
        Write-Warning "Could not close issue #${n}: $($_.Exception.Message)"
    }
}

if ($mutated) { Clear-GhCache }

$result = [ordered]@{
    status = if ($errors.Count) { 'partial' } else { 'ok' }
    baseBranch = $BaseBranch
    mergedPullRequests = $merged.Count
    openPullRequests = $open.Count
    promoted = $promoted
    closed = $closed
    skipped = $skipped
    errors = $errors
}
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$json = $result | ConvertTo-Json -Depth 6
Set-Content -NoNewline -LiteralPath $OutputPath -Value $json
$json
