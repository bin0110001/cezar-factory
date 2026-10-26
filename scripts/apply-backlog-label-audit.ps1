#!/usr/bin/env pwsh
<#
.SYNOPSIS
Applies a bounded backlog-label proposal after rechecking the reserved issue state.

.DESCRIPTION
The agent writes a proposal artifact only. This script validates the proposal,
checks each issue's live labels against the candidate snapshot plus its audit
reservation, applies allowlisted labels, and verifies the resulting state.
GitHub labels are the idempotency receipt: after an ambiguous command result,
a rerun recognizes the exact desired state instead of applying a second effect.
#>
[CmdletBinding()]
param(
    [string]$InputPath = '.factory/backlog-label-audit-input.json',
    [string]$PreparationPath = '.factory/backlog-label-audit-preparation.json',
    [string]$ProposalPath = '.factory/backlog-label-audit.json',
    [string]$OutputPath = '.factory/backlog-label-audit-application.json',
    [string]$GhCommand = 'gh',
    [string]$Repo,
    [switch]$Prepare,
    [switch]$WorkflowContract
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:AllowedAuditLabelNames = @(
    'factory:new', 'factory:needs-plan', 'factory:tracking', 'factory:blocked', 'factory:needs-help',
    'type:bug', 'type:feature', 'type:refactor', 'type:docs', 'type:test', 'type:maintenance',
    'risk:low', 'risk:medium', 'risk:high',
    'complexity:small', 'complexity:medium', 'complexity:large'
)

function Read-JsonFile([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Required audit artifact is missing: $full" }
    try { Get-Content -Raw -LiteralPath $full | ConvertFrom-Json -Depth 30 }
    catch { throw "Audit artifact is not valid JSON: $full. $($_.Exception.Message)" }
}

function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments)
    if ($Repo) { $all += @('--repo', $Repo) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($all -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}

function Get-LiveIssue([int]$Number) {
    $raw = Invoke-Gh @('issue', 'view', [string]$Number, '--json', 'number,state,updatedAt,labels,comments')
    $issue = ($raw -join "`n") | ConvertFrom-Json
    $labels = @($issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } } | Where-Object { $_ } | Sort-Object -Unique)
    $comments = @($issue.comments | ForEach-Object { if ($_ -is [string]) { $_ } else { [string]$_.body } } | Where-Object { $_ })
    [pscustomobject]@{ state = [string]$issue.state; updatedAt = [string]$issue.updatedAt; labels = $labels; comments = $comments }
}

function Same-Labels([string[]]$Left, [string[]]$Right) {
    (@($Left | Sort-Object -Unique) -join "`n") -eq (@($Right | Sort-Object -Unique) -join "`n")
}

function Add-AuditReservation([int]$IssueNumber, $LiveIssue) {
    $marker = "<!-- factory-audit-reservation:$IssueNumber -->"
    $existing = @($LiveIssue.comments | Where-Object { $_ -match [regex]::Escape($marker) })
    if ($existing.Count) { return $false }
    $now = [DateTimeOffset]::UtcNow
    $reservation = [ordered]@{
        issue = $IssueNumber
        owner = if ($env:CEZAR_PROJECT_ID) { [string]$env:CEZAR_PROJECT_ID } else { 'factory-maintenance' }
        createdAt = $now.ToString('o')
        expiresAt = $now.AddMinutes(90).ToString('o')
    }
    $temp = Join-Path ([IO.Path]::GetTempPath()) "factory-audit-$([guid]::NewGuid()).md"
    try {
        "$marker`n$($reservation | ConvertTo-Json -Compress)" | Set-Content -NoNewline $temp
        Invoke-Gh @('issue', 'comment', [string]$IssueNumber, '--body-file', $temp) | Out-Null
    } finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
    $verified = Get-LiveIssue $IssueNumber
    if (@($verified.comments | Where-Object { $_ -match [regex]::Escape($marker) }).Count -ne 1) {
        throw "Issue $IssueNumber audit reservation comment could not be verified."
    }
    return $true
}

