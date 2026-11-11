#!/usr/bin/env pwsh
<#
.SYNOPSIS
Local operator tool for the fix -> push -> deploy -> verify loop. Used by the ship-* skills.
.DESCRIPTION
Actions:
  Config  Print the resolved project settings and Cezar API scope.
  Deploy  Nudge the host promoter and watch the merged dev head through validation, dev activation,
          canaries, stable, and the stable deploy. Never promotes by hand.
  Verify  Re-run the Factory automation that exercised the issue (budgeted by maxDeployAttempts).
  Status  Report the state of a run (optionally -Wait until it finishes).
  Run     Run one Factory workflow headless from THIS checkout (-Workflow, -Task) with the repo's built
          cezar CLI, so an agent can edit the workflow and run it again without deploying. Each call
          restarts from the first step and is budgeted by maxRunAttempts. Prints ITER_* lines.
          Exit 0 workflow done, 5 workflow failed, 3 budget spent. -JobDebug sets FACTORY_JOB_DEBUG=1 so
          scripts send model calls to the local model and skip push/PR/budget side effects.
Settings come from .claude/ship/ship-loop.json (add a project entry to extend); Cezar API location
comes from the host-local config/factory-projects.json (matching factoryProjectId) or CEZ_API_URL.
Attempt history lives in .factory/ship-loop/<project>-<issue>.json.
Exit codes: 0 ok / passed, 2 bad input or config, 3 attempt budget exhausted, 4 blocked (host or
target not configured), 5 verification failed, 6 still running (Status without -Wait finishing).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Config', 'Deploy', 'Verify', 'Status', 'Run')][string]$Action,
    [string]$Workflow = '',
    [string]$Task = '',
    [string]$Target = '',
    [string]$Model = '',
    [string]$Project = '',
    [int]$Issue = 0,
    [string]$Automation = '',
    [string]$RunId = '',
    [switch]$Wait,
    [int]$PollSeconds = 20,
    [string]$Sha = '',
    [switch]$DryRun,
    [switch]$JobDebug
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
        # A thin client: promotion belongs to the host promoter (docs/promotion-pipeline.md). Nothing here moves a
        # channel pointer or origin/stable; it nudges the promoter and reports the state of the dev head.
        $target = (Get-TopologyValue 'FACTORY_CONTROL_PLANE_SSH_TARGET')
        $dir = (Get-TopologyValue 'FACTORY_CONTROL_PLANE_FACTORY_DIR')
        if (-not $target -or -not $dir) { Fail 4 'FACTORY_CONTROL_PLANE_SSH_TARGET / FACTORY_CONTROL_PLANE_FACTORY_DIR missing from config/server-topology.env' }
        & git -C $root fetch origin dev --quiet
        $head = (& git -C $root rev-parse origin/dev).Trim()
        if ($Sha) {
            # Explicit commit (a squash-merged PR's merge commit): it only has to be on origin/dev, so the guard
            # below, which compares local files, cannot refuse it just because other PRs landed after it.
            $pinned = (& git -C $root rev-parse "$Sha^{commit}").Trim()
            & git -C $root merge-base --is-ancestor $pinned $head
            if ($LASTEXITCODE -ne 0) { Fail 2 "-Sha $($pinned.Substring(0, 9)) is not on origin/dev ($($head.Substring(0, 9))); merge it to dev first" }
            $head = $pinned
            Write-Host "SHIP_PROGRESS watching pinned commit $($head.Substring(0, 9)), on origin/dev"
        } else {
        & git -C $root merge-base --is-ancestor HEAD $head
        if ($LASTEXITCODE -ne 0) {
            # A squash merge never makes the local commit an ancestor: accept it when every file the local work
            # changed (relative to origin/dev's merge base) is byte-identical on origin/dev.
            $base = (& git -C $root merge-base HEAD $head).Trim()
            $files = @(& git -C $root diff --name-only $base HEAD)
            $differs = if ($files.Count -gt 0) { & git -C $root diff --name-only HEAD $head -- @files } else { @() }
            if ($files.Count -eq 0 -or @($differs).Count -gt 0) { Fail 2 "local HEAD is not on origin/dev ($($head.Substring(0, 9))); merge the fix to dev first, the promoter only promotes merged work" }
            Write-Host "SHIP_PROGRESS local work is on origin/dev via a squash merge ($($head.Substring(0, 9)))"
        }
        }
        if ($DryRun) { Write-Host "DRYRUN would nudge the promoter on ${target} and wait for $($head.Substring(0, 9)) to reach stage stable-deployed"; break }
        & ssh -o BatchMode=yes -o ConnectTimeout=10 $target 'systemctl --user start --no-block factory-local-promotion.service'
        $deadline = [DateTime]::UtcNow.AddMinutes([int]$cfg.deploy.timeoutMinutes)
        $last = ''
        do {
            $json = & ssh -o BatchMode=yes -o ConnectTimeout=10 $target "cd '$dir' && python3 scripts/release/factory_local_scheduler.py status --sha $head" 2>$null
            $state = try { $json | ConvertFrom-Json } catch { $null }
            if ($state) {
                $line = "status=$($state.status) stage=$($state.stage) breakerOpen=$($state.breakerOpen)"
                if ($line -ne $last) { Write-Host "SHIP_PROGRESS $line"; $last = $line }
                if ($state.stage -eq 'stable-deployed') { Write-Host "SHIP_DEPLOYED sha=$head host=${target}"; exit 0 }
                if ($state.status -eq 'failed') { Fail 5 "promotion of $($head.Substring(0, 9)) failed: $($state.reason). The previous release stays active; fix on dev, the next merge is promoted automatically." }
                if ($state.status -eq 'blocked') { Fail 4 "promotion of $($head.Substring(0, 9)) is blocked: $($state.reason)" }
                if ($state.breakerOpen) { Fail 4 'the promotion circuit breaker is open after repeated failures; see the [promotion] issues, then factory_local_scheduler.py reset-breaker' }
            }
            Start-Sleep -Seconds ([int]$cfg.deploy.pollSeconds)
        } while ([DateTime]::UtcNow -lt $deadline)
        Fail 6 "promotion of $($head.Substring(0, 9)) is still in progress after $($cfg.deploy.timeoutMinutes) minutes ($last); re-run Deploy to keep watching"
    }

    'Verify' {
        if ($Issue -le 0) { Fail 2 '-Issue is required' }
        $state = Read-State
        $max = [int]$cfg.maxDeployAttempts
        $used = @($state.attempts).Count
        if ($used -ge $max) { Fail 3 "attempt budget exhausted ($used of $max) for issue #$Issue; a human must decide what to do next" }
        if (-not $Automation) { $Automation = $cfg.verify.defaultAutomation }
        if (-not $Automation) { Fail 2 '-Automation is required (no verify.defaultAutomation configured)' }
        $resp0 = Invoke-Api GET '/automations' $null; $list = @(if ($resp0.automations) { $resp0.automations } else { $resp0 })
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

    'Run' {
        # Headless local iteration: no Cezar server, no deploy. Workflows come from this checkout's workflows/
        # (via CEZ_SHARED_WORKFLOWS_DIRS) and their command steps get FACTORY_RUNTIME_ROOT pointing here.
        if (-not $Workflow) { Fail 2 '-Workflow is required' }
        if (-not $Task) { Fail 2 '-Task is required (the text the workflow receives as {{task}})' }
        # Accept the file name (health) or the workflow's own name (factory-health); cezar run wants the latter.
        $known = foreach ($f in Get-ChildItem (Join-Path $root 'workflows') -Filter '*.yaml') {
            $n = (Select-String -Path $f.FullName -Pattern '^name:\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
            [pscustomobject]@{ file = $f.BaseName; name = $n }
        }
        $hit = @($known | Where-Object { $_.file -eq $Workflow -or $_.name -eq $Workflow }) | Select-Object -First 1
        if (-not $hit) { Fail 2 "workflow '$Workflow' not found; available: $(($known | ForEach-Object { $_.name }) -join ', ')" }
        $Workflow = $hit.name
        $cli = Join-Path $root 'cezar/packages/cezar/dist/index.js'
        $targetDir = if ($Target) { (Resolve-Path $Target).Path } else { $root }
        $max = [int]$cfg.maxRunAttempts; if ($max -le 0) { $max = 10 }
        $key = "run-$($Workflow -replace '[^A-Za-z0-9._-]', '_')"
        $statePath = Join-Path $root ".factory/ship-loop/$Project-$key.json"
        $state = if (Test-Path $statePath) { Get-Content -Raw $statePath | ConvertFrom-Json } else { [pscustomobject]@{ project = $Project; workflow = $Workflow; attempts = @() } }
        $used = @($state.attempts).Count
        if ($used -ge $max) { Fail 3 "run budget exhausted ($used of $max) for workflow '$Workflow'; delete $statePath to reset, or ask the user" }
        $cliArgs = @($cli, 'run', $Task, '--workflow', $Workflow)
        if ($Model) { $cliArgs += @('--model', $Model) }
        if ($DryRun) { Write-Host "DRYRUN would run: node $($cliArgs -join ' ') in $targetDir (attempt $($used + 1) of $max)"; break }
        if (-not (Test-Path $cli)) { Fail 4 'cezar is not built: run `npm run build` in cezar/packages/cezar first' }
        $env:FACTORY_RUNTIME_ROOT = $root
        $env:CEZ_SHARED_WORKFLOWS_DIRS = Join-Path $root 'workflows'
        $env:CEZ_SHARED_SKILL_DIRS = Join-Path $root 'skills'
        Remove-Item Env:CEZ_FACTORY_RELEASE_STORE -ErrorAction SilentlyContinue
        # Job debug mode: command steps that call a model use the local endpoint and publish nothing.
        if ($JobDebug) { $env:FACTORY_JOB_DEBUG = '1'; Write-Host 'ITER_DEBUG local-model job debug mode on (FACTORY_JOB_DEBUG=1)' }
        $logDir = Join-Path $root '.factory/ship-loop/logs'
        New-Item -ItemType Directory -Force $logDir | Out-Null
        $log = Join-Path $logDir ("$key-$($used + 1)-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
        Write-Host "ITER_RUN workflow=$Workflow attempt=$($used + 1) of $max log=$log"
        Push-Location $targetDir
        try { & node @cliArgs *>&1 | Tee-Object -FilePath $log | Out-Host; $code = $LASTEXITCODE } finally { Pop-Location }
        $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
        $lastStep = ($lines | Where-Object { $_ -match '^── step:' } | Select-Object -Last 1)
        $outcome = if ($code -eq 0) { 'passed' } else { 'failed' }
        $state.attempts = @($state.attempts) + [pscustomobject]@{ attempt = $used + 1; outcome = $outcome; exitCode = $code; log = $log; lastStep = $lastStep; at = (Get-Date).ToUniversalTime().ToString('o') }
        New-Item -ItemType Directory -Force (Split-Path $statePath) | Out-Null
        $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding utf8
        if ($code -eq 0) { Write-Host "ITER_DONE workflow=$Workflow attempt=$($used + 1) log=$log"; break }
        Write-Host "ITER_STEP_FAILED $lastStep"
        foreach ($e in @($lines | Where-Object { $_ -match '^\s*✗' } | Select-Object -Last 3)) { Write-Host "ITER_ERROR $($e.Trim())" }
        Write-Host "ITER_FAILED workflow=$Workflow attempt=$($used + 1) of $max log=$log"
        exit 5
    }
}
