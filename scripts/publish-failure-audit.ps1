#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$InputPath = '.factory/failure-audit-input.json',
    [string]$ReceiptPath = '.factory/failure-audit-publication.json',
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$FactoryRepo,
    [string]$GhCommand = 'gh'
)

$ErrorActionPreference = 'Stop'
$inputFile = [IO.Path]::GetFullPath($InputPath)
$receiptFile = [IO.Path]::GetFullPath($ReceiptPath)
$receiptDir = Split-Path -Parent $receiptFile
if ($receiptDir) { New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null }

$receipt = [ordered]@{
    schemaVersion = 1
    status = 'failed'
    projectId = $null
    factoryRepo = $FactoryRepo
    fingerprint = $null
    issueNumber = $null
    issueUrl = $null
    issueCreated = $false
    action = 'failed'
    evidenceRuns = @()
    legacyCandidates = @()
    message = $null
}

function Save-Receipt {
    $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptFile -Encoding utf8
    if ($receipt.status -ne 'pending') { $receipt | ConvertTo-Json -Compress -Depth 10 | Write-Output }
}

function Hash-Text([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([Convert]::ToHexString($algorithm.ComputeHash($bytes))).ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Invoke-GhText([string[]]$Arguments) {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = & $GhCommand @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    if ($exitCode -ne 0) {
        $safeOutput = Redact (($lines -join ' ').Trim())
        throw "gh $($Arguments -join ' ') failed with exit $exitCode`: $safeOutput"
    }
    return ($lines -join "`n")
}

function Invoke-GhJson([string[]]$Arguments) {
    $text = Invoke-GhText $Arguments
    try { return ($text | ConvertFrom-Json -Depth 30) }
    catch { throw "GitHub returned invalid JSON for gh $($Arguments -join ' ')" }
}

function Search-Issues([string]$Query) {
    $response = Invoke-GhJson @('api', 'search/issues', '-f', "q=$Query", '-F', 'per_page=100')
    if (-not $response.PSObject.Properties['items']) { throw 'GitHub issue search omitted its items field.' }
    if ($response.total_count -gt @($response.items).Count) { throw 'GitHub issue search exceeded the 100-item inspection bound; refusing an incomplete dedupe result.' }
    return @($response.items)
}

function Read-Issue([int]$Number) {
    return Invoke-GhJson @('issue', 'view', [string]$Number, '--repo', $FactoryRepo, '--json', 'number,title,body,state,comments,url,labels')
}

function Find-ExactIssues([string]$Token, [string]$Marker) {
    $byNumber = @{}
    foreach ($qualifier in @('in:title', 'in:comments')) {
        $found = Search-Issues "repo:$FactoryRepo is:issue $qualifier $Token"
        foreach ($item in $found) {
            $number = [int]$item.number
            if (-not $byNumber.ContainsKey($number)) { $byNumber[$number] = $item }
        }
    }
    $exact = [System.Collections.Generic.List[object]]::new()
    foreach ($number in @($byNumber.Keys | Sort-Object)) {
        $issue = Read-Issue ([int]$number)
        $bodyHasMarker = ([string]$issue.body).Contains($Marker)
        $commentHasMarker = @($issue.comments | Where-Object { ([string]$_.body).Contains($Marker) }).Count -gt 0
        if ($bodyHasMarker -or $commentHasMarker) { $exact.Add($issue) }
    }
    return @($exact)
}

function Redact([string]$Value) {
    $clean = $Value -replace '(?i)\b(?:gh[psu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b', '[REDACTED]'
    $clean = $clean -replace '(?i)(Bearer\s+)\S+', '$1[REDACTED]'
    $clean = $clean -replace '(?i)\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,]+', '$1=[REDACTED]'
    if ($clean.Length -gt 400) { $clean = $clean.Substring(0, 400) + '…' }
    return $clean
}

function Format-Evidence([object[]]$Failures) {
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($failure in $Failures) {
        $runId = [string]$failure.runId
        $step = Redact ([string]$failure.step)
        $command = Redact ([string]$failure.command)
        $lines.Add("- Run ``$runId``; step: ``$step``; command: ``$command``")
        foreach ($item in @($failure.evidence)) {
            $clean = Redact ([string]$item)
            if ($clean) { $lines.Add("  - $clean") }
        }
    }
    $text = $lines -join "`n"
    if ($text.Length -gt 9000) { $text = $text.Substring(0, 9000) + "`n[additional evidence omitted by publisher budget]" }
    return $text
}

function Write-Comment([int]$Number, [string]$Body) {
    $bodyPath = Join-Path ([IO.Path]::GetTempPath()) ("factory-failure-comment-$([guid]::NewGuid().ToString('N')).md")
    try {
        Set-Content -LiteralPath $bodyPath -Value $Body -Encoding utf8
        [void](Invoke-GhText @('issue', 'comment', [string]$Number, '--repo', $FactoryRepo, '--body-file', $bodyPath))
    } finally { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }
}

try {
    if (-not (Test-Path -LiteralPath $inputFile -PathType Leaf)) { throw "Failure audit artifact not found: $inputFile" }
    $input = Get-Content -LiteralPath $inputFile -Raw | ConvertFrom-Json -Depth 30
    if ($input.schemaVersion -ne 1 -or [string]$input.projectId -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Failure audit artifact has an unsupported schema or invalid registered project identity.' }
    if ($input.status -eq 'limited') {
        $receipt.status = 'skipped'
        $receipt.action = 'skipped'
        $receipt.projectId = [string]$input.projectId
        $receipt.message = 'Collection coverage is limited; publication was not attempted.'
        Save-Receipt
        exit 0
    }
    if ($input.status -ne 'ready') { throw "Unsupported failure audit status: $($input.status)" }
    $receipt.projectId = [string]$input.projectId
    $failures = @($input.failures)
    if ($failures.Count -eq 0) {
        $receipt.status = 'skipped'
        $receipt.action = 'skipped'
        $receipt.message = 'No failure evidence was collected.'
        Save-Receipt
        exit 0
    }
    foreach ($failure in $failures) {
        if ([string]$failure.fingerprint -notmatch '^[a-f0-9]{64}$' -or [string]::IsNullOrWhiteSpace([string]$failure.runId)) {
            throw 'Failure evidence is missing a valid normalized fingerprint or run ID.'
        }
    }

    $projectHash = (Hash-Text ([string]$input.projectId).ToLowerInvariant()).Substring(0, 12)
    $fingerprints = @($failures | ForEach-Object { [string]$_.fingerprint } | Sort-Object -Unique)
    $fingerprint = if ($fingerprints.Count -eq 1) { $fingerprints[0] } else { Hash-Text ($fingerprints -join '|') }
    $token = "FFP-$projectHash-$($fingerprint.Substring(0, 16))"
    $marker = "<!-- factory-failure-v1 key:$token project:$projectHash signature:$fingerprint -->"
    $runs = @($failures | ForEach-Object { [string]$_.runId } | Sort-Object -Unique)
    $runHash = (Hash-Text ($runs -join '|')).Substring(0, 16)
    $receipt.fingerprint = $fingerprint
    $receipt.evidenceRuns = $runs

    $exact = @(Find-ExactIssues $token $marker)
    if ($exact.Count -gt 1) {
        $receipt.status = 'needs-review'
        $receipt.message = 'More than one Factory issue contains the canonical marker; no write was made.'
        $receipt.legacyCandidates = @($exact | ForEach-Object { $_.url })
        Save-Receipt
        exit 0
    }

    $evidence = Format-Evidence $failures
    $evidenceHash = (Hash-Text $evidence).Substring(0, 16)
    $evidenceMarker = "<!-- factory-failure-evidence-v1 key:$token runs:$runHash evidence:$evidenceHash -->"
    $comment = @(
        "New bounded failure evidence for project ``$($input.projectId)``.",
        '',
        "Window start (UTC): $($input.windowStartUtc)",
        "Runs inspected: $($input.runsInspected)",
        '',
        $evidence,
        '',
        $evidenceMarker
    ) -join "`n"

    if ($exact.Count -eq 1) {
        $issue = $exact[0]
        $comments = @($issue.comments | ForEach-Object { [string]$_.body })
        if (([string]$issue.body).Contains($evidenceMarker) -or @($comments | Where-Object { $_.Contains($evidenceMarker) }).Count -gt 0) {
            $needsReview = @($issue.labels | Where-Object { $_.name -eq 'factory:needs-help' }).Count -gt 0
            $receipt.status = if ($needsReview) { 'needs-review' } else { 'existing' }
            $receipt.action = if ($needsReview) { 'needs-review' } else { 'existing' }
            $receipt.issueNumber = [int]$issue.number
            $receipt.issueUrl = [string]$issue.url
            $receipt.message = 'The exact run evidence is already recorded; no duplicate comment was added.'
            Save-Receipt
            exit 0
        }

        $receipt.status = 'pending'
        $receipt.action = 'appended'
        $receipt.issueNumber = [int]$issue.number
        $receipt.issueUrl = [string]$issue.url
        $receipt.message = 'Evidence append is pending; a retry must requery the marker before writing.'
        Save-Receipt
        try { Write-Comment ([int]$issue.number) $comment } catch { }
        $confirmed = Read-Issue ([int]$issue.number)
        $commentFound = @($confirmed.comments | Where-Object { ([string]$_.body).Contains($evidenceMarker) }).Count -gt 0
        if (-not $commentFound) { throw 'Evidence append could not be confirmed after requery.' }
        $receipt.status = 'published'
        $receipt.action = 'appended'
        $receipt.message = 'New evidence was appended to the canonical issue.'
        Save-Receipt
        exit 0
    }

    $legacyByNumber = @{}
    foreach ($qualifier in @('in:body', 'in:comments')) {
        foreach ($item in (Search-Issues "repo:$FactoryRepo is:issue $qualifier `"$($input.projectId)`" `"Factory audit`"")) {
            $legacyByNumber[[int]$item.number] = $item
        }
    }
    $legacy = @($legacyByNumber.Values | Where-Object {
        ([string]$_.title -match '(?i)factory audit') -and ([string]$_.body -match [regex]::Escape([string]$input.projectId))
    })
    $needsLegacyReview = $false
    if ($legacy.Count -gt 0) {
        $unambiguous = [System.Collections.Generic.List[object]]::new()
        foreach ($candidate in $legacy) {
            $candidateIssue = Read-Issue ([int]$candidate.number)
            $allText = ([string]$candidateIssue.body + "`n" + (@($candidateIssue.comments | ForEach-Object { [string]$_.body }) -join "`n"))
            if ($allText.Contains([string]$input.projectId) -and @($fingerprints | Where-Object { $allText.Contains($_) }).Count -gt 0) {
                $unambiguous.Add($candidateIssue)
            }
        }
        if ($legacy.Count -gt 1) {
            $receipt.status = 'needs-review'
            $receipt.action = 'needs-review'
            $receipt.legacyCandidates = @($legacy | ForEach-Object { [string]$_.html_url })
            $receipt.message = 'A legacy Factory issue matches the project but lacks an unambiguous signature match; no issue or comment was created.'
            Save-Receipt
            exit 0
        }
        if ($unambiguous.Count -eq 1) {
            $legacyIssue = $unambiguous[0]
            $receipt.status = 'pending'
            $receipt.action = 'adopted'
            $receipt.issueNumber = [int]$legacyIssue.number
            $receipt.issueUrl = [string]$legacyIssue.url
            $receipt.message = 'Legacy issue adoption is pending; the exact project and signature evidence matched.'
            Save-Receipt
            try { Write-Comment ([int]$legacyIssue.number) ($marker + "`n" + $comment) } catch { }
            $confirmed = Read-Issue ([int]$legacyIssue.number)
            $markerFound = ([string]$confirmed.body).Contains($marker) -or @($confirmed.comments | Where-Object { ([string]$_.body).Contains($marker) }).Count -gt 0
            $commentFound = @($confirmed.comments | Where-Object { ([string]$_.body).Contains($evidenceMarker) }).Count -gt 0
            if (-not $markerFound -or -not $commentFound) { throw 'Legacy issue adoption could not be confirmed after requery.' }
            $receipt.status = 'published'
            $receipt.action = 'adopted'
            $receipt.message = 'Unambiguously matching legacy issue was adopted without changing its body or comments.'
            Save-Receipt
            exit 0
        }
        $needsLegacyReview = $true
        $receipt.legacyCandidates = @($legacy | ForEach-Object { [string]$_.html_url })
    }

    $title = "[Factory audit] failure in $($input.projectId) $token"
    $related = if ([string]$input.projectId -ieq 'blackjackandhookersgadot') {
        "`nRelated historical intake audit: https://github.com/$FactoryRepo/issues/1 (historical evidence only; not proof that the intake defect is resolved).`n"
    } else { '' }
    if ($needsLegacyReview) {
        $related += "`nPossible overlapping legacy issue: $($receipt.legacyCandidates[0]). The signature could not be matched, so human review is required before changing or closing either issue.`n"
    }
    $body = @(
        $marker,
        "# Bounded Factory failure evidence: $($input.projectId)",
        '',
        "Registered project ID: ``$($input.projectId)``",
        "Failure signature: ``$fingerprint``",
        "Window start (UTC): $($input.windowStartUtc)",
        "Runs inspected: $($input.runsInspected)",
        $related,
        '## Evidence',
        '',
        $evidence,
        '',
        $evidenceMarker,
        '',
        '## Acceptance criteria',
        '- Identify and fix the affected Factory skill, workflow, automation, schema, policy, or runtime contract in this source repository.',
        '- Validate the Factory source checkout and complete independent review.',
        '- Run the Factory release procedure for explicitly configured targets.',
        '- Verify the corrected workflow end to end in the registered project.',
        '',
        'This issue records evidence only. It does not claim that any previous failure is fixed or resolved.'
    ) -join "`n"

    if ($needsLegacyReview) {
        $body += "`nPossible overlap with legacy issue requires human review. Do not close or merge the issues based on project identity alone.`n"
    }
    $bodyPath = Join-Path ([IO.Path]::GetTempPath()) ("factory-failure-issue-$([guid]::NewGuid().ToString('N')).md")
    $receipt.status = 'pending'
    $receipt.action = 'created'
    $receipt.message = 'Issue creation is pending; a retry must requery the canonical marker before another write.'
    Save-Receipt
    try {
        Set-Content -LiteralPath $bodyPath -Value $body -Encoding utf8
        $stateLabel = if ($needsLegacyReview) { 'factory:needs-help' } else { 'factory:new' }
        $createdText = Invoke-GhText @('issue', 'create', '--repo', $FactoryRepo, '--title', $title, '--body-file', $bodyPath, '--label', $stateLabel, '--label', 'type:maintenance', '--label', 'risk:medium')
    } catch {
        $createdText = $null
        $createError = $_.Exception.Message
    } finally { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }

    $createdNumber = $null
    if ($createdText -match '/issues/(\d+)') { $createdNumber = [int]$Matches[1] }
    $confirmed = if ($createdNumber) { Read-Issue $createdNumber } else { @() }
    if ($createdNumber -and ([string]$confirmed.body).Contains($marker)) {
        $receipt.issueNumber = $createdNumber
        $receipt.issueUrl = [string]$confirmed.url
        $receipt.issueCreated = $true
    } else {
        $afterCreate = @(Find-ExactIssues $token $marker)
        if ($afterCreate.Count -eq 1) {
            $receipt.issueNumber = [int]$afterCreate[0].number
            $receipt.issueUrl = [string]$afterCreate[0].url
        } elseif ($afterCreate.Count -gt 1) {
            $receipt.status = 'needs-review'
            $receipt.action = 'needs-review'
            $receipt.legacyCandidates = @($afterCreate | ForEach-Object { [string]$_.url })
            $receipt.message = 'Create outcome was ambiguous and multiple canonical issues were found; no further write was attempted.'
            Save-Receipt
            exit 0
        } else {
            throw "Issue create was not confirmed after marker requery. $createError"
        }
    }
    $receipt.status = if ($needsLegacyReview) { 'needs-review' } elseif ($receipt.issueCreated) { 'published' } else { 'existing' }
    $receipt.action = if ($receipt.issueCreated) { 'created' } else { 'existing' }
    $receipt.message = if ($needsLegacyReview) { 'A canonical issue was created with a human-review label because a legacy project issue could not be matched by signature.' } elseif ($createError) { 'The ambiguous create response was confirmed by exact marker requery; the issue is recorded as existing because authorship could not be confirmed.' } else { 'Canonical Factory issue created and confirmed.' }
    Save-Receipt
    exit 0
} catch {
    $receipt.status = 'failed'
    $receipt.action = 'failed'
    $receipt.message = $_.Exception.Message
    Save-Receipt
    exit 1
}
