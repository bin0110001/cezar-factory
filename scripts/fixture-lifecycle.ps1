#!/usr/bin/env pwsh
<#
.SYNOPSIS
Model-free fixture run of the issue lifecycle against a real sandbox repository (STABILIZATION-PLAN.md item 2.10).
.DESCRIPTION
Creates a fixture issue in the sandbox repository and drives it through intake, plan, start and implement with
scripts/route-state.ps1 and the real `gh`, using canned agent results instead of a model. It proves, on every release
candidate, that the router's label, comment and state handling still works against live GitHub, which is where
several post-merge failures came from. It spends no tokens and touches no repository other than the sandbox. The
fixture issue is always closed afterwards, pass or fail. Exit 0 and a JSON summary on success; exit 1 with the failing
step in `reason` otherwise.
#>
[CmdletBinding()]
param(
    [string]$Repo = $(if ($env:FACTORY_FIXTURE_REPO) { $env:FACTORY_FIXTURE_REPO } else { 'bin0110001/cezar-factory-sandbox' }),
    [string]$GhCommand = 'gh'
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$route = Join-Path $PSScriptRoot 'route-state.ps1'
. (Join-Path $PSScriptRoot 'lifecycle-lib.ps1')
$lifecycle = Get-FactoryLifecycle
$state = $lifecycle.Initial
$work = Join-Path ([IO.Path]::GetTempPath()) ('fixture-lifecycle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$env:GH_REPO = $Repo
$steps = [System.Collections.Generic.List[string]]::new()
$issue = 0
$failed = $false

function Invoke-Gh {
    $out = & $GhCommand @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') failed ($LASTEXITCODE): $($out | Out-String)" }
    $out
}
function Get-Labels { @((Invoke-Gh issue view $issue --json labels | Out-String | ConvertFrom-Json).labels | ForEach-Object { $_.name }) }
# The success path is the first exit the model declares for the event from the issue's current state, so the
# expected states come from policies/lifecycle.json and not from this script.
function Step([string]$Event, $Result) {
    $exit = @($lifecycle.States[$script:state]['exits'] | Where-Object { $_ -and $_['on'] -eq $Event }) | Select-Object -First 1
    if (-not $exit) { throw "the lifecycle model has no exit on $Event from $($script:state)" }
    $ExpectState = [string]$exit['to']
    $file = Join-Path $work "$Event.json"
    if ($Result) { $Result | ConvertTo-Json -Depth 5 | Set-Content -Path $file -Encoding utf8 }
    $routeArgs = @{ Event = $Event; ProjectPath = $work; GhCommand = $GhCommand }
    if ($Result) { $routeArgs.Path = $file } else { $routeArgs.Issue = $issue }
    $output = & pwsh -NoProfile -File $route @routeArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "route-state $Event refused: $($output.Trim())" }
    $states = @(Get-Labels | Where-Object { $_ -like 'factory:*' })
    if ($states.Count -ne 1 -or $states[0] -ne $ExpectState) { throw "after $Event the issue has [$($states -join ', ')], expected $ExpectState" }
    $script:state = $ExpectState
    $steps.Add("$Event -> $ExpectState")
}

try {
    # The sandbox is a plain repository: make sure the Factory's labels exist before using them.
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'create-labels.ps1') -Repo $Repo *>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "create-labels.ps1 failed for $Repo" }
    $title = 'Fixture lifecycle run ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $url = (Invoke-Gh issue create --title $title --body 'Created and closed by the Factory fixture canary. Safe to ignore.' --label $lifecycle.Initial | Out-String).Trim()
    if ($url -notmatch '/issues/(\d+)') { throw "could not read the fixture issue number from: $url" }
    $issue = [int]$Matches[1]
    Step 'intake-result' @{ issue = $issue; type = 'type:maintenance'; risk = 'risk:low'; summary = 'fixture'; unresolvedQuestions = '' }
    Step 'plan-result' @{ issue = $issue; objective = 'fixture'; acceptanceCriteria = 'none'; nonGoals = 'none'; risks = 'none'; dependencies = 'none'; suggestedWorkBreakdown = '1. nothing'; requiredProjectSkills = @('none'); unresolvedQuestions = ''; complexity = 'complexity:small'; readyNotReadyStatus = 'ready' }
    Step 'start' $null
    Step 'implement-result' @{ issue = $issue; status = 'success'; summary = 'fixture'; filesChanged = @('none'); testsRun = @('none'); testResult = 'pass'; acceptanceCriteriaStatus = 'met'; documentationUpdated = $true; knownConcerns = ''; followUpSuggestions = ''; durableKnowledgeCandidates = ''; pr = "https://github.com/$Repo/pull/1" }
    $comments = @((Invoke-Gh issue view $issue --json comments | Out-String | ConvertFrom-Json).comments).Count
    if ($comments -lt 3) { throw "expected the router to post at least 3 comments, found $comments" }
    $steps.Add("comments=$comments")
    Write-Output (@{ status = 'passed'; repo = $Repo; issue = $issue; steps = @($steps) } | ConvertTo-Json -Compress)
}
catch {
    Write-Output (@{ status = 'failed'; repo = $Repo; issue = $issue; steps = @($steps); reason = $_.Exception.Message } | ConvertTo-Json -Compress)
    $failed = $true
}
finally {
    if ($issue -gt 0) {
        try { Invoke-Gh issue close $issue --comment 'Fixture run finished; closing.' | Out-Null }
        catch { Write-Warning "could not close fixture issue #${issue}: $($_.Exception.Message)" }
    }
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($failed) { exit 1 }
