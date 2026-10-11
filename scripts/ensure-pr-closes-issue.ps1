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

$view = Invoke-Gh @('pr', 'view', $pr, '--json', 'body') | ConvertFrom-Json
$body = [string]$view.body
$closingReference = "Closes #$issue"
if ($body -match "(?im)\b(close[sd]?|resolve[sd]?|fix(e[sd])?)\s+#$issue\b") {
    Write-Output (@{ status = 'ok'; issue = $issue; pr = $pr; action = 'already-linked' } | ConvertTo-Json -Compress)
    exit 0
}

$temp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($temp, (($body.TrimEnd() + "`r`n`r`n" + $closingReference + "`r`n")), [Text.UTF8Encoding]::new($false))
    Invoke-Gh @('pr', 'edit', $pr, '--body-file', $temp) | Out-Null
} finally {
    Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue
}

Write-Output (@{ status = 'ok'; issue = $issue; pr = $pr; action = 'linked'; reference = $closingReference } | ConvertTo-Json -Compress)
