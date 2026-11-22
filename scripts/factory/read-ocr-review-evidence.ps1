#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Task,
    [string]$OutputPath = '.factory/ocr-review-evidence.json',
    [string]$GhCommand = 'gh'
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

function Save-Evidence($Value) {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 12
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 262144) { throw 'OCR review evidence exceeds the 256 KiB handoff limit.' }
    Set-Content -LiteralPath $OutputPath -Value $json -Encoding utf8
}

function Invoke-Gh([string[]]$Arguments) {
    $raw = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($Arguments -join ' ') failed ($LASTEXITCODE): $raw" }
    ($raw -join "`n") | ConvertFrom-Json
}

$issueMatch = [regex]::Match($Task, '(?:GitHub\s+issue\s*#|/issues/|#)(?<number>[1-9][0-9]*)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $issueMatch.Success) { throw 'The selected workflow task does not identify a GitHub issue.' }
$issue = [int]$issueMatch.Groups['number'].Value
$apiUrl = [string]$env:CEZ_API_URL
$projectId = [string]$env:CEZ_PROJECT_ID
if (-not $apiUrl -or -not $projectId) {
    Save-Evidence ([ordered]@{ schemaVersion = 1; status = 'not-configured'; issue = $issue; message = 'Cezar verification history is unavailable in this workflow environment.' })
    exit 0
}

$remote = (& git remote get-url origin 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $remote -notmatch '(?:github\.com[:/])(?<slug>[^/\s]+/[^/\s]+?)(?:\.git)?$') { throw 'Cannot resolve the current GitHub repository from origin.' }
$repo = $Matches.slug
$pulls = @(Invoke-Gh @('api', "repos/$repo/pulls?state=open&per_page=100"))
$pattern = '(?im)\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#?' + [regex]::Escape([string]$issue) + '\b'
$matchingPulls = @($pulls | Where-Object { $_.state -eq 'open' -and ([string]$_.body -match $pattern) })
if ($matchingPulls.Count -ne 1) {
    Save-Evidence ([ordered]@{ schemaVersion = 1; status = 'pr-not-found'; issue = $issue; message = 'No unique open PR referencing the selected issue was found.' })
    exit 0
}
$pull = $matchingPulls[0]
$headSha = [string]$pull.head.sha
if ($headSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'The issue PR does not expose a full head SHA.' }

$escapedProject = [uri]::EscapeDataString($projectId)
$escapedSha = [uri]::EscapeDataString($headSha.ToLowerInvariant())
$endpoint = "$($apiUrl.TrimEnd('/'))/api/v1/p/$escapedProject/verification/query?kind=runs&commitSha=$escapedSha&pageSize=50"
$response = Invoke-RestMethod -Uri $endpoint -Method Get -TimeoutSec 30
if ($response.schemaVersion -ne 1 -or $response.kind -ne 'runs' -or $response.query.commitSha -ne $headSha.ToLowerInvariant()) {
    throw 'Cezar returned an unsupported or mismatched verification query response.'
}
$runs = @($response.items | Where-Object { ([string]$_.commitSha).ToLowerInvariant() -eq $headSha.ToLowerInvariant() })
$evidence = @($runs | ForEach-Object {
    $run = $_
    foreach ($check in @($run.checks)) {
        if ($check.ocrReviewEvidence) {
            $receipt = $check.ocrReviewEvidence
            if ($receipt.headSha.ToLowerInvariant() -ne $headSha.ToLowerInvariant() -or $receipt.baseSha.ToLowerInvariant() -ne ([string]$run.baseSha).ToLowerInvariant()) {
                throw 'Cezar returned OCR evidence not bound to this PR head and verification base.'
            }
            [ordered]@{
                verificationId = [string]$run.id
                verificationStatus = [string]$run.status
                checkId = [string]$check.checkId
                status = [string]$receipt.status
                baseSha = [string]$receipt.baseSha
                headSha = [string]$receipt.headSha
                providerVersion = [string]$receipt.providerVersion
                sessionId = [string]$receipt.sessionId
                usageReceiptId = [string]$receipt.usageReceiptId
                usageTokens = $receipt.usageTokens
                usageCostUsd = $receipt.usageCostUsd
                rulesDigest = [string]$receipt.rulesDigest
                policyDigest = [string]$receipt.policyDigest
                findings = @($receipt.findings | Select-Object -First 100)
            }
        }
    }
})
Save-Evidence ([ordered]@{
    schemaVersion = 1
    status = if ($evidence.Count) { 'available' } else { 'no-exact-sha-evidence' }
    issue = $issue
    pr = [string]$pull.html_url
    headSha = $headSha.ToLowerInvariant()
    evidence = $evidence
    message = if ($evidence.Count) { 'Only OCR evidence whose head and base match the current verification and PR revisions is included.' } else { 'No OCR evidence was recorded for the current PR head.' }
})
