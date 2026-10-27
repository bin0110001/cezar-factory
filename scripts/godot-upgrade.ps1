#!/usr/bin/env pwsh
<##
.SYNOPSIS
Deterministic steps of the factory-godot-upgrade workflow: adopt a new stable Godot release in one project.

.DESCRIPTION
A project pins its Godot version in `.godot-version` (for example `4.7-stable`); the Cezar
container's GODOT_BIN selector runs whatever the working tree pins, installing it on demand.
Upgrading a project is therefore a pull request, never an image rebuild or container restart.

Steps (each is a separate workflow `command:` step; the workflow owns the ordering):
  check    compare the pin with the latest stable release; write .factory/godot-upgrade.json
  stage    pre-install the target version (godot-install) so tests do not pay for the download
  apply    branch factory/godot-<version> off the base branch, bump the pin, push the branch
  test     run the project's Godot tests; writes .factory/godot-test.json and .factory/godot-test.log
  publish  commit agent fixes, push, open the pull request and request auto-merge

Every step after `check` is a no-op when check found nothing to do. The pushed branch is also the
"already attempted" marker: a later `check` skips a version whose branch exists, so a release the
agent could not fix does not re-run every day. Delete the branch to retry.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('check', 'stage', 'apply', 'test', 'publish')][string]$Step,
    [string]$StatePath = '.factory/godot-upgrade.json',
    [string]$TestResultPath = '.factory/godot-test.json',
    [string]$TestLogPath = '.factory/godot-test.log',
    [string]$PinFile = '.godot-version',
    # Test/override hook: skip the release lookup and treat this tag as the latest stable.
    [string]$LatestTag = '',
    [string]$ReleaseApiUrl = 'https://api.github.com/repos/godotengine/godot/releases/latest',
    [string]$InstallCommand = 'godot-install',
    [string]$GhCommand = 'gh',
    [string]$GitCommand = 'git',
    # Integration branch for the PR; defaults to `dev` when it exists, else the remote default branch.
    [string]$BaseBranch = '',
    # Record a failing test run but exit 0 (the workflow's fix step reads the log).
    [switch]$AllowFailure
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-State {
    if (-not (Test-Path -LiteralPath $StatePath)) { throw "$StatePath is missing; the check step must run first." }
    Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json -AsHashtable
}
function Write-Json([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $Value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding utf8
}
function Invoke-Git([string[]]$Arguments) {
    $output = & $GitCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}
function Find-OpenUpgradePr([string]$Head, [string]$Base, [switch]$AsRecord) {
    $json = & $GhCommand pr list --head $Head --base $Base --state open --json url,headRefName,baseRefName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh pr list failed ($LASTEXITCODE): $($json -join "`n")" }
    try { $prs = @($json -join "`n" | ConvertFrom-Json) }
    catch { throw "gh pr list returned invalid JSON: $($_.Exception.Message)" }
    $matches = @($prs | Where-Object { $_.headRefName -eq $Head -and $_.baseRefName -eq $Base -and -not [string]::IsNullOrWhiteSpace([string]$_.url) })
    if ($matches.Count -gt 1) { throw "Multiple open PRs found for $Head -> $Base; reconcile before continuing." }
    if ($matches.Count -eq 1) { if ($AsRecord) { return $matches[0] }; return [string]$matches[0].url }
    return $null
}
# '4.7-stable' / '4.7.1-stable' / '4.8-rc1' -> numeric version and channel.
function ConvertFrom-GodotTag([string]$Tag) {
    if ($Tag -notmatch '^(?<v>\d+\.\d+(\.\d+)?)-(?<c>[a-z0-9.]+)$') { throw "Unrecognized Godot version tag '$Tag'." }
    [pscustomobject]@{ Version = [version]$Matches.v; Channel = $Matches.c }
}
function Get-CurrentTag {
    if (Test-Path -LiteralPath $PinFile) { return (Get-Content -Raw -LiteralPath $PinFile).Trim() }
    if ($env:GODOT_DEFAULT_VERSION) { return $env:GODOT_DEFAULT_VERSION }
    throw "No $PinFile and GODOT_DEFAULT_VERSION is unset; cannot determine the current Godot version."
}
function Get-LatestStableTag {
    if ($LatestTag) { return $LatestTag }
    $headers = @{ 'User-Agent' = 'cezar-factory'; Accept = 'application/vnd.github+json' }
    $token = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
    if ($token) { $headers.Authorization = "Bearer $token" }
    # /releases/latest never returns a prerelease or draft.
    [string](Invoke-RestMethod -Uri $ReleaseApiUrl -Headers $headers).tag_name
}
function Get-BaseBranch {
    if ($BaseBranch) { return $BaseBranch }
    if (Invoke-Git @('ls-remote', '--heads', 'origin', 'dev')) { return 'dev' }
    $head = (Invoke-Git @('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')) -join ''
    $head -replace '^origin/', ''
}

if ($Step -eq 'check') {
    Remove-Item -LiteralPath $StatePath, $TestResultPath, $TestLogPath -Force -ErrorAction SilentlyContinue
    $current = Get-CurrentTag
    $latest = Get-LatestStableTag
    $state = [ordered]@{ status = 'none'; from = $current; to = $latest; reason = '' }

    if ($latest -notmatch '-stable$') {
        $state.reason = "latest release '$latest' is not a stable release"
    }
    else {
        $cur = ConvertFrom-GodotTag $current
        $new = ConvertFrom-GodotTag $latest
        $newer = ($new.Version -gt $cur.Version) -or ($new.Version -eq $cur.Version -and $cur.Channel -ne 'stable')
        if (-not $newer) { $state.reason = 'already on the latest stable release' }
        else {
            $branch = "factory/godot-$($latest -replace '-stable$', '')"
            $state.branch = $branch
            if (Invoke-Git @('ls-remote', '--heads', 'origin', $branch)) { $state.reason = "branch $branch already exists (attempted); delete it to retry" }
            else { $state.status = 'upgrade'; $state.reason = "$current -> $latest" }
        }
    }
    Write-Json $StatePath $state
    $state | ConvertTo-Json -Compress
    exit 0
}

$state = Read-State
if ($state.status -ne 'upgrade') {
    Write-Output (@{ step = $Step; skipped = $true; reason = $state.reason } | ConvertTo-Json -Compress)
    exit 0
}

switch ($Step) {
    'stage' {
        $global:LASTEXITCODE = 0
        $output = & $InstallCommand $state.to 2>&1
        if ($LASTEXITCODE -ne 0) { throw "$InstallCommand $($state.to) failed ($LASTEXITCODE): $($output -join "`n")" }
        $state.godotBin = [string]($output | Select-Object -Last 1)
        Write-Json $StatePath $state
        $state | ConvertTo-Json -Compress
    }
    'apply' {
        $base = Get-BaseBranch
        Invoke-Git @('fetch', 'origin', $base) | Out-Null
        Invoke-Git @('switch', '-c', $state.branch, "origin/$base") | Out-Null
        Set-Content -LiteralPath $PinFile -Value $state.to -Encoding utf8
        Invoke-Git @('add', '--', $PinFile) | Out-Null
        Invoke-Git @('commit', '-m', "Pin Godot $($state.to) (was $($state.from))") | Out-Null
        Invoke-Git @('push', '-u', 'origin', $state.branch) | Out-Null
        $state.base = $base
        Write-Json $StatePath $state
        $state | ConvertTo-Json -Compress
    }
    'test' {
        # Project-owned command first (factory.config.yaml `godot.testCommand`), else the gdUnit4 runner.
        $command = $null
        $regressionExitCodes = @(1)
        $config = '.ai/factory/factory.config.yaml'
        if (Test-Path -LiteralPath $config) {
            $configText = Get-Content -Raw -LiteralPath $config
            $match = [regex]::Match($configText, '(?m)^\s*testCommand:\s*"?([^"\r\n]+?)"?\s*$')
            if ($match.Success) {
                $command = $match.Groups[1].Value.Trim()
                if ([string]::IsNullOrWhiteSpace($command)) { $command = $null }
            }
            $exitCodes = [regex]::Match($configText, '(?m)^\s*testRegressionExitCodes:\s*\[([^\]]*)\]\s*$')
            if ($exitCodes.Success) {
                $parsedCodes = @($exitCodes.Groups[1].Value -split ',' | ForEach-Object {
                    $value = 0
                    if (-not [int]::TryParse($_.Trim(), [ref]$value) -or $value -le 0) { throw 'godot.testRegressionExitCodes must contain positive integer exit codes.' }
                    $value
                } | Select-Object -Unique)
                if (-not $parsedCodes.Count) { throw 'godot.testRegressionExitCodes cannot be empty when configured.' }
                $regressionExitCodes = $parsedCodes
            }
        }
        if (-not $command -and (Test-Path 'addons/gdUnit4/runtest.sh')) { $command = 'bash addons/gdUnit4/runtest.sh -a test --continue' }
        if (-not $command) {
            $result = [ordered]@{ passed = $false; status = 'unavailable'; category = 'missing_command'; reason = 'godot_test_command_missing'; exitCode = 4; command = ''; godot = $state.to; logTail = '' }
            Write-Json $TestResultPath $result
            Write-Output (@{ step = 'test'; status = $result.status; passed = $false; category = $result.category; exitCode = 4; log = $TestLogPath } | ConvertTo-Json -Compress)
            exit 4
        }

        # The pin file already selects the target version; the override just makes that explicit.
        $env:GODOT_VERSION_OVERRIDE = [string]$state.to
        $logDirectory = Split-Path -Parent $TestLogPath
        if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
        & pwsh -NoProfile -Command $command *>&1 | Tee-Object -FilePath $TestLogPath | Out-Null
        $code = $LASTEXITCODE
        Remove-Item Env:GODOT_VERSION_OVERRIDE -ErrorAction SilentlyContinue
        $tail = @(Get-Content -LiteralPath $TestLogPath -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
        $category = if ($code -eq 0) { 'none' } elseif ($regressionExitCodes -contains $code) { 'test_regression' } else { 'unknown' }
        $status = if ($code -eq 0) { 'passed' } else { 'failed' }
        $result = [ordered]@{ passed = ($code -eq 0); status = $status; category = $category; reason = if ($code -eq 0) { 'tests_passed' } elseif ($category -eq 'test_regression') { 'test_regression' } else { 'unclassified_test_exit_code' }; exitCode = $code; command = $command; godot = $state.to; logTail = $tail }
        Write-Json $TestResultPath $result
        $normalizedExitCode = if ($category -eq 'test_regression') { 1 } elseif ($code -eq 0) { 0 } else { 10 }
        Write-Output (@{ step = 'test'; status = $status; passed = $result.passed; category = $category; exitCode = $code; log = $TestLogPath } | ConvertTo-Json -Compress)
        if ($normalizedExitCode -ne 0 -and -not ($AllowFailure -and $category -eq 'test_regression')) { exit $normalizedExitCode }
    }
    'publish' {
        if (-not (Test-Path -LiteralPath $TestResultPath) -or -not (Get-Content -Raw -LiteralPath $TestResultPath | ConvertFrom-Json).passed) {
            throw 'Refusing to publish: the latest Godot test run did not pass.'
        }
        Invoke-Git @('add', '-A', '--', '.', ':!.factory') | Out-Null
        & $GitCommand diff --cached --quiet
        $stagedChanges = $LASTEXITCODE
        if ($stagedChanges -gt 1) { throw "git diff --cached --quiet failed ($stagedChanges)" }
        if ($stagedChanges -eq 1) {
            Invoke-Git @('commit', '-m', "Adapt to Godot $($state.to)") | Out-Null
        }
        Invoke-Git @('push', 'origin', $state.branch) | Out-Null

        $body = "Automated Godot upgrade: ``$($state.from)`` -> ``$($state.to)``.`n`n" +
            "The project's Godot tests pass on $($state.to). The pin lives in ``$PinFile``; merging it is the " +
            "only step needed to switch this project (the Cezar container installs the version on demand).`n`n" +
            "Generated by the factory-godot-upgrade workflow."
        $headSha = (Invoke-Git @('rev-parse', 'HEAD') | Out-String).Trim()
        if ($headSha -notmatch '^[a-f0-9]{40}$') { throw 'Cannot create the upgrade PR without a verified 40-character branch head.' }
        $repository = (Invoke-Git @('remote', 'get-url', 'origin') | Out-String).Trim()
        if (-not $repository) { throw 'Cannot create the upgrade PR without an origin repository identity.' }
        $bodyHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant()
        $operationFingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("${repository}|$($state.branch)|$($state.base)|$headSha"))).ToLowerInvariant()
        $prAction = [ordered]@{
            schemaVersion = 1
            target = [ordered]@{ kind = 'github_repository'; id = $repository }
            expectedRevision = $headSha
            operation = 'github.pull_request.create'
            arguments = [ordered]@{ head = [string]$state.branch; base = [string]$state.base; title = "Upgrade Godot to $($state.to)"; bodySha256 = $bodyHash }
            rationale = 'Publish a tested stable Godot upgrade from its unique workflow branch.'
            operationKey = "factory:godot-upgrade:pr:$operationFingerprint"
        }
        $actionSchema = Join-Path $PSScriptRoot '../schemas/workflow-effect-action.schema.json'
        if (-not (Test-Json -Json ($prAction | ConvertTo-Json -Compress -Depth 8) -SchemaFile $actionSchema -ErrorAction Stop)) { throw 'Godot upgrade PR action does not satisfy the shared workflow effect contract.' }
        $actionPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($prAction | ConvertTo-Json -Compress -Depth 8)))
        $actionMarker = "<!-- factory:effect-action:v1:$actionPayload -->"
        $body += "`n`n$actionMarker"
        $bodyFile = Join-Path ([IO.Path]::GetTempPath()) "godot-upgrade-$([guid]::NewGuid().ToString('N')).md"
        Set-Content -LiteralPath $bodyFile -Value $body -Encoding utf8
        try {
            # The PR body is the durable action receipt. Reuse only the exact
            # tested head and reconcile a lost create response before retrying.
            $prRecord = Find-OpenUpgradePr $state.branch $state.base -AsRecord
            if (-not $prRecord) {
                $createOutput = (& $GhCommand pr create --base $state.base --head $state.branch --title "Upgrade Godot to $($state.to)" --body-file $bodyFile 2>&1) -join "`n"
                $createCode = $LASTEXITCODE
                $prRecord = Find-OpenUpgradePr $state.branch $state.base -AsRecord
                if (-not $prRecord) { throw "gh pr create failed or was not observable ($createCode): $createOutput" }
            }
            if ([string]$prRecord.url -notmatch '^https://[^/]+/.+/pull/\d+$') { throw "gh pr list returned an invalid PR URL: $($prRecord.url)" }
            if ([string]$prRecord.headRefOid -ne $headSha) { throw 'The open Godot upgrade PR head changed; reconcile before continuing.' }
            $receiptMatches = [regex]::Matches([string]$prRecord.body, 'factory:effect-action:v1:([A-Za-z0-9+/=]+)')
            if ($receiptMatches.Count -ne 1) { throw 'The open Godot upgrade PR is missing its unique durable action receipt.' }
            $recordedAction = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($receiptMatches[0].Groups[1].Value)) | ConvertFrom-Json
            if (-not (Test-Json -Json ($recordedAction | ConvertTo-Json -Compress -Depth 8) -SchemaFile $actionSchema -ErrorAction Stop) -or
                $recordedAction.operationKey -ne $prAction.operationKey -or $recordedAction.expectedRevision -ne $headSha -or
                $recordedAction.operation -ne 'github.pull_request.create' -or $recordedAction.arguments.bodySha256 -ne $bodyHash) {
                throw 'The open Godot upgrade PR action receipt does not match this tested head and request.'
            }
            $url = [string]$prRecord.url
            if ($url -notmatch '^https://[^/]+/.+/pull/\d+$') { throw "gh pr create returned an invalid PR URL: $url" }
        }
        finally { Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue }
        $merge = (& $GhCommand pr merge $url --auto --squash 2>&1) -join "`n"
        $autoMerge = ($LASTEXITCODE -eq 0)
        $result = [ordered]@{ pr = $url; autoMerge = $autoMerge; from = $state.from; to = $state.to; actionReceipts = @(@{ operationKey = $prAction.operationKey; status = 'verified'; action = $prAction; observedRevision = $headSha }) }
        if (-not $autoMerge) { $result.autoMergeError = $merge }
        Write-Json '.factory/godot-upgrade-result.json' $result
        $result | ConvertTo-Json -Compress -Depth 12
    }
}
exit 0
