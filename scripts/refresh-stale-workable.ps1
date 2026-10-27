#!/usr/bin/env pwsh
<##
.SYNOPSIS
Retriggers a small batch of old, executable Factory issues.

.DESCRIPTION
Finds open issues older than the configured age with exactly one executable Factory
lifecycle state. Manual-gate, blocked, working, done, malformed, and unroutable issues
are excluded. For each selected issue, the lifecycle label is removed and then added
again in separate GitHub edits; the add emits the issue.labeled event consumed by Cezar.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 100)][int]$Limit = 2,
    [ValidateRange(1, 8760)][int]$OlderThanHours = 24,
    [string]$GhCommand = 'gh',
    [string]$Repo = '',
    [string]$OutputPath = '.factory/stale-workable-refresh.json',
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workableStates = @(
    'factory:new',
    'factory:needs-plan',
    'factory:ready',
    'factory:review',
    'factory:changes-requested',
    'factory:investigate'
)
$manualOrTerminalStates = @(
    'factory:needs-help',
    'factory:working',
    'factory:human-review',
    'factory:blocked',
    'factory:done'
)
$complexityLabels = @('complexity:small', 'complexity:medium', 'complexity:large')
$PendingPath = "$OutputPath.pending.json"

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")"
    }
    $output
}

function Get-LabelNames($Issue) {
    @($Issue.labels | ForEach-Object {
        if ($_ -is [string]) { [string]$_ } else { [string]$_.name }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Write-Result($Result) {
    Write-JsonAtomic $Result $OutputPath
    $Result | ConvertTo-Json -Depth 8
}

function Write-JsonAtomic($Value, [string]$Path) {
    $directory = Split-Path -Parent $Path
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Get-LiveIssue([int]$IssueNumber) {
    $raw = Invoke-Gh @('issue', 'view', [string]$IssueNumber, '--json', 'number,state,updatedAt,labels')
    ($raw -join "`n") | ConvertFrom-Json -DateKind String
}

function Get-NormalizedLabelKey([string[]]$Labels) {
    (@($Labels | Sort-Object -Unique) -join "`n")
}

function Complete-PendingRefresh($Pending, [bool]$AllowUnstartedRetry) {
    $action = $Pending.action
    if (-not $action -or $action.schemaVersion -ne 1 -or $action.operation -ne 'github.issue.refresh_lifecycle') {
        throw 'pending refresh action has an invalid action contract'
    }
    $issueNumber = [int]$action.target.id
    $stateLabel = [string]$action.arguments.lifecycleState
    $expectedLabels = @($action.arguments.expectedLabels | ForEach-Object { [string]$_ })
    $withoutState = @($expectedLabels | Where-Object { $_ -ne $stateLabel })
    $live = Get-LiveIssue $issueNumber
    $labels = @(Get-LabelNames $live | Sort-Object -Unique)
    if ([string]$live.state -ne 'OPEN') { throw "pending issue $issueNumber is no longer open; manual reconciliation required" }

    if ($Pending.phase -eq 'removing') {
        if ((Get-NormalizedLabelKey $labels) -eq (Get-NormalizedLabelKey $expectedLabels)) {
            if (-not $AllowUnstartedRetry) { throw "lifecycle removal for issue $issueNumber was not confirmed; pending action retained" }
            Invoke-Gh @('issue', 'edit', [string]$issueNumber, '--remove-label', $stateLabel) | Out-Null
            $live = Get-LiveIssue $issueNumber
            $labels = @(Get-LabelNames $live | Sort-Object -Unique)
        }
        if ((Get-NormalizedLabelKey $labels) -ne (Get-NormalizedLabelKey $withoutState)) {
            throw "issue $issueNumber labels changed during the pending lifecycle refresh; manual reconciliation required"
        }
        $Pending.phase = 'removed'
        Write-JsonAtomic $Pending $PendingPath
    }

    if ($Pending.phase -eq 'removed') {
        $labelKey = Get-NormalizedLabelKey $labels
        if ($labelKey -eq (Get-NormalizedLabelKey $withoutState)) {
            Invoke-Gh @('issue', 'edit', [string]$issueNumber, '--add-label', $stateLabel) | Out-Null
            $live = Get-LiveIssue $issueNumber
            $labels = @(Get-LabelNames $live | Sort-Object -Unique)
        }
        if ([string]$live.state -ne 'OPEN' -or (Get-NormalizedLabelKey $labels) -ne (Get-NormalizedLabelKey $expectedLabels)) {
            throw "issue $issueNumber lifecycle refresh did not reach its expected labels; pending action retained"
        }
        $Pending.phase = 'committed'
        $Pending.observedRevision = [DateTimeOffset]::Parse([string]$live.updatedAt).ToUniversalTime().ToString('o')
        $Pending.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Write-JsonAtomic $Pending $PendingPath
    }

    if ($Pending.phase -ne 'committed') { throw "pending action has unsupported phase '$($Pending.phase)'" }
    [ordered]@{ action = $action; status = 'committed'; observedRevision = $Pending.observedRevision; completedAt = $Pending.completedAt }
}

$cutoff = [DateTimeOffset]::UtcNow.AddHours(-$OlderThanHours)
$raw = Invoke-Gh @('issue','list','--state','open','--limit','1000','--json','number,title,createdAt,updatedAt,labels,url')
$issues = @($raw -join "`n" | ConvertFrom-Json -DateKind String)
$candidates = @()
$excluded = @()
$recentlyUpdatedCount = 0

foreach ($issue in $issues) {
    $labels = @(Get-LabelNames $issue)
    $states = @($labels | Where-Object { $_ -like 'factory:*' -and $_ -in ($workableStates + $manualOrTerminalStates) })
    $lastUpdated = $null
    try { $lastUpdated = [DateTimeOffset]::Parse([string]$issue.updatedAt) } catch { }
    $reason = $null
    if ($null -eq $lastUpdated) { $reason = 'missing-or-invalid-updated-at' }
    elseif ($lastUpdated -gt $cutoff) { $reason = 'recently-updated' }
    elseif ($states.Count -ne 1) { $reason = if ($states.Count -eq 0) { 'no-single-lifecycle-state' } else { 'multiple-lifecycle-states' } }
    elseif ($manualOrTerminalStates -contains $states[0]) { $reason = 'manual-or-terminal-state' }
    elseif ($labels -contains 'factory:auditing' -or $labels -contains 'factory:tracking') { $reason = 'audit-or-tracking-marker' }
    elseif ($states[0] -eq 'factory:ready' -and @($labels | Where-Object { $complexityLabels -contains $_ }).Count -ne 1) { $reason = 'ready-without-one-complexity-label' }

    if ($reason) {
        if ($reason -eq 'recently-updated') {
            $recentlyUpdatedCount++
        } else {
            $excluded += [ordered]@{ issue = [int]$issue.number; state = if ($states.Count) { $states -join ',' } else { $null }; reason = $reason }
        }
        continue
    }
    $candidates += [ordered]@{
        issue = [int]$issue.number
        title = [string]$issue.title
        url = [string]$issue.url
        state = [string]$states[0]
        createdAt = [string]$issue.createdAt
        updatedAt = $lastUpdated.ToUniversalTime().ToString('o')
        ageHours = [Math]::Round(([DateTimeOffset]::UtcNow - $lastUpdated).TotalHours, 1)
        labels = $labels
    }
}

$selected = @($candidates | Sort-Object @{ Expression = { [DateTimeOffset]::Parse($_.updatedAt) }; Ascending = $true }, issue | Select-Object -First $Limit)
$refreshed = @()
$failures = @()
$actionReceipts = @()
$pendingRecoveryBlocked = $false
$pendingRecoveryCompleted = $false
if (-not $DryRun -and (Test-Path -LiteralPath $PendingPath -PathType Leaf)) {
    $pending = $null
    try {
        $pending = Get-Content -LiteralPath $PendingPath -Raw | ConvertFrom-Json -AsHashtable
        $recoveredReceipt = Complete-PendingRefresh $pending $true
        $actionReceipts += $recoveredReceipt
        $refreshed += [ordered]@{ issue = [int]$pending.action.target.id; state = [string]$pending.action.arguments.lifecycleState; action = 'resumed-refresh' }
        $pendingRecoveryCompleted = $true
    } catch {
        $pendingRecoveryBlocked = $true
        $pendingIssue = 0
        $pendingOperationKey = $null
        if ($pending -and $pending.action) {
            if ($pending.action.target -and $pending.action.target.id) { $pendingIssue = [int]$pending.action.target.id }
            if ($pending.action.operationKey) { $pendingOperationKey = [string]$pending.action.operationKey }
        }
        $failures += [ordered]@{ issue = $pendingIssue; operationKey = $pendingOperationKey; error = $_.Exception.Message; pendingReceipt = $PendingPath }
    }
}
foreach ($candidate in $selected) {
    if ($pendingRecoveryBlocked -or $pendingRecoveryCompleted) { break }
    $pendingAfterError = $null
    try {
        if (-not $DryRun) {
            $live = Get-LiveIssue ([int]$candidate.issue)
            $liveLabels = @(Get-LabelNames $live | Sort-Object -Unique)
            $expectedLabels = @($candidate.labels | Sort-Object -Unique)
            $liveRevision = [DateTimeOffset]::Parse([string]$live.updatedAt).ToUniversalTime().ToString('o')
            if ([string]$live.state -ne 'OPEN' -or $liveRevision -ne $candidate.updatedAt -or ($liveLabels -join "`n") -ne ($expectedLabels -join "`n")) {
                throw "issue state, updatedAt revision, or labels changed since stale-workable selection; refusing refresh (state=$($live.state), expectedRevision=$($candidate.updatedAt), observedRevision=$liveRevision, expectedLabels=$($expectedLabels -join ','), observedLabels=$($liveLabels -join ','))"
            }

            $keySource = "$($candidate.issue)|$($candidate.updatedAt)|$($candidate.state)"
            $keyBytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($keySource))
            $operationKey = "factory:stale-workable:$($candidate.issue):$([Convert]::ToHexString($keyBytes).ToLowerInvariant())"
            $action = [ordered]@{
                schemaVersion = 1
                target = [ordered]@{ kind = 'github_issue'; id = [int]$candidate.issue }
                expectedRevision = [string]$candidate.updatedAt
                operation = 'github.issue.refresh_lifecycle'
                arguments = [ordered]@{ lifecycleState = [string]$candidate.state; expectedLabels = @($expectedLabels) }
                rationale = 'Retrigger a stale eligible issue after checking its current open state, revision, and labels.'
                operationKey = $operationKey
            }
            $pending = [ordered]@{ action = $action; phase = 'removing'; recordedAt = [DateTimeOffset]::UtcNow.ToString('o') }
            Write-JsonAtomic $pending $PendingPath
            Invoke-Gh @('issue','edit',[string]$candidate.issue,'--remove-label',$candidate.state) | Out-Null
            $pending.phase = 'removed'
            Write-JsonAtomic $pending $PendingPath
            Invoke-Gh @('issue','edit',[string]$candidate.issue,'--add-label',$candidate.state) | Out-Null
            $actionReceipts += Complete-PendingRefresh $pending $false
        } else {
            $candidate.effectAction = [ordered]@{ operation = 'github.issue.refresh_lifecycle'; target = [ordered]@{ kind = 'github_issue'; id = [int]$candidate.issue }; expectedRevision = [string]$candidate.updatedAt }
        }
        $candidate.action = if ($DryRun) { 'would-refresh' } else { 'refreshed' }
        $refreshed += $candidate
    }
    catch {
        $errorMessage = $_.Exception.Message
        if (-not $DryRun -and (Test-Path -LiteralPath $PendingPath -PathType Leaf)) {
            try {
                $pendingAfterError = Get-Content -LiteralPath $PendingPath -Raw | ConvertFrom-Json -AsHashtable
                if ([int]$pendingAfterError.action.target.id -eq [int]$candidate.issue -and $pendingAfterError.phase -in @('removing', 'removed')) {
                    $actionReceipts += Complete-PendingRefresh $pendingAfterError $false
                    $candidate.action = 'refreshed-after-ambiguous-response'
                    $refreshed += $candidate
                    continue
                }
            } catch { $errorMessage = "$errorMessage; reconciliation: $($_.Exception.Message)" }
        }
        $failures += [ordered]@{ issue = $candidate.issue; state = $candidate.state; error = $errorMessage; operationKey = if ($pendingAfterError) { $pendingAfterError.action.operationKey } else { $null } }
        if (Test-Path -LiteralPath $PendingPath -PathType Leaf) {
            try {
                $unfinished = Get-Content -LiteralPath $PendingPath -Raw | ConvertFrom-Json -AsHashtable
                if ($unfinished.phase -ne 'committed') { break }
            } catch { break }
        }
    }
}

$result = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    cutoff = $cutoff.ToString('o')
    olderThanHours = $OlderThanHours
    limit = $Limit
    dryRun = [bool]$DryRun
    considered = @($issues).Count
    eligible = @($candidates).Count
    recentlyUpdated = $recentlyUpdatedCount
    refreshed = $refreshed
    actionReceipts = $actionReceipts
    excluded = $excluded
    failures = $failures
    terminalReason = if ($failures.Count) { 'refresh-failures' } elseif ($refreshed.Count) { 'refreshed-bounded-batch' } else { 'no-stale-workable-issues' }
}
Write-Result $result
if (Test-Path -LiteralPath $PendingPath -PathType Leaf) {
    try {
        $completedPending = Get-Content -LiteralPath $PendingPath -Raw | ConvertFrom-Json -AsHashtable
        if ($completedPending.phase -eq 'committed') { Remove-Item -LiteralPath $PendingPath -Force }
    } catch { }
}
if ($failures.Count) { exit 1 }
