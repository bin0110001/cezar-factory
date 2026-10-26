#!/usr/bin/env pwsh
<##
.SYNOPSIS
Ensures a successful implementation PR contains a GitHub closing reference.

.DESCRIPTION
The implementation agent owns creating or updating the PR, but this workflow
step owns the deterministic issue-linking invariant. GitHub closes the issue
when the PR is merged into the repository's default branch.
##>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Path,
    [string]$GhCommand = 'gh'
)

$ErrorActionPreference = 'Stop'

function Invoke-Gh([string[]]$Arguments) {
    $output = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($Arguments -join ' ') failed ($LASTEXITCODE): $($output -join "`n")"
    }
    if ($null -eq $output) { return '' }
    [string]::Join("`n", [string[]]$output)
}

function Get-PrView([string]$Url) {
    $raw = Invoke-Gh @('pr', 'view', $Url, '--json', 'body,updatedAt')
    try { return ($raw | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "GitHub returned malformed PR state for $Url : $($_.Exception.Message)" }
}

function Test-ClosingReference([string]$Body, [int]$IssueNumber) {
    return $Body -match "(?im)\b(close[sd]?|resolve[sd]?|fix(e[sd])?)\s+#$IssueNumber\b"
}

function New-EffectAction([string]$Url, [string]$Revision, [int]$IssueNumber, [string]$Reference) {
    $identity = [Text.Encoding]::UTF8.GetBytes("ensure-pr-closes-issue`n$Url`n$IssueNumber")
    $key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($identity)).ToLowerInvariant()
    $action = [ordered]@{
        schemaVersion = 1
        target = @{ kind = 'pull_request'; id = $Url }
        expectedRevision = $Revision
        operation = 'pull_request.closing_reference.ensure'
        arguments = @{ issue = $IssueNumber; reference = $Reference }
        rationale = 'Ensure a successful implementation PR closes its source issue when merged.'
        operationKey = "factory:ensure-pr-closes-issue:$key"
    }
    $schemaPath = Join-Path $PSScriptRoot '../schemas/workflow-effect-action.schema.json'
    if (-not (Test-Json -Json ($action | ConvertTo-Json -Compress -Depth 8) -SchemaFile $schemaPath -ErrorAction Stop)) {
        throw "Generated PR effect action does not satisfy the shared contract: $schemaPath"
    }
    return $action
}

function Write-EffectResult([string]$Status, [int]$IssueNumber, [string]$Url, $Action, [string]$ObservedRevision) {
    Write-Output (@{ status = $Status; issue = $IssueNumber; pr = $Url; action = $Action; observedRevision = $ObservedRevision } | ConvertTo-Json -Depth 8 -Compress)
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Implementation result was not found: $Path"
}

$result = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
$issue = [int]$result.issue
if ($result.status -ne 'success') {
    Write-Output (@{ status = 'skipped'; reason = 'implementation-failure'; path = $Path } | ConvertTo-Json -Compress)
    exit 0
}
if ($issue -lt 1) { throw 'Implementation result must contain a positive issue number.' }
$pr = [string]$result.pr
if ([string]::IsNullOrWhiteSpace($pr)) { throw 'Successful implementation result must contain a PR URL.' }

$view = Get-PrView $pr
$body = [string]$view.body
$revision = [string]$view.updatedAt
if ([string]::IsNullOrWhiteSpace($revision)) { throw "GitHub did not return a PR revision for $pr; refusing an unbound body edit." }
$closingReference = "Closes #$issue"
if (Test-ClosingReference $body $issue) {
    $action = New-EffectAction $pr $revision $issue $closingReference
    Write-EffectResult 'already-linked' $issue $pr $action $revision
    exit 0
}

$action = New-EffectAction $pr $revision $issue $closingReference
$temp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($temp, (($body.TrimEnd() + "`r`n`r`n" + $closingReference + "`r`n")), [Text.UTF8Encoding]::new($false))
    try { Invoke-Gh @('pr', 'edit', $pr, '--body-file', $temp) | Out-Null }
    catch {
        $editError = $_.Exception.Message
        # GitHub may have accepted the edit even when the CLI lost its response.
        $afterFailure = Get-PrView $pr
        $observedBody = [string]$afterFailure.body
        if (-not (Test-ClosingReference $observedBody $issue)) { throw $editError }
        Write-EffectResult 'reconciled' $issue $pr $action ([string]$afterFailure.updatedAt)
        exit 0
    }
} finally {
    Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
}

$verified = Get-PrView $pr
if (-not (Test-ClosingReference ([string]$verified.body) $issue)) {
    throw "GitHub PR body verification did not find '$closingReference' after edit: $pr"
}
Write-EffectResult 'linked' $issue $pr $action ([string]$verified.updatedAt)
