#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scriptPath = Join-Path $factory 'scripts/publish-failure-audit.ps1'
$fakeGh = Join-Path $PSScriptRoot 'fake-gh-publisher.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) "failure publisher $([guid]::NewGuid().ToString('N').Substring(0, 8))"
$inputPath = Join-Path $temp 'input.json'
$receiptPath = Join-Path $temp 'receipt.json'
$statePath = Join-Path $temp 'gh-state.json'
$script:failures = 0

function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" }
    else { Write-Host "  FAIL $Name"; $script:failures++ }
}

function Set-State([hashtable]$State) { $State | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statePath }
function Get-State { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable }
function Set-Input([string]$Status = 'ready', [string[]]$RunIds = @('run-one'), [string]$Fingerprint = ('a' * 64)) {
    $failureRows = @($RunIds | ForEach-Object {
        @{ runId = $_; fingerprint = $Fingerprint; step = 'collect'; command = 'pwsh collect.ps1 api_key=secretvalue123'; lastWriteUtc = '2026-10-18T12:00:00Z'; evidence = @('error Authorization: Bearer verysecretvalue123', 'workflow validation failed') }
    })
    @{
        schemaVersion = 1; status = $Status; projectId = 'registered-project'; windowStartUtc = '2026-10-17T12:00:00Z';
        windowHours = 24; runsInspected = $RunIds.Count; failures = $failureRows; limitations = @()
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $inputPath
}
function Publish {
    $oldPref = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & pwsh -NoProfile -File $scriptPath -InputPath $inputPath -ReceiptPath $receiptPath -FactoryRepo 'bin0110001/cezar-factory' -GhCommand $fakeGh 2>&1 | Out-String
    } finally { $ErrorActionPreference = $oldPref }
    $record = if (Test-Path $receiptPath) { Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json } else { $null }
    [pscustomobject]@{ code = $LASTEXITCODE; output = $output; receipt = $record }
}

