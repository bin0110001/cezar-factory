#!/usr/bin/env pwsh
<#
.SYNOPSIS
Bind the review's validation receipts to the exact pull-request head it reviewed.
.DESCRIPTION
The merge gate (verify-merge-eligibility.ps1) accepts only passed, clean receipts whose PR URL and head SHA match the live
PR. A review worktree starts on the base branch, so validating it proves nothing about the PR. This step:
  1. skips unless the review approved (a changes-requested verdict has nothing to merge);
  2. refuses when the live PR head is not the head the reviewer recorded;
  3. makes sure the PR carries one risk label, copying the issue's (the merge gate requires exactly one);
  4. checks out the reviewed head (detached) in this worktree;
  5. runs the changed and verify validations there, plus the full suite for risk:high.
Failing validation exits non-zero so the run fails visibly (maintenance then investigates it) rather than leaving the
issue waiting for a receipt that will never exist.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReviewPath,
    [string]$Task = '',
    [string]$GhCommand = 'gh',
    [string]$FactoryDir = $PSScriptRoot
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
function Out-Result([string]$Status, [string]$Message, [int]$Code) {
    Write-Output (@{ status = $Status; message = $Message } | ConvertTo-Json -Compress); exit $Code
}
function Invoke-Gh { $raw = & $GhCommand @args 2>&1; if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') failed ($LASTEXITCODE): $raw" }; $raw }

if (Test-Path '.factory/already-resolved.json') { Out-Result 'skipped' 'already resolved' 0 }
if (-not (Test-Path -LiteralPath $ReviewPath)) { Out-Result 'error' "review result not found: $ReviewPath" 1 }
$review = Get-Content -Raw -LiteralPath $ReviewPath | ConvertFrom-Json
if ([string]$review.approvalChangeRequestStatus -ne 'approval') { Out-Result 'skipped' 'review did not approve; nothing to merge' 0 }
$pr = [string]$review.pr
$sha = [string]$review.reviewedHeadSha
if ($pr -notmatch '^https://github\.com/[^/\s]+/[^/\s]+/pull/([1-9][0-9]*)/?$') { Out-Result 'error' 'review result has no qualified PR URL' 1 }
$number = $Matches[1]
if ($sha -notmatch '^[0-9a-fA-F]{40}$') { Out-Result 'error' 'review result is not bound to a 40-character head SHA' 1 }

$live = Invoke-Gh pr view $pr --json 'headRefOid,labels,state' | ConvertFrom-Json
if ([string]$live.state -ne 'OPEN') { Out-Result 'error' "PR is $($live.state), not OPEN" 1 }
if ([string]$live.headRefOid -ne $sha) { Out-Result 'error' "PR head moved to $($live.headRefOid) since the review of $sha; a fresh review is needed" 1 }

$risk = @($live.labels | ForEach-Object { [string]$_.name } | Where-Object { $_ -in 'risk:low', 'risk:medium', 'risk:high' })
if ($risk.Count -ne 1) {
    $issueLabels = @((Invoke-Gh issue view ([string]$review.issue) --json labels | ConvertFrom-Json).labels | ForEach-Object { [string]$_.name })
    $issueRisk = @($issueLabels | Where-Object { $_ -in 'risk:low', 'risk:medium', 'risk:high' })
    if ($issueRisk.Count -ne 1) { Out-Result 'error' "neither the PR nor issue #$($review.issue) has exactly one risk label, so the merge gate cannot be satisfied" 1 }
    # The gh CLI's PR-edit command fails on GraphQL "Projects (classic) is being deprecated"; a PR's labels are its issue's labels, so use REST.
    $slug = ([regex]::Match($pr, '^https://github\.com/([^/\s]+/[^/\s]+)/pull/')).Groups[1].Value
    foreach ($stale in $risk) { Invoke-Gh api -X DELETE "repos/$slug/issues/$number/labels/$([uri]::EscapeDataString($stale))" | Out-Null }
    Invoke-Gh api -X POST "repos/$slug/issues/$number/labels" -f "labels[]=$($issueRisk[0])" | Out-Null
    $risk = $issueRisk
}

& git fetch --quiet origin "pull/$number/head"
if ($LASTEXITCODE -ne 0) { Out-Result 'error' "could not fetch pull/$number/head" 1 }
& git -c advice.detachedHead=false checkout --quiet --detach $sha
if ($LASTEXITCODE -ne 0) { Out-Result 'error' "could not check out reviewed head $sha" 1 }
$head = (& git rev-parse HEAD).Trim()
if ($head -ne $sha) { Out-Result 'error' "worktree HEAD $head is not the reviewed head $sha" 1 }

$stages = @('test-changed.ps1', 'verify.ps1')
if ($risk[0] -eq 'risk:high') { $stages += 'test-full.ps1' }
foreach ($stage in $stages) {
    & pwsh -NoProfile -File (Join-Path (Join-Path $FactoryDir 'factory') $stage) -Task $Task | Out-Host
    if ($LASTEXITCODE -ne 0) { Out-Result 'failed' "$stage failed on reviewed head $sha" 1 }
}
Out-Result 'ok' "validated reviewed head $sha ($($risk[0])): $($stages -join ', ')" 0
