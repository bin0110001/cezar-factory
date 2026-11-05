#!/usr/bin/env pwsh
<#
.SYNOPSIS
Local operator tool for the fix -> push -> deploy -> verify loop. Used by the ship-* skills.
.DESCRIPTION
Actions:
  Config  Print the resolved project settings and Cezar API scope.
  Deploy  Promote the current commit to origin/stable (tests gate it), force the Bazzite autodeploy,
          and confirm the host checkout is on the promoted SHA.
  Verify  Re-run the Factory automation that exercised the issue (budgeted by maxDeployAttempts).
  Status  Report the state of a run (optionally -Wait until it finishes).
Settings come from .claude/ship/ship-loop.json (add a project entry to extend); Cezar API location
comes from the host-local config/factory-projects.json (matching factoryProjectId) or CEZ_API_URL.
Attempt history lives in .factory/ship-loop/<project>-<issue>.json.
Exit codes: 0 ok / passed, 2 bad input or config, 3 attempt budget exhausted, 4 blocked (host or
target not configured), 5 verification failed, 6 still running (Status without -Wait finishing).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Config', 'Deploy', 'Verify', 'Status')][string]$Action,
    [string]$Project = '',
    [int]$Issue = 0,
    [string]$Automation = '',
    [string]$RunId = '',
    [switch]$Wait,
    [int]$PollSeconds = 20,
    [switch]$DryRun
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$root = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()

function Fail([int]$Code, [string]$Message) { Write-Host "SHIP_ERROR $Message"; exit $Code }

$settings = Get-Content -Raw (Join-Path $PSScriptRoot 'ship-loop.json') | ConvertFrom-Json
if (-not $Project) { $Project = $settings.defaultProject }
$cfg = $settings.projects.$Project
if (-not $cfg) { Fail 2 "project '$Project' is not defined in .claude/ship/ship-loop.json" }

function Get-ApiScope {
    $apiUrl = $env:CEZ_API_URL; $projectId = $env:CEZ_PROJECT_ID
    $registry = Join-Path $root 'config/factory-projects.json'
    if ((-not $apiUrl) -and (Test-Path $registry)) {
        $entry = @(Get-Content -Raw $registry | ConvertFrom-Json) | Where-Object { $_.projectId -eq $cfg.factoryProjectId } | Select-Object -First 1
        if ($entry) { $apiUrl = $entry.apiUrl; $projectId = $entry.projectId }
    }
    if (-not $apiUrl) { Fail 4 "no Cezar apiUrl for '$($cfg.factoryProjectId)': add it to config/factory-projects.json or set CEZ_API_URL" }
    $base = "$($apiUrl.TrimEnd('/'))/api/v1"
    if ($projectId) { $base = "$base/p/$([uri]::EscapeDataString($projectId))" }
    $base
}
function Invoke-Api([string]$Method, [string]$Path, $Body) {
    $p = @{ Method = $Method; Uri = "$(Get-ApiScope)$Path"; ContentType = 'application/json'; TimeoutSec = 30 }
    if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 10) }
    Invoke-RestMethod @p
}
function Get-StatePath { Join-Path $root ".factory/ship-loop/$Project-$Issue.json" }
function Read-State {
    $path = Get-StatePath
    if (Test-Path $path) { Get-Content -Raw $path | ConvertFrom-Json } else { [pscustomobject]@{ project = $Project; issue = $Issue; attempts = @() } }
}
function Save-State($State) {
    $path = Get-StatePath
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    $State | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding utf8
}
function Get-TopologyValue([string]$Key) {
    $file = Join-Path $root 'config/server-topology.env'
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in Get-Content $file) {
        if ($line -match "^\s*(export\s+)?$Key=(.*)$") { return $Matches[2].Trim().Trim('"').Trim("'") }
    }
    $null
}
function Get-RunOutcome([string]$Id) {
    $run = Invoke-Api GET "/runs/$([uri]::EscapeDataString($Id))" $null
    $outcome = switch ($run.status) {
        'done' { 'passed' }
        { $_ -in 'failed', 'cancelled' } { 'failed' }
        default { 'running' }
    }
    [pscustomobject]@{ runId = $Id; status = $run.status; outcome = $outcome }
}

