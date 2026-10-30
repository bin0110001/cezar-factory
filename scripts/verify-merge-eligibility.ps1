#!/usr/bin/env pwsh
<##
.SYNOPSIS
Read-only, fail-closed eligibility check for a reviewed Factory pull request.
.DESCRIPTION
Checks the live PR head, workflow review identity, head-bound changed/verify receipts and,
for high-risk changes, a full regression receipt,
GitHub checks, effective dev rules, review threads, and repository auto-merge setting.
Writes an auditable decision receipt and never performs a GitHub write.
##>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReviewPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$GhCommand = 'gh',
    [string]$ReceiptRoot = (Join-Path (Get-Location).Path '.factory/artifacts/validation')
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$blockers = [System.Collections.Generic.List[string]]::new()

function Get-GhJson([string[]]$Arguments) {
    $raw = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($Arguments -join ' ') failed ($LASTEXITCODE): $raw" }
    return ($raw | Out-String | ConvertFrom-Json)
}
function Add-Blocker([string]$Message) { if (-not $blockers.Contains($Message)) { $blockers.Add($Message) } }
function Normalize-Url([string]$Url) { $Url.TrimEnd('/').ToLowerInvariant() }

$decision = [ordered]@{
    schemaVersion = 1; decision = 'denied'; issue = 0; repository = ''; pr = ''; headSha = ''
    reviewedHeadSha = ''; reviewerIdentity = ''; checkedAt = [DateTime]::UtcNow.ToString('o')
    requiredChecks = @(); validation = [ordered]@{ changed = $false; full = $false; verify = $false; fullRequired = $false }
    effectiveRules = @(); blockers = @()
}
try {
    if (-not (Test-Path -LiteralPath $ReviewPath)) { throw "review result not found: $ReviewPath" }
    $review = Get-Content -Raw -LiteralPath $ReviewPath | ConvertFrom-Json
    $decision.issue = [int]$review.issue
    $decision.pr = [string]$review.pr
    $decision.reviewedHeadSha = [string]$review.reviewedHeadSha
    $decision.reviewerIdentity = [string]$review.reviewerIdentity
    if ($decision.issue -lt 1) { Add-Blocker 'review result has no valid issue number' }
    if ($decision.pr -notmatch '^https://github\.com/([^/\s]+)/([^/\s]+)/pull/([1-9][0-9]*)/?$') { Add-Blocker 'review result has no qualified GitHub pull request URL' }
    if ($decision.reviewedHeadSha -notmatch '^[0-9a-fA-F]{40}$') { Add-Blocker 'review result is not bound to a 40-character head SHA' }
    if ([string]::IsNullOrWhiteSpace($decision.reviewerIdentity)) { Add-Blocker 'review result has no reviewer identity' }
    if ($decision.pr -match '^https://github\.com/([^/\s]+)/([^/\s]+)/pull/([1-9][0-9]*)/?$') {
        $owner = $Matches[1]; $repoName = $Matches[2]; $prNumber = [int]$Matches[3]
        $decision.repository = "$owner/$repoName"
        $pr = Get-GhJson @('pr','view',$decision.pr,'--json','number,url,body,state,isDraft,baseRefName,headRefOid,author,labels,statusCheckRollup,reviews,reviewDecision')
        $decision.headSha = [string]$pr.headRefOid
        $riskLabels = @($pr.labels | ForEach-Object { [string]$_.name } | Where-Object { $_ -in @('risk:low','risk:medium','risk:high') })
        if ($riskLabels.Count -ne 1) { Add-Blocker 'PR must have exactly one recognized risk label' }
        $decision.validation.fullRequired = ($riskLabels.Count -eq 1 -and $riskLabels[0] -eq 'risk:high')
        if ([string]$pr.state -ne 'OPEN') { Add-Blocker "PR state is $($pr.state), not OPEN" }
        if ($pr.isDraft) { Add-Blocker 'PR is a draft' }
        if ([string]$pr.baseRefName -ne 'dev') { Add-Blocker "PR base is '$($pr.baseRefName)', expected 'dev'" }
        if ($decision.headSha -notmatch '^[0-9a-fA-F]{40}$' -or $decision.headSha -ne $decision.reviewedHeadSha) { Add-Blocker 'reviewed head does not match the current PR head' }
        $issueRefs = @("#$($decision.issue)", "$owner/$repoName#$($decision.issue)", "https://github.com/$owner/$repoName/issues/$($decision.issue)")
        $closesIssue = $false
        foreach ($ref in $issueRefs) {
            if ([string]$pr.body -match "(?im)^\s*(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+$([regex]::Escape($ref))(?:\s|$)") { $closesIssue = $true; break }
        }
        if (-not $closesIssue) { Add-Blocker "PR body does not close issue #$($decision.issue)" }

        $repoSettings = Get-GhJson @('api',"repos/$owner/$repoName")
        if ($repoSettings.allow_auto_merge -ne $true) { Add-Blocker 'repository auto-merge is disabled' }
        $rules = @(Get-GhJson @('api',"repos/$owner/$repoName/rules/branches/dev"))
        $decision.effectiveRules = @($rules | ForEach-Object { [string]$_.type })
        if (-not $rules.Count) { Add-Blocker 'no effective rules apply to dev' }
        $prRules = @($rules | Where-Object { $_.type -eq 'pull_request' })
        if (-not $prRules.Count) { Add-Blocker 'effective rules do not require pull requests' }
        else {
            $approvalCount = 0
            $staleReviewsDismissed = $false
            $lastPushApprovalRequired = $false
            foreach ($rule in $prRules) {
                if ($rule.parameters.required_approving_review_count) { $approvalCount = [Math]::Max($approvalCount,[int]$rule.parameters.required_approving_review_count) }
                if ($rule.parameters.dismiss_stale_reviews_on_push -eq $true) { $staleReviewsDismissed = $true }
                if ($rule.parameters.require_last_push_approval -eq $true) { $lastPushApprovalRequired = $true }
            }
            if ($approvalCount -lt 1) { Add-Blocker 'effective rules do not require an approving review' }
            if (-not $staleReviewsDismissed) { Add-Blocker 'effective rules do not dismiss stale approvals after a new push' }
            if (-not $lastPushApprovalRequired) { Add-Blocker 'effective rules do not require an approval after the latest push' }
        }
        if (-not ($rules | Where-Object { $_.type -eq 'required_review_thread_resolution' })) { Add-Blocker 'effective rules do not require resolved review conversations' }
        $checkRules = @($rules | Where-Object { $_.type -eq 'required_status_checks' })
        $requiredChecks = @($checkRules | ForEach-Object { @($_.parameters.required_status_checks | ForEach-Object { [string]$_.context }) } | Where-Object { $_ } | Sort-Object -Unique)
        $decision.requiredChecks = $requiredChecks
        if (-not $requiredChecks.Count) { Add-Blocker 'effective rules do not require named status checks' }
        foreach ($required in $requiredChecks) {
            $matches = @($pr.statusCheckRollup | Where-Object { $_.name -eq $required -or $_.context -eq $required })
            if (-not $matches.Count -or @($matches | Where-Object { $_.conclusion -eq 'SUCCESS' -or $_.state -eq 'SUCCESS' }).Count -ne $matches.Count) {
                Add-Blocker "required check '$required' is missing or not successful on the current PR head"
            }
        }
        $author = [string]$pr.author.login
        if ($decision.reviewerIdentity -and $decision.reviewerIdentity -ieq $author) { Add-Blocker 'reviewer identity matches the PR author' }
        if ([string]$pr.reviewDecision -ne 'APPROVED') { Add-Blocker "GitHub review decision is '$($pr.reviewDecision)', not APPROVED" }
        $currentApprovals = @($pr.reviews | Where-Object { $_.state -eq 'APPROVED' -and $_.commit.oid -eq $decision.headSha -and $_.author.login -and $_.author.login -ine $author })
        if (-not $currentApprovals.Count) { Add-Blocker 'no independent GitHub approval is bound to the current PR head' }

        $query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}'
        $threads = Get-GhJson @('api','graphql','-f',"query=$query",'-F',"owner=$owner",'-F',"name=$repoName",'-F',"number=$prNumber")
        $threadData = $threads.data.repository.pullRequest.reviewThreads
        if ($threadData.pageInfo.hasNextPage) { Add-Blocker 'review thread list exceeds the bounded check (100)' }
        if (@($threadData.nodes | Where-Object { -not $_.isResolved }).Count) { Add-Blocker 'PR has unresolved review conversations' }

        $receiptFiles = if (Test-Path -LiteralPath $ReceiptRoot) { @(Get-ChildItem -LiteralPath $ReceiptRoot -Filter receipt.json -File -Recurse) } else { @() }
        $requiredStages = @('changed','verify')
        if ($decision.validation.fullRequired) { $requiredStages += 'full' }
        $stagesToInspect = @($requiredStages + 'full' | Select-Object -Unique)
        foreach ($stage in $stagesToInspect) {
            $matchingReceipts = @()
            foreach ($file in $receiptFiles) {
                try { $receipt = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json } catch { continue }
                if ([int]$receipt.issue -eq $decision.issue -and [string]$receipt.repository -ieq $decision.repository -and
                    (Normalize-Url ([string]$receipt.pr)) -eq (Normalize-Url $decision.pr) -and [string]$receipt.headSha -eq $decision.headSha -and
                    [string]$receipt.stage -eq $stage) { $matchingReceipts += [pscustomobject]@{ File = $file; Receipt = $receipt } }
            }
            $latestReceipt = $matchingReceipts | Sort-Object { $_.File.LastWriteTimeUtc } -Descending | Select-Object -First 1
            $valid = $null -ne $latestReceipt -and [string]$latestReceipt.Receipt.status -eq 'passed' -and
                [int]$latestReceipt.Receipt.exitCode -eq 0 -and $latestReceipt.Receipt.worktreeClean -eq $true
            $decision.validation[$stage] = $valid
            if ($stage -in $requiredStages -and -not $valid) { Add-Blocker "no passed, clean, current-head '$stage' validation receipt exists for this issue and PR" }
            if ($stage -notin $requiredStages -and $null -ne $latestReceipt -and -not $valid) { Add-Blocker "the latest current-head '$stage' validation attempt failed" }
        }
    }
} catch { Add-Blocker "eligibility evidence could not be read: $($_.Exception.Message)" }

if ($blockers.Count -eq 0) { $decision.decision = 'allowed' }
$decision.blockers = @($blockers)
$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$temp = "$OutputPath.tmp.$PID"
$decision | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding utf8
Move-Item -LiteralPath $temp -Destination $OutputPath -Force
$decision | ConvertTo-Json -Compress -Depth 8 | Write-Output
exit 0
