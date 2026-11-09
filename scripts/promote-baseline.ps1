#!/usr/bin/env pwsh
# Reviewed baseline promotion: requires a recorded, permitted, non-author approver, replaces the baseline
# atomically and appends exactly one audit entry. Any rejection leaves baseline and audit log untouched.
# Exit: 0 promoted, 1 rejected, 2 usage/input error. No network or deployment side effects.
param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Baseline,
    [Parameter(Mandatory)][string]$Review,
    [string]$Policy = 'policies/baseline-promotion.json',
    [string]$AuditLog,
    [string]$Timestamp
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256([byte[]]$Bytes) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { -join ($h.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function Get-FileDigest([string]$Path) { if (Test-Path -LiteralPath $Path) { Get-Sha256 ([IO.File]::ReadAllBytes($Path)) } else { '' } }
function Reject([string]$Message) { [Console]::Error.WriteLine("PROMOTION REJECTED: $Message"); exit 1 }
function Fail([string]$Message) { [Console]::Error.WriteLine("ERROR: $Message"); exit 2 }
function Read-Json([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable } catch { Fail "$What '$Path' is not valid JSON: $($_.Exception.Message)" }
}

$policyData = Read-Json $Policy 'policy'
if ($null -eq $policyData) { Fail "policy '$Policy' not found" }
if (-not $AuditLog) { $AuditLog = [string]$policyData['auditLog'] }
if (-not $AuditLog) { Fail 'no audit log path (policy.auditLog or -AuditLog)' }
if (-not (Test-Path -LiteralPath $Candidate)) { Fail "candidate '$Candidate' not found" }
$null = Read-Json $Candidate 'candidate'

$rv = Read-Json $Review 'review record'
if ($null -eq $rv) { Reject 'no review record: an unreviewed baseline cannot be promoted' }
foreach ($f in 'approver', 'reviewRef', 'sourceRun') {
    if (-not $rv.ContainsKey($f) -or [string]::IsNullOrWhiteSpace([string]$rv[$f])) { Reject "review record has no '$f'" }
}
$approver = [string]$rv['approver']
$author = if ($rv.ContainsKey('changeAuthor')) { [string]$rv['changeAuthor'] } else { '' }
if ([string]::IsNullOrWhiteSpace($author)) { Reject "review record has no 'changeAuthor'; self-approval cannot be ruled out" }
$permitted = @($policyData['permittedApprovers'] | ForEach-Object { ([string]$_).ToLowerInvariant() })
if ($permitted -notcontains $approver.ToLowerInvariant()) { Reject "approver '$approver' is not in the permitted-approvers policy" }
if ($approver -ieq $author) { Reject "self-approval: approver '$approver' is the change author" }

# Read previous audit state before changing anything.
$auditExisted = Test-Path -LiteralPath $AuditLog
$auditBytes = if ($auditExisted) { [IO.File]::ReadAllBytes($AuditLog) } else { [byte[]]@() }
$lines = @(if ($auditExisted) { Get-Content -LiteralPath $AuditLog | Where-Object { $_.Trim() } })
$prevDigest = if ($lines.Count) { Get-Sha256 ([Text.Encoding]::UTF8.GetBytes($lines[-1])) } else { '' }
$entry = [ordered]@{
    version = 1; seq = $lines.Count + 1
    timestamp = $(if ($Timestamp) { $Timestamp } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') })
    approver = $approver; changeAuthor = $author; sourceRun = [string]$rv['sourceRun']; reviewRef = [string]$rv['reviewRef']
    baseline = (Split-Path -Leaf $Baseline)
    baselineBeforeDigest = (Get-FileDigest $Baseline); baselineAfterDigest = (Get-FileDigest $Candidate)
    prevEntryDigest = $prevDigest
}
$line = $entry | ConvertTo-Json -Compress

$tmp = "$Baseline.promote-$([guid]::NewGuid().ToString('N')).tmp"
try {
    Copy-Item -LiteralPath $Candidate -Destination $tmp
    Add-Content -LiteralPath $AuditLog -Value $line -Encoding utf8
    try { Move-Item -LiteralPath $tmp -Destination $Baseline -Force }
    catch {
        [IO.File]::WriteAllBytes($AuditLog, $auditBytes)   # roll the audit append back
        if (-not $auditExisted) { Remove-Item -LiteralPath $AuditLog -Force }
        Fail "baseline replace failed, audit entry rolled back: $($_.Exception.Message)"
    }
}
finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
Write-Host "PROMOTED $(Split-Path -Leaf $Baseline) approved by $approver ($($entry['reviewRef'])); audit entry $($entry['seq']) written"
exit 0