switch ($Action) {
    'Config' {
        $cfg | ConvertTo-Json -Depth 10
        Write-Host "API scope: $(Get-ApiScope)"
    }

    'Deploy' {
        $promote = Join-Path $root 'scripts/release/promote-stable.ps1'
        if ($cfg.deploy.promoteStable) {
            $args2 = @('-NoProfile', '-File', $promote); if ($DryRun) { $args2 += '-DryRun' }
            & pwsh @args2
            if ($LASTEXITCODE -ne 0) { Fail 5 "promote-stable failed ($LASTEXITCODE); nothing was deployed" }
        }
        $target = Get-TopologyValue 'BAZZITE_SSH_TARGET'
        $dir = Get-TopologyValue 'BAZZITE_FACTORY_DIR'
        if (-not $target -or -not $dir) { Fail 4 'BAZZITE_SSH_TARGET / BAZZITE_FACTORY_DIR missing from config/server-topology.env; promoted to stable, host not deployed (timer will pick it up within 5 minutes)' }
        if ($DryRun) { Write-Host "DRYRUN would run autodeploy on ${target}:${dir}"; break }
        if ($cfg.deploy.hostForce) {
            & ssh -o BatchMode=yes -o ConnectTimeout=10 $target "cd '$dir' && scripts/deploy/factory-autodeploy.sh --force"
            $code = $LASTEXITCODE
            if ($code -in 20, 21, 22) { Fail 4 "autodeploy BLOCKED (exit ${code}: 20 dirty checkout, 21 diverged, 22 container/host mismatch); host untouched" }
            if ($code -ne 0) { Fail 5 "autodeploy failed (exit $code)" }
        }
        & git -C $root fetch origin stable --quiet
        $want = (& git -C $root rev-parse origin/stable).Trim()
        $have = (& ssh -o BatchMode=yes $target "git -C '$dir' rev-parse HEAD").Trim()
        if ($have -ne $want) { Fail 5 "host checkout is at $have but stable is $want" }
        Write-Host "SHIP_DEPLOYED sha=$want host=${target}"
    }

    'Verify' {
        if ($Issue -le 0) { Fail 2 '-Issue is required' }
        $state = Read-State
        $max = [int]$cfg.maxDeployAttempts
        $used = @($state.attempts).Count
        if ($used -ge $max) { Fail 3 "attempt budget exhausted ($used of $max) for issue #$Issue; a human must decide what to do next" }
        if (-not $Automation) { $Automation = $cfg.verify.defaultAutomation }
        if (-not $Automation) { Fail 2 '-Automation is required (no verify.defaultAutomation configured)' }
        $list = @(Invoke-Api GET '/automations' $null)
        $match = $list | Where-Object { $_.id -eq $Automation -or $_.name -eq $Automation -or $_.name -eq "[factory] $Automation" } | Select-Object -First 1
        if (-not $match) { Fail 2 "automation '$Automation' not found in Cezar project" }
        if ($DryRun) { Write-Host "DRYRUN would queue '$($match.name)' (id $($match.id)); attempt $($used + 1) of $max"; break }
        & git -C $root fetch origin stable --quiet
        $sha = (& git -C $root rev-parse origin/stable).Trim()
        $isSchedule = $match.kind -eq 'schedule'
        $resp = if ($isSchedule) { Invoke-Api POST "/automations/$($match.id)/run" $null } else { Invoke-Api POST "/automations/$($match.id)/check" @{ mode = 'execute' } }
        $attempt = [ordered]@{
            attempt = $used + 1; automation = $match.name; automationId = $match.id; sha = $sha
            runId = $resp.runId; checkId = $resp.checkId; queuedAt = (Get-Date).ToUniversalTime().ToString('o'); outcome = 'running'
        }
        $state.attempts = @($state.attempts) + [pscustomobject]$attempt
        Save-State $state
        Write-Host "SHIP_QUEUED $(($attempt | ConvertTo-Json -Compress))"
    }

    'Status' {
        if (-not $RunId -and $Issue -gt 0) {
            $last = @((Read-State).attempts) | Select-Object -Last 1
            if (-not $last) { Fail 2 "no recorded attempts for issue #$Issue" }
            $RunId = $last.runId
            if (-not $RunId) { Fail 6 "attempt $($last.attempt) was a GitHub-event check ($($last.checkId)); its run id is not recorded yet. Check the Cezar cockpit run list." }
        }
        if (-not $RunId) { Fail 2 '-RunId or -Issue is required' }
        $timeout = [DateTime]::UtcNow.AddMinutes([int]$cfg.verifyTimeoutMinutes)
        do {
            $result = Get-RunOutcome $RunId
            if ($result.outcome -ne 'running' -or -not $Wait) { break }
            Start-Sleep -Seconds $PollSeconds
        } while ([DateTime]::UtcNow -lt $timeout)
        if ($Issue -gt 0 -and $result.outcome -ne 'running') {
            $state = Read-State
            foreach ($a in @($state.attempts)) { if ($a.runId -eq $RunId) { $a.outcome = $result.outcome } }
            Save-State $state
        }
        Write-Host "SHIP_STATUS $(($result | ConvertTo-Json -Compress))"
        if ($result.outcome -eq 'failed') { exit 5 }
        if ($result.outcome -eq 'running') { exit 6 }
    }
}
