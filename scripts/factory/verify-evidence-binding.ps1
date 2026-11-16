#!/usr/bin/env pwsh
# Fail-closed check that an evidence record (a JSON file or one JSONL line) is bound to the current attempt id and head SHA.
# A record with a missing or different headSha/attemptId is a replay from another head/attempt and is rejected (exit 1).
# Legacy unbound records (no attemptId) are accepted only with -AllowLegacy, and only if headSha still matches; they warn loudly.
param(
    [Parameter(Mandatory)][string]$EvidencePath,
    [Parameter(Mandatory)][string]$ExpectedHeadSha,
    [string]$ExpectedAttemptId = '',
    [int]$Line = 0,
    [switch]$AllowLegacy
)
$ErrorActionPreference = 'Stop'
function Reject([string]$Why) { Write-Host "verify-evidence-binding: REJECTED - $Why" -ForegroundColor Red; exit 1 }
if ($ExpectedHeadSha -notmatch '^[0-9a-fA-F]{40,64}$') { Reject 'expected head SHA is not a full commit SHA' }
if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) { Reject "evidence file not found: $EvidencePath" }
try {
    $text = if ($Line -gt 0) { @(Get-Content -LiteralPath $EvidencePath)[$Line - 1] } else { Get-Content -Raw -LiteralPath $EvidencePath }
    $rec = $text | ConvertFrom-Json -AsHashtable
} catch { Reject "evidence is not valid JSON ($($_.Exception.Message))" }
if ($rec -isnot [hashtable]) { Reject 'evidence is not a JSON object' }
$head = [string]$(if ($rec.ContainsKey('headSha')) { $rec.headSha } elseif ($rec.ContainsKey('commitSha') -and $rec.commitSha -is [string]) { $rec.commitSha } else { '' })
if (-not $head) { Reject 'evidence has no headSha binding' }
if ($head -ne $ExpectedHeadSha) { Reject "evidence is bound to head $head, not $ExpectedHeadSha (replay from another head)" }
$attempt = [string]$(if ($rec.ContainsKey('attemptId')) { $rec.attemptId } else { '' })
if (-not $attempt) {
    if ($AllowLegacy) { Write-Warning 'verify-evidence-binding: LEGACY record has no attemptId; accepted on headSha alone.'; Write-Host 'verify-evidence-binding: PASS (legacy)'; exit 0 }
    Reject 'evidence has no attemptId binding'
}
if ($ExpectedAttemptId -and $attempt -ne $ExpectedAttemptId) { Reject "evidence is bound to attempt '$attempt', not '$ExpectedAttemptId' (replay from another attempt)" }
if (-not $ExpectedAttemptId) { Reject 'no expected attempt id supplied for a bound record' }
Write-Host "verify-evidence-binding: PASS (head $($ExpectedHeadSha.Substring(0, 12)), attempt $attempt)"
exit 0