function Write-ReceiptReport([string]$Path, [string]$Status, [string]$OperationKey, $Receipts, [string]$Proposal = '') {
    $report = [ordered]@{ generatedAt = [DateTimeOffset]::UtcNow.ToString('o'); status = $Status; operationKey = $OperationKey; receipts = @($Receipts) }
    if ($Proposal) { $report.proposal = [IO.Path]::GetFullPath($Proposal) }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $tempPath = Join-Path $parent ".$([IO.Path]::GetFileName($fullPath)).$([guid]::NewGuid().ToString('N')).tmp"
    $backupPath = "$tempPath.bak"
    try {
        $json = $report | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($tempPath, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) { [IO.File]::Replace($tempPath, $fullPath, $backupPath) }
        else { [IO.File]::Move($tempPath, $fullPath) }
    } finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
    $report
}

function Get-DesiredLabels($Outcome) {
    $labels = @($Outcome.added | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $states = @($labels | Where-Object { $_ -in @('factory:new', 'factory:needs-plan', 'factory:tracking', 'factory:blocked', 'factory:needs-help') })
    if ($states.Count -ne 1) { throw "Issue $($Outcome.issue) must propose exactly one allowlisted closing Factory state label." }
    $types = @($labels | Where-Object { $_ -like 'type:*' })
    $risks = @($labels | Where-Object { $_ -like 'risk:*' })
    $complexities = @($labels | Where-Object { $_ -like 'complexity:*' })
    if ($types.Count -gt 1 -or @($types | Where-Object { $_ -notin @('type:bug','type:feature','type:refactor','type:docs','type:test','type:maintenance') }).Count) { throw "Issue $($Outcome.issue) has an invalid type proposal." }
    if ($risks.Count -gt 1 -or @($risks | Where-Object { $_ -notin @('risk:low','risk:medium','risk:high') }).Count) { throw "Issue $($Outcome.issue) has an invalid risk proposal." }
    if ($complexities.Count -gt 1 -or @($complexities | Where-Object { $_ -notin @('complexity:small','complexity:medium','complexity:large') }).Count) { throw "Issue $($Outcome.issue) has an invalid complexity proposal." }
    $allowed = @($states + $types + $risks + $complexities)
    if (@($labels | Where-Object { $_ -notin $allowed }).Count) { throw "Issue $($Outcome.issue) proposed an unsupported label." }
    if ($states[0] -eq 'factory:new' -and ($types.Count -ne 1 -or $risks.Count -ne 1)) { throw "Issue $($Outcome.issue) classified as factory:new needs exactly one type and risk label." }
    if ($states[0] -eq 'factory:needs-plan' -and $complexities.Count -ne 1) { throw "Issue $($Outcome.issue) classified as factory:needs-plan needs exactly one complexity label." }
    if ([string]::IsNullOrWhiteSpace([string]$Outcome.reason)) { throw "Issue $($Outcome.issue) proposal needs a rationale." }
    $labels
}

function New-BacklogLabelAction($Outcome, [string]$ExpectedRevision, [string]$OperationKey, [string[]]$DesiredLabels) {
    $rationale = [string]$Outcome.reason
    if (-not $ExpectedRevision -or $rationale.Length -gt 500 -or [string]::IsNullOrWhiteSpace($rationale)) {
        throw "Issue $($Outcome.issue) action is missing a bounded revision or rationale."
    }
    $action = [ordered]@{
        schemaVersion = 1
        target = [ordered]@{ kind = 'github_issue'; id = [int]$Outcome.issue }
        expectedRevision = $ExpectedRevision
        operation = 'github.issue.update_labels'
        arguments = [ordered]@{
            addLabels = @($DesiredLabels | Sort-Object -Unique)
            removeLabels = @('factory:auditing')
        }
        rationale = $rationale
        operationKey = $OperationKey
    }
    $schemaPath = Join-Path $PSScriptRoot '../schemas/workflow-effect-action.schema.json'
    if (-not (Test-Json -Json ($action | ConvertTo-Json -Compress -Depth 8) -SchemaFile $schemaPath -ErrorAction Stop)) {
        throw "Generated backlog effect action does not satisfy the shared contract: $schemaPath"
    }
    $action
}

$inputDoc = Read-JsonFile $InputPath
$batchKey = ([DateTimeOffset]$inputDoc.generatedAt).ToUniversalTime().ToString('o')
$candidates = @($inputDoc.candidates)
if ($candidates.Count -gt 3) { throw 'Backlog audit input exceeds the three-candidate limit.' }
$candidateByNumber = @{}
foreach ($candidate in $candidates) {
    $n = [int]$candidate.number
    if ($n -lt 1 -or $candidateByNumber.ContainsKey($n)) { throw 'Backlog audit input has an invalid or duplicate candidate number.' }
    $candidateByNumber[$n] = $candidate
}

$resolved = @($inputDoc.resolved)
$resolvedByNumber = @{}
$resolvedPlans = @()
foreach ($entry in $resolved) {
    $n = [int]$entry.issue
    if ($n -lt 1 -or $resolvedByNumber.ContainsKey($n) -or $candidateByNumber.ContainsKey($n)) {
        throw 'Backlog audit input has duplicate or overlapping resolved/candidate issue numbers.'
    }
    if (-not $entry.PSObject.Properties.Name -contains 'sourceLabels') { throw "Resolved issue $n is missing its collection-time label snapshot." }
    $desired = @(Get-DesiredLabels $entry)
    $snapshot = @($entry.sourceLabels | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $final = @(@($snapshot | Where-Object { $_ -notlike 'factory:*' }) + $desired | Sort-Object -Unique)
    $resolvedByNumber[$n] = $true
    $resolvedPlans += [pscustomobject]@{ issue = $n; desired = $desired; snapshot = $snapshot; final = $final; reason = [string]$entry.reason }
}

$stagedByNumber = @{}
foreach ($entry in @($inputDoc.staged)) {
    $n = [int]$entry.issue
    if ($stagedByNumber.ContainsKey($n) -or -not $candidateByNumber.ContainsKey($n) -or $entry.reservation -ne 'factory:auditing') {
        throw 'Backlog audit staging list is duplicate, unsupported, or outside the bounded candidates.'
    }
    $stagedByNumber[$n] = $entry
}
if ($stagedByNumber.Count -ne $candidateByNumber.Count) { throw 'Every bounded candidate must have exactly one audit reservation plan.' }

if ($Prepare) {
    $preflight = @()
    foreach ($plan in $resolvedPlans) {
        $live = Get-LiveIssue $plan.issue
        if ($live.state -ne 'OPEN') { throw "Issue $($plan.issue) is no longer open; refusing stale deterministic classification." }
        if (-not (Same-Labels $live.labels $plan.snapshot) -and -not (Same-Labels $live.labels $plan.final)) {
            throw "Issue $($plan.issue) changed since collection; refusing deterministic classification."
        }
        $preflight += [pscustomobject]@{ kind = 'resolved'; plan = $plan; live = $live }
    }
    foreach ($number in @($candidateByNumber.Keys | Sort-Object)) {
        $candidate = $candidateByNumber[$number]
        $snapshot = @($candidate.labels | ForEach-Object { [string]$_ } | Sort-Object -Unique)
        if (@($snapshot | Where-Object { $_ -like 'factory:*' }).Count) { throw "Candidate $number already has a Factory label in its source snapshot." }
        $reserved = @($snapshot + 'factory:auditing' | Sort-Object -Unique)
        $live = Get-LiveIssue $number
        if ($live.state -ne 'OPEN') { throw "Issue $number is no longer open; refusing stale audit reservation." }
        if (-not (Same-Labels $live.labels $snapshot) -and -not (Same-Labels $live.labels $reserved)) {
            throw "Issue $number changed since collection; refusing audit reservation."
        }
        $preflight += [pscustomobject]@{ kind = 'candidate'; plan = [pscustomobject]@{ issue = $number; snapshot = $snapshot; reserved = $reserved }; live = $live }
    }

    # Label-definition writes belong to this deterministic effect consumer. The
    # collector itself remains read-only.
    $labelArgs = @{ GhCommand = $GhCommand }
    if ($Repo) { $labelArgs.Repo = $Repo }
    & (Join-Path $PSScriptRoot 'create-labels.ps1') @labelArgs | Out-Null

    $receipts = @()
    Write-ReceiptReport $OutputPath 'preparing' "backlog-label-audit:prepare:$batchKey" $receipts | Out-Null
    foreach ($entry in $preflight) {
        $number = [int]$entry.plan.issue
        if ($entry.kind -eq 'resolved') {
            $live = Get-LiveIssue $number
            if ($live.state -ne 'OPEN' -or (-not (Same-Labels $live.labels $entry.plan.snapshot) -and -not (Same-Labels $live.labels $entry.plan.final))) {
                throw "Issue $number changed during preparation; refusing deterministic classification."
            }
            $alreadyApplied = Same-Labels $live.labels $entry.plan.final
            if (-not $alreadyApplied) {
                $args = @('issue', 'edit', [string]$number)
                foreach ($label in $entry.plan.desired) { $args += @('--add-label', $label) }
                Invoke-Gh $args | Out-Null
                $live = Get-LiveIssue $number
            }
            if ($live.state -ne 'OPEN' -or -not (Same-Labels $live.labels $entry.plan.final)) {
                throw "Issue $number deterministic classification could not be verified."
            }
            $receipts += [ordered]@{ issue = $number; operationKey = "backlog-label-audit:static:${number}:$batchKey"; status = 'verified'; labels = $entry.plan.desired; revision = $live.updatedAt; alreadyApplied = $alreadyApplied }
            Write-ReceiptReport $OutputPath 'preparing' "backlog-label-audit:prepare:$batchKey" $receipts | Out-Null
            continue
        }

        $live = Get-LiveIssue $number
        if ($live.state -ne 'OPEN' -or (-not (Same-Labels $live.labels $entry.plan.snapshot) -and -not (Same-Labels $live.labels $entry.plan.reserved))) {
            throw "Issue $number changed during preparation; refusing audit reservation."
        }
        $alreadyReserved = Same-Labels $live.labels $entry.plan.reserved
        if (-not $alreadyReserved) {
            Invoke-Gh @('issue', 'edit', [string]$number, '--add-label', 'factory:auditing') | Out-Null
            $live = Get-LiveIssue $number
        }
        if ($live.state -ne 'OPEN' -or -not (Same-Labels $live.labels $entry.plan.reserved)) {
            throw "Issue $number audit reservation label could not be verified."
        }
        $commentAdded = Add-AuditReservation $number $live
        $live = Get-LiveIssue $number
        if ($live.state -ne 'OPEN' -or -not (Same-Labels $live.labels $entry.plan.reserved)) {
            throw "Issue $number changed while its audit reservation was being committed."
        }
        $receipts += [ordered]@{ issue = $number; operationKey = "backlog-label-audit:reserve:${number}:$batchKey"; status = 'verified'; labels = @('factory:auditing'); revision = $live.updatedAt; alreadyApplied = $alreadyReserved; commentAdded = $commentAdded }
        Write-ReceiptReport $OutputPath 'preparing' "backlog-label-audit:prepare:$batchKey" $receipts | Out-Null
    }
    $report = Write-ReceiptReport $OutputPath 'prepared' "backlog-label-audit:prepare:$batchKey" $receipts
    if ($WorkflowContract) {
        $summary = [ordered]@{
            status = 'prepared'
            candidateCount = $candidates.Count
            resolvedCount = $resolved.Count
        }
        if ($candidates.Count -eq 0) {
            $summary['$cezar'] = @{ action = 'no_work'; reasonCode = 'no_work' }
        }
        $summary | ConvertTo-Json -Depth 4 -Compress
    }
    else { $report | ConvertTo-Json -Depth 12 }
    exit 0
}

$proposal = Read-JsonFile $ProposalPath
$preparation = Read-JsonFile $PreparationPath
if ($preparation.status -ne 'prepared' -or $preparation.operationKey -ne "backlog-label-audit:prepare:$batchKey") {
    throw 'Backlog audit preparation receipt is missing, stale, or for a different candidate batch.'
}
$preparationReceipts = @($preparation.receipts)
if (@($preparationReceipts | Where-Object { $_.status -ne 'verified' -or -not $_.operationKey }).Count) {
    throw 'Preparation contains an incomplete or unverified effect receipt.'
}
$preparedNumbers = @($preparationReceipts | ForEach-Object { [int]$_.issue } | Sort-Object -Unique)
$expectedPreparedNumbers = @(@($candidateByNumber.Keys) + @($resolvedByNumber.Keys) | ForEach-Object { [int]$_ } | Sort-Object -Unique)
if (($preparedNumbers -join ',') -ne ($expectedPreparedNumbers -join ',')) {
    throw 'Preparation receipts do not cover exactly the resolved issues and bounded candidates.'
}
foreach ($plan in $resolvedPlans) {
    $receipt = @($preparationReceipts | Where-Object { [int]$_.issue -eq $plan.issue })[0]
    if (-not $receipt.operationKey.StartsWith("backlog-label-audit:static:$($plan.issue):")) {
        throw "Preparation receipt for resolved issue $($plan.issue) has the wrong operation type."
    }
    $live = Get-LiveIssue $plan.issue
    if ($live.state -ne 'OPEN' -or -not (Same-Labels $live.labels $plan.final) -or $live.updatedAt -ne [string]$receipt.revision) {
        throw "Resolved issue $($plan.issue) changed after its prepared effect; refusing stale result."
    }
}
foreach ($number in $candidateByNumber.Keys) {
    $receipt = @($preparationReceipts | Where-Object { [int]$_.issue -eq [int]$number })[0]
    if (-not $receipt.operationKey.StartsWith("backlog-label-audit:reserve:${number}:")) {
        throw "Preparation receipt for candidate $number has the wrong operation type."
    }
}
$changed = @($proposal.changed)
$skipped = @($proposal.skipped)
$outcomes = @($changed) + @($skipped)
$proposalNumbers = @($outcomes | ForEach-Object { [int]$_.issue })
if ($proposalNumbers.Count -ne $candidateByNumber.Count -or @($proposalNumbers | Sort-Object -Unique).Count -ne $candidateByNumber.Count) {
    throw 'Proposal must contain exactly one changed or skipped outcome for every candidate.'
}
if (@($proposalNumbers | Where-Object { -not $candidateByNumber.ContainsKey($_) }).Count) { throw 'Proposal includes an issue outside the bounded input.' }
$consideredNumbers = @($proposal.considered | ForEach-Object { [int]$_ })
if ($consideredNumbers.Count -ne $candidateByNumber.Count -or @($consideredNumbers | Sort-Object -Unique).Count -ne $candidateByNumber.Count -or
    (@($consideredNumbers | Sort-Object) -join ',') -ne (@($candidateByNumber.Keys | Sort-Object) -join ',')) {
    throw 'Proposal considered list must exactly match the bounded candidate numbers.'
}

$desiredByNumber = @{}
foreach ($outcome in $outcomes) {
    $number = [int]$outcome.issue
    $desiredByNumber[$number] = @(Get-DesiredLabels $outcome)
}
foreach ($outcome in $outcomes) {
    $number = [int]$outcome.issue
    $candidate = $candidateByNumber[$number]
    $snapshot = @($candidate.labels | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $expectedReserved = @($snapshot + 'factory:auditing' | Sort-Object -Unique)
    $expectedFinal = @(@($snapshot | Where-Object { $_ -ne 'factory:auditing' }) + $desiredByNumber[$number] | Sort-Object -Unique)
    $live = Get-LiveIssue $number
    $receipt = @($preparationReceipts | Where-Object { [int]$_.issue -eq $number })[0]
    $reservedUnchanged = (Same-Labels $live.labels $expectedReserved) -and ($live.updatedAt -eq [string]$receipt.revision)
    if ($live.state -ne 'OPEN' -or (-not $reservedUnchanged -and -not (Same-Labels $live.labels $expectedFinal))) {
        throw "Issue $number changed after audit preparation; refusing stale proposal effect."
    }
}

$receipts = @()
$receipts += @($preparationReceipts | Where-Object { $resolvedByNumber.ContainsKey([int]$_.issue) })
$operationKey = "backlog-label-audit:apply:$batchKey"
Write-ReceiptReport $OutputPath 'applying' $operationKey $receipts $ProposalPath | Out-Null
foreach ($outcome in $outcomes) {
    $number = [int]$outcome.issue
    $candidate = $candidateByNumber[$number]
    $desired = @($desiredByNumber[$number])
    $snapshot = @($candidate.labels | ForEach-Object { [string]$_ } | Sort-Object -Unique)
    $expectedReserved = @($snapshot + 'factory:auditing' | Sort-Object -Unique)
    $expectedFinal = @(@($snapshot | Where-Object { $_ -ne 'factory:auditing' }) + $desired | Sort-Object -Unique)
    $preparedReceipt = @($preparationReceipts | Where-Object { [int]$_.issue -eq $number })[0]
    $actionKey = "backlog-label-audit:${number}:$batchKey"
    $action = New-BacklogLabelAction $outcome ([string]$preparedReceipt.revision) $actionKey $desired
    if ($action.operation -ne 'github.issue.update_labels' -or @($action.arguments.addLabels | Where-Object { $_ -notin $script:AllowedAuditLabelNames }).Count -or @($action.arguments.removeLabels | Where-Object { $_ -ne 'factory:auditing' }).Count) {
        throw "Issue $number action exceeds the backlog audit effect allowlist."
    }
    $actionReceiptIndex = $receipts.Count
    $receipts += [ordered]@{ issue = $number; operationKey = $action.operationKey; status = 'applying'; action = $action }
    Write-ReceiptReport $OutputPath 'applying' $operationKey $receipts $ProposalPath | Out-Null
    $live = Get-LiveIssue $number
    if ($live.state -ne 'OPEN') { throw "Issue $number is no longer open; refusing stale audit effect." }
    $liveLabels = @($live.labels)
    $alreadyApplied = Same-Labels $liveLabels $expectedFinal
    if (-not $alreadyApplied) {
        if (-not (Same-Labels $liveLabels $expectedReserved) -or $live.updatedAt -ne [string]$action.expectedRevision) {
            throw "Issue $number changed since candidate collection; refusing to overwrite current labels."
        }
        $ghArgs = @('issue', 'edit', [string]$action.target.id)
        foreach ($label in $action.arguments.removeLabels) { $ghArgs += @('--remove-label', $label) }
        foreach ($label in $action.arguments.addLabels) { $ghArgs += @('--add-label', $label) }
        Invoke-Gh $ghArgs | Out-Null
        $live = Get-LiveIssue $number
        if ($live.state -ne 'OPEN' -or -not (Same-Labels $live.labels $expectedFinal)) {
            throw "Issue $number label effect could not be verified; outcome remains unresolved."
        }
    }
    $receipts[$actionReceiptIndex].status = 'verified'
    $receipts[$actionReceiptIndex].observedRevision = $live.updatedAt
    $receipts[$actionReceiptIndex].alreadyApplied = $alreadyApplied
    Write-ReceiptReport $OutputPath 'applying' $operationKey $receipts $ProposalPath | Out-Null
}

$report = Write-ReceiptReport $OutputPath 'applied' $operationKey $receipts $ProposalPath
$report | ConvertTo-Json -Depth 12