try {
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $env:FAKE_GH_PUBLISHER_STATE = $statePath
    $env:FAKE_GH_PUBLISHER_RECEIPT = $receiptPath

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0 }
    Set-Input
    $run = Publish
    $state = Get-State
    Check 'canonical issue is created once after a pending receipt is persisted' ($run.code -eq 0 -and $run.receipt.status -eq 'published' -and $run.receipt.action -eq 'created' -and $run.receipt.issueCreated -and $state.issues.Count -eq 1 -and $state.receiptPendingBeforeWrite -and (Test-Json -Json ($run.receipt | ConvertTo-Json -Depth 20) -SchemaFile (Join-Path $factory 'schemas/failure-audit-publication.schema.json')))
    Check 'published evidence is redacted and carries the exact signature marker' ($state.issues[0].body -match '<!-- factory-failure-v1 key:FFP-' -and $state.issues[0].body -match '\[REDACTED\]' -and $state.issues[0].body -notmatch 'secretvalue123|verysecretvalue123')

    $run = Publish
    $state = Get-State
    Check 'identical artifact is idempotent' ($run.code -eq 0 -and $run.receipt.action -eq 'existing' -and $state.issues.Count -eq 1 -and $state.commentCalls -eq 0)

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0 }
    Set-Input -RunIds @('run-one','run-two')
    $run = Publish
    $state = Get-State
    Check 'multiple failure records create at most one issue in one run' ($run.code -eq 0 -and $run.receipt.action -eq 'created' -and $state.issues.Count -eq 1 -and $state.createCalls -eq 1 -and $state.issues[0].body -match 'run-one' -and $state.issues[0].body -match 'run-two')

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0 }
    Set-Input
    $run = Publish
    $state = Get-State

    Set-Input -RunIds @('run-two')
    $run = Publish
    $state = Get-State
    Check 'new run evidence appends to the canonical issue' ($run.code -eq 0 -and $run.receipt.action -eq 'appended' -and $state.issues.Count -eq 1 -and $state.issues[0].comments.Count -eq 1)
    $run = Publish
    $state = Get-State
    Check 'appended evidence remains idempotent on retry' ($run.code -eq 0 -and $run.receipt.action -eq 'existing' -and $state.issues[0].comments.Count -eq 1)

    $state.failCommentAfter = $true
    Set-State $state
    Set-Input -RunIds @('run-three')
    $run = Publish
    $state = Get-State
    Check 'ambiguous comment response is confirmed after marker requery' ($run.code -eq 0 -and $run.receipt.action -eq 'appended' -and $state.issues[0].comments.Count -eq 2 -and $state.commentCalls -eq 2)

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0; failCreateAfter = $true }
    Set-Input
    $run = Publish
    $state = Get-State
    Check 'ambiguous create response is resolved by exact marker requery' ($run.code -eq 0 -and $run.receipt.status -eq 'existing' -and -not $run.receipt.issueCreated -and $state.issues.Count -eq 1 -and $state.createCalls -eq 1)

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0; failSearch = $true }
    Set-Input
    $run = Publish
    $state = Get-State
    Check 'search failure fails closed without creating an issue' ($run.code -ne 0 -and $run.receipt.status -eq 'failed' -and $state.createCalls -eq 0 -and $state.issues.Count -eq 0)

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0 }
    Set-Input -Status 'limited'
    $run = Publish
    $state = Get-State
    Check 'limited collection produces a skipped receipt and no GitHub lookup' ($run.code -eq 0 -and $run.receipt.status -eq 'skipped' -and $state.searchCalls -eq 0 -and $state.createCalls -eq 0)

    $legacy = @{ number = 1; title = '[Factory audit] intake validation defect affecting registered-project'; body = 'Factory audit for registered-project'; state = 'OPEN'; comments = @(); url = 'https://github.com/bin0110001/cezar-factory/issues/1' }
    Set-State @{ issues = @($legacy); searchCalls = 0; createCalls = 0; commentCalls = 0 }
    Set-Input
    $run = Publish
    $state = Get-State
    Check 'ambiguous legacy issue is linked and the new issue is held for human review' ($run.code -eq 0 -and $run.receipt.status -eq 'needs-review' -and $run.receipt.legacyCandidates.Count -eq 1 -and $state.createCalls -eq 1 -and $state.commentCalls -eq 0 -and $state.issues.Count -eq 2 -and @($state.issues[-1].labels | Where-Object name -eq 'factory:needs-help').Count -eq 1 -and $state.issues[-1].body -match 'https://github.com/bin0110001/cezar-factory/issues/1')

    $fingerprint = 'a' * 64
    $legacy.body = "Factory audit for registered-project; signature $fingerprint"
    Set-State @{ issues = @($legacy); searchCalls = 0; createCalls = 0; commentCalls = 0 }
    Set-Input
    $run = Publish
    $state = Get-State
    Check 'legacy issue is adopted only with exact project and signature evidence' ($run.code -eq 0 -and $run.receipt.action -eq 'adopted' -and $run.receipt.issueNumber -eq 1 -and $state.issues.Count -eq 1 -and $state.commentCalls -eq 1 -and $state.issues[0].body -match 'signature')

    Set-State @{ issues = @(); searchCalls = 0; createCalls = 0; commentCalls = 0; failCreate = $true }
    Set-Input
    $run = Publish
    $state = Get-State
    Check 'failed create is recorded and not retried blindly' ($run.code -ne 0 -and $run.receipt.status -eq 'failed' -and $state.createCalls -eq 1 -and $state.issues.Count -eq 0)
} finally {
    Remove-Item Env:FAKE_GH_PUBLISHER_STATE -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_GH_PUBLISHER_RECEIPT -ErrorAction SilentlyContinue
    $resolved = [IO.Path]::GetFullPath($temp)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if ($script:failures) { exit 1 }
