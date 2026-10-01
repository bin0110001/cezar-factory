#!/usr/bin/env pwsh
# Factory self-test: static checks plus install/update/diff/verify scenarios against fixture projects.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scripts = Join-Path $factory 'scripts'
. (Join-Path $scripts 'lib.ps1')

$script:fail = 0
function Assert([string]$Name, [bool]$Cond) {
    if ($Cond) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:fail++ }
}
function With($Base, $Over) { $h = $Base.Clone(); foreach ($k in $Over.Keys) { $h[$k] = $Over[$k] }; $h }
function Run([string]$Script, [hashtable]$Args2) {
    $global:LASTEXITCODE = 0
    try { $out = & (Join-Path $scripts $Script) @Args2 *>&1 | Out-String }
    catch { $out = $_.Exception.Message; $global:LASTEXITCODE = 1 }
    [pscustomobject]@{ Code = $global:LASTEXITCODE; Out = $out }
}

function Copy-Factory([string]$From, [string]$To) {
    New-Item -ItemType Directory $To | Out-Null
    Get-ChildItem $From -Force | Where-Object { $_.Name -notin '.git', 'tests' } | Copy-Item -Destination $To -Recurse
}

# ---- Static checks -------------------------------------------------------
Write-Host '== static =='
$required = 'README.md', 'VERSION', 'CHANGELOG.md', 'policies/labels.yaml', 'policies/retry.yaml', 'policies/risk.yaml',
'policies/definition-of-ready.md', 'policies/definition-of-done.md', 'policies/escalation.md',
'templates/factory.config.yaml', 'templates/gitignore.fragment', 'docs/lifecycle.md', 'docs/synchronization.md', 'docs/project-integration.md'
foreach ($f in $required) { Assert "exists $f" (Test-Path (Join-Path $factory $f)) }
Assert 'VERSION is semver' (Test-SemVer (Get-FactoryVersion $factory))
foreach ($f in Get-ChildItem (Join-Path $factory 'schemas') -Filter *.json) {
    $ok = $true; try { Get-Content -Raw $f.FullName | ConvertFrom-Json | Out-Null } catch { $ok = $false }
    Assert "valid JSON schemas/$($f.Name)" $ok
}
foreach ($f in Get-ChildItem $factory -Recurse -Include *.yaml -File | Where-Object { $_.FullName -notmatch 'tests|node_modules' }) {
    $t = Get-Content -Raw $f.FullName
    Assert "yaml sane $($f.Name)" (-not $t.Contains("`t") -and $t.Trim().Length -gt 0)
}
foreach ($d in Get-ChildItem (Join-Path $factory 'skills') -Directory) {
    $p = Join-Path $d.FullName 'SKILL.md'
    Assert "skill $($d.Name) has SKILL.md" ((Test-Path $p) -and ((Get-Content -Raw $p) -match '(?m)^# '))
}
$allowedPlaceholders = 'github.kind', 'github.number', 'github.title', 'github.url', 'github.author', 'github.assignees', 'github.labels', 'github.event', 'date', 'time', 'project', 'automation'
foreach ($f in Get-ChildItem (Join-Path $factory 'automations') -Filter *.json) {
    $d = Get-Content -Raw $f.FullName | ConvertFrom-Json
    Assert "automation $($f.Name) name prefixed" $d.name.StartsWith('[factory] ')
    Assert "automation $($f.Name) workflow exists" (Test-Path (Join-Path $factory "workflows/$($d.task.workflow -replace '^factory-', '').yaml"))
    $ph = [regex]::Matches($d.task.prompt, '\{\{([^}]+)\}\}') | ForEach-Object { $_.Groups[1].Value }
    Assert "automation $($f.Name) placeholders allowed" (-not ($ph | Where-Object { $allowedPlaceholders -notcontains $_ }))
    if ($d.kind -eq 'github') {
        Assert "automation $($f.Name) poll keys" ($d.events -and $d.intervalSeconds -ge 60 -and $d.filters)
        if ($d.events -contains 'issue.labeled') { Assert "automation $($f.Name) changedLabels" ([bool]$d.filters.changedLabels) }
    }
    else { Assert "automation $($f.Name) schedule" ([bool]$d.schedule) }
}
# Workflows must satisfy Cezar's schema: unique ids, agent XOR check steps, onFail.retry -> earlier step.
foreach ($f in Get-ChildItem (Join-Path $factory 'workflows') -Filter *.yaml) {
    $ids = @(); $cur = $null; $steps = @()
    foreach ($l in Get-Content $f.FullName) {
        if ($l -match '^  - id:\s*(\S+)') { $cur = @{ id = $Matches[1]; agent = $false; check = $false; retry = $null }; $steps += $cur }
        elseif ($cur -and $l -match '^    (skill|prompt):') { $cur.agent = $true }
        elseif ($cur -and $l -match '^    command:') { $cur.check = $true }
        elseif ($cur -and $l -match '^      retry:\s*(\S+)') { $cur.retry = $Matches[1] }
    }
    $t = Get-Content -Raw $f.FullName
    Assert "workflow $($f.Name) name factory-$($f.BaseName)" ($t -match "(?m)^name:\s*factory-$($f.BaseName)\s*$")
    Assert "workflow $($f.Name) has steps" ($steps.Count -ge 1)
    Assert "workflow $($f.Name) steps agent XOR check" (-not ($steps | Where-Object { $_.agent -eq $_.check }))
    Assert "workflow $($f.Name) unique ids" (@($steps.id | Sort-Object -Unique).Count -eq $steps.Count)
    $okRetry = $true
    for ($i = 0; $i -lt $steps.Count; $i++) { if ($steps[$i].retry) { $earlier = @(); if ($i -gt 0) { $earlier = @($steps[0..($i - 1)] | ForEach-Object { $_.id }) }; if ($earlier -notcontains $steps[$i].retry) { $okRetry = $false } } }
    Assert "workflow $($f.Name) retry targets earlier step" $okRetry
}

# ---- Scenarios -----------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) "factory-tests-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory $tmp | Out-Null
try {
    foreach ($fx in Get-ChildItem (Join-Path $PSScriptRoot 'fixtures') -Directory) {
        Write-Host "== fixture $($fx.Name) =="
        $proj = Join-Path $tmp $fx.Name
        Copy-Item $fx.FullName $proj -Recurse
        $fdir = Join-Path $proj '.ai/factory'
        $a = @{ ProjectPath = $proj; FactoryPath = $factory }

        $r = Run 'install.ps1' (With $a @{ DryRun = $true })
        Assert 'install dry-run succeeds' ($r.Code -eq 0)
        Assert 'install dry-run writes nothing' (-not (Test-Path (Join-Path $fdir 'manifest.json')))

        $r = Run 'install.ps1' $a
        Assert 'install succeeds' ($r.Code -eq 0)
        Assert 'managed marker on skill' ((Get-Content -Raw (Join-Path $proj '.ai/skills/factory-plan/SKILL.md')) -match 'managed-by: cezar-factory')
        Assert 'managed marker on workflow' ((Get-Content -Raw (Join-Path $proj '.ai/cezar/workflows/factory-plan.yaml')) -match 'GENERATED BY CEZAR-FACTORY')
        Assert 'maintenance workflow not installed' (-not (Test-Path (Join-Path $proj '.ai/cezar/workflows/factory-maintenance.yaml')))
        Assert 'maintenance automation not installed' (-not (Test-Path (Join-Path $fdir 'automations/maintenance.json')))
        Assert 'verify passes' ((Run 'verify.ps1' $a).Code -eq 0)
        Assert 'diff clean' ((Run 'diff.ps1' $a).Code -eq 0)
        Assert 'reinstall idempotent' ((Run 'install.ps1' $a).Code -eq 0)

        # Drift detection
        $target = Join-Path $proj '.ai/skills/factory-plan/SKILL.md'
        $orig = [IO.File]::ReadAllText($target)
        Add-Content $target 'local edit'
        Assert 'diff detects modified file' ((Run 'diff.ps1' $a).Code -ne 0)
        Assert 'update refuses modified managed file' ((Run 'update.ps1' $a).Code -ne 0)
        [IO.File]::WriteAllText($target, $orig)
        Remove-Item (Join-Path $fdir 'policies/escalation.md')
        Assert 'diff detects missing file' ((Run 'diff.ps1' $a).Code -ne 0)
        Assert 'update restores missing file' ((Run 'update.ps1' $a).Code -eq 0)
        Write-Utf8 (Join-Path $proj '.ai/skills/factory-stray/SKILL.md') "# stray`n"
        Assert 'diff detects unmanaged file' ((Run 'diff.ps1' $a).Code -ne 0)
        Remove-Item (Join-Path $proj '.ai/skills/factory-stray') -Recurse
        Assert 'diff clean after cleanup' ((Run 'diff.ps1' $a).Code -eq 0)

        # Override validity
        Write-Utf8 (Join-Path $fdir 'overrides/workflows/nonexistent.yaml') "name: x`n"
        Assert 'verify rejects override of unknown component' ((Run 'verify.ps1' $a).Code -ne 0)
        Remove-Item (Join-Path $fdir 'overrides') -Recurse

        # Upgrade to a synthetic 0.2.0: change a policy, add a policy, drop another (obsolete).
        $f2 = Join-Path $tmp "factory-0.2.0-$($fx.Name)"
        Copy-Factory $factory $f2
        Set-Content (Join-Path $f2 'VERSION') '0.2.0'
        Add-Content (Join-Path $f2 'skills/factory-review/SKILL.md') "`nUpgrade note."
        Write-Utf8 (Join-Path $f2 'policies/new-policy.md') "# New policy`n"
        Remove-Item (Join-Path $f2 'policies/risk.yaml')
        $cfgPath = Join-Path $fdir 'factory.config.yaml'
        $cfgText = Get-Content -Raw $cfgPath
        $a2 = @{ ProjectPath = $proj; FactoryPath = $f2 }
        Assert 'update refuses without pin change' ((Run 'update.ps1' $a2).Code -ne 0)
        Set-Content $cfgPath ($cfgText -replace '(?m)^(\s*version:\s*)"0\.1\.0"', '${1}"0.2.0"') -NoNewline
        $r = Run 'update.ps1' (With $a2 @{ DryRun = $true })
        Assert 'update dry-run succeeds' ($r.Code -eq 0)
        Assert 'update dry-run changes nothing' (Test-Path (Join-Path $fdir 'policies/risk.yaml'))
        $r = Run 'update.ps1' $a2
        Assert 'update to 0.2.0 succeeds' ($r.Code -eq 0)
        Assert 'summary shows version transition' ($r.Out -match '0\.1\.0 -> 0\.2\.0')
        Assert 'new managed file added' (Test-Path (Join-Path $fdir 'policies/new-policy.md'))
        Assert 'obsolete managed file removed' (-not (Test-Path (Join-Path $fdir 'policies/risk.yaml')))
        Assert 'changed skill updated' ((Get-Content -Raw (Join-Path $proj '.ai/skills/factory-review/SKILL.md')) -match 'Upgrade note')
        Assert 'project skill preserved' (Test-Path (Join-Path $proj '.ai/skills/project-testing/SKILL.md'))
        Assert 'project config preserved' ((Get-Content -Raw $cfgPath) -match 'type: ')
        Assert 'verify passes at 0.2.0' ((Run 'verify.ps1' $a2).Code -eq 0)

        # Rollback: restore pin, run against the old factory.
        Set-Content $cfgPath $cfgText -NoNewline
        $r = Run 'update.ps1' $a
        Assert 'rollback to 0.1.0 succeeds' ($r.Code -eq 0)
        Assert 'rollback restores removed file' (Test-Path (Join-Path $fdir 'policies/risk.yaml'))
        Assert 'rollback removes 0.2.0-only file' (-not (Test-Path (Join-Path $fdir 'policies/new-policy.md')))
        Assert 'diff clean after rollback' ((Run 'diff.ps1' $a).Code -eq 0)

        # Ambiguity: unmanaged file already sits at a managed path.
        Remove-Item (Join-Path $fdir 'manifest.json')
        Add-Content (Join-Path $fdir 'policies/labels.yaml') '# hand edit'
        Assert 'install refuses ambiguous ownership' ((Run 'install.ps1' $a).Code -ne 0)
    }

    # ---- Runtime scripts, run from an installed project -------------------
    Write-Host '== runtime scripts =='
    $rp = Join-Path $tmp 'runtime-project'
    Copy-Item (Join-Path $PSScriptRoot 'fixtures/generic-project') $rp -Recurse
    & (Join-Path $scripts 'install.ps1') -ProjectPath $rp -FactoryPath $factory *>&1 | Out-Null
    $val = Join-Path $rp '.ai/factory/scripts/validate-result.ps1'
    $route = Join-Path $rp '.ai/factory/scripts/route-state.ps1'
    $gh = Join-Path $PSScriptRoot 'fake-gh.ps1'
    $env:FAKE_GH_STATE = Join-Path $tmp 'gh-state.json'
    function Test-Validate([string]$Kind, $Obj) {
        $f = Join-Path $tmp "r-$Kind.json"; ($Obj | ConvertTo-Json -Depth 5) | Set-Content $f
        $global:LASTEXITCODE = 0; & $val -Kind $Kind -Path $f *>&1 | Out-Null; $global:LASTEXITCODE
    }
    function Set-Gh($Labels, $Comments = @()) { @{ labels = @($Labels); comments = @($Comments) } | ConvertTo-Json -Depth 5 | Set-Content $env:FAKE_GH_STATE }
    function Get-Gh { Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json }
    function Invoke-Route([string]$Event, $Obj, [int]$Issue = 0) {
        $f = Join-Path $tmp 'route-result.json'; if ($Obj) { ($Obj | ConvertTo-Json -Depth 5) | Set-Content $f }
        $global:LASTEXITCODE = 0
        $a = @{ Event = $Event; GhCommand = $gh }
        if ($Obj) { $a.Path = $f } else { $a.Issue = $Issue }
        & $route @a *>&1 | Out-Null; $global:LASTEXITCODE
    }
    $plan = @{ issue = 7; objective = 'o'; acceptanceCriteria = 'a'; nonGoals = 'n'; risks = 'r'; dependencies = 'd'; suggestedWorkBreakdown = '1. do'; requiredProjectSkills = @('s'); unresolvedQuestions = ''; readyNotReadyStatus = 'ready' }
    Assert 'validate: good plan passes' ((Test-Validate 'plan' $plan) -eq 0)
    Assert 'validate: ready plan with open questions fails' ((Test-Validate 'plan' (With $plan @{ unresolvedQuestions = 'which db?' })) -ne 0)
    $bad = $plan.Clone(); $bad.Remove('issue')
    Assert 'validate: missing issue fails' ((Test-Validate 'plan' $bad) -ne 0)
    Assert 'validate: not-ready plan with questions passes' ((Test-Validate 'plan' (With $plan @{ unresolvedQuestions = 'q'; readyNotReadyStatus = 'not-ready' })) -eq 0)
    $impl = @{ issue = 7; status = 'success'; summary = 's'; filesChanged = @('a.gd'); testsRun = @('t'); testResult = 'pass'; acceptanceCriteriaStatus = 'met'; knownConcerns = ''; followUpSuggestions = ''; durableKnowledgeCandidates = ''; pr = 'https://x/pr/1' }
    Assert 'validate: good implementation passes' ((Test-Validate 'implementation' $impl) -eq 0)
    $noPr = $impl.Clone(); $noPr.Remove('pr')
    Assert 'validate: success without PR fails' ((Test-Validate 'implementation' $noPr) -ne 0)
    $rev = @{ issue = 7; approvalChangeRequestStatus = 'change-request'; blockingFindings = ''; nonBlockingFindings = ''; acceptanceCriteriaVerification = 'v'; testAdequacy = 't'; riskObservations = 'r' }
    Assert 'validate: change-request without findings fails' ((Test-Validate 'review' $rev) -ne 0)
    Assert 'validate: change-request with findings passes' ((Test-Validate 'review' (With $rev @{ blockingFindings = 'bug at x' })) -eq 0)
    $inv = @{ issue = 7; failureClassification = 'flaky-test'; evidence = 'e'; attemptsReviewed = 'a'; rootCauseHypothesis = 'h'; confidence = 'high'; recommendedAction = 'retry'; automaticRetryAppropriate = $true }
    Assert 'validate: good investigation passes' ((Test-Validate 'investigation' $inv) -eq 0)
    Assert 'validate: unknown classification fails' ((Test-Validate 'investigation' (With $inv @{ failureClassification = 'gremlins' })) -ne 0)

    Set-Gh @('factory:needs-plan', 'type:bug')
    Assert 'route: plan ready -> factory:ready' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:needs-plan' -and (Get-Gh).labels -contains 'type:bug')
    Assert 'route: plan posted as comment' (@((Get-Gh).comments).Count -eq 1)
    Set-Gh @('factory:needs-plan', 'risk:high')
    Assert 'route: risk:high plan held for approval' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:needs-plan')
    Assert 'route: not-ready -> needs-help' ((Invoke-Route 'plan-result' (With $plan @{ readyNotReadyStatus = 'not-ready'; unresolvedQuestions = 'q' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:review')
    Assert 'route: plan-result from wrong state refused' ((Invoke-Route 'plan-result' $plan) -ne 0)
    Assert 'route: wrong-state refusal leaves labels alone' (((Get-Gh).labels -join ',') -eq 'factory:review')
    Set-Gh @('factory:ready')
    Assert 'route: start -> working' ((Invoke-Route 'start' $null 7) -eq 0 -and (Get-Gh).labels -contains 'factory:working' -and (Get-Gh).labels -notcontains 'factory:ready')
    Assert 'route: start is idempotent while working' ((Invoke-Route 'start' $null 7) -eq 0)
    Set-Gh @('factory:needs-plan')
    Assert 'route: start from needs-plan refused' ((Invoke-Route 'start' $null 7) -ne 0)
    Set-Gh @('factory:working')
    Assert 'route: implement success -> review' ((Invoke-Route 'implement-result' $impl) -eq 0 -and (Get-Gh).labels -contains 'factory:review')
    Set-Gh @('factory:working')
    Assert 'route: implement failure -> investigate' ((Invoke-Route 'implement-result' (With $impl @{ status = 'failure' })) -eq 0 -and (Get-Gh).labels -contains 'factory:investigate')
    Set-Gh @('factory:review')
    Assert 'route: review approval -> human-review' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval' })) -eq 0 -and (Get-Gh).labels -contains 'factory:human-review')
    Set-Gh @('factory:review')
    $chg = With $rev @{ blockingFindings = 'bug' }
    Assert 'route: review change-request -> changes-requested' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:changes-requested')
    Set-Gh @('factory:review') @('x <!-- factory:review-round -->', 'y <!-- factory:review-round -->')
    Assert 'route: review round limit escalates to needs-help' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help' -and (@((Get-Gh).comments)[-1] -match 'Recommended human decision'))
    Set-Gh @('factory:investigate')
    Assert 'route: investigate retry -> ready' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:ready')
    Set-Gh @('factory:investigate') @('<!-- factory:investigate-retry -->')
    Assert 'route: second investigation escalates' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:investigate')
    Assert 'route: low-confidence investigation escalates' ((Invoke-Route 'investigate-result' (With $inv @{ confidence = 'low' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:ready', 'factory:working', 'type:bug')
    Assert 'route: conflicting state labels collapse to one' ((Invoke-Route 'implement-result' $impl) -eq 0 -and @((Get-Gh).labels | Where-Object { $_ -like 'factory:*' }).Count -eq 1)

    # Project override fully replaces a factory file, and survives re-sync.
    $ovDir = Join-Path $rp '.ai/factory/overrides/policies'
    New-Item -ItemType Directory $ovDir -Force | Out-Null
    Write-Utf8 (Join-Path $ovDir 'retry.yaml') "max_implementation_retries: 5`nmax_review_fix_rounds: 3`n"
    $ra = @{ ProjectPath = $rp; FactoryPath = $factory }
    Assert 'override: update applies override' ((Run 'update.ps1' $ra).Code -eq 0 -and (Get-Content -Raw (Join-Path $rp '.ai/factory/policies/retry.yaml')) -match 'max_review_fix_rounds: 3')
    Assert 'override: diff clean with override' ((Run 'diff.ps1' $ra).Code -eq 0)
    Assert 'override: verify passes' ((Run 'verify.ps1' $ra).Code -eq 0)
    Set-Gh @('factory:review') @('a <!-- factory:review-round -->', 'b <!-- factory:review-round -->')
    Assert 'override: policy override changes behavior (3 rounds allowed)' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:changes-requested')
    Remove-Item (Join-Path $rp '.ai/factory/overrides') -Recurse
    Assert 'override removal restores factory file' ((Run 'update.ps1' $ra).Code -eq 0 -and (Get-Content -Raw (Join-Path $rp '.ai/factory/policies/retry.yaml')) -match 'max_review_fix_rounds: 2')

    # ---- Automation reconciliation against a mock cockpit ------------------
    Write-Host '== automation sync =='
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $log = Join-Path $tmp 'mock.log'; New-Item -ItemType File $log | Out-Null
    $seed = Join-Path $tmp 'seed.json'
    @(
        @{ id = 'u1'; name = 'My own automation'; enabled = $true; revision = 1 },
        @{ id = 'f-old'; name = '[factory] retired-thing'; enabled = $true; revision = 1; kind = 'github'; task = @{ prompt = 'x' } }
    ) | ConvertTo-Json -Depth 5 | Set-Content $seed
    $srv = Start-Process pwsh -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'mock-cezar.ps1'), '-Port', $port, '-LogFile', $log, '-SeedFile', $seed -PassThru -RedirectStandardOutput (Join-Path $tmp 'mock.out') -RedirectStandardError (Join-Path $tmp 'mock.err')
    try {
        $ready = $false
        for ($i = 0; $i -lt 50 -and -not $ready; $i++) { try { Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations" | Out-Null; $ready = $true } catch { Start-Sleep -Milliseconds 200 } }
        Assert 'mock cockpit is up' $ready
        $sync = Join-Path $rp '.ai/factory/scripts/sync-automations.ps1'
        $sa = @{ ProjectPath = $rp; ApiUrl = "http://127.0.0.1:$port" }
        & $sync @sa -DryRun *>&1 | Out-Null
        Assert 'sync dry-run makes no writes' (-not (Select-String -Path $log -Pattern '^(POST|PUT|DELETE)' -Quiet))
        & $sync @sa *>&1 | Out-Null
        $after = (Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations").automations
        $names = @($after | ForEach-Object { $_.name })
        Assert 'sync creates factory automations' (@($names | Where-Object { $_ -like '`[factory`] *' }).Count -ge 5)
        Assert 'sync leaves unmanaged automation untouched' (($after | Where-Object { $_.id -eq 'u1' }).enabled -eq $true)
        Assert 'sync pauses obsolete factory automation' (($after | Where-Object { $_.id -eq 'f-old' }).enabled -eq $false)
        Assert 'sync does not create maintenance (feature off)' ($names -notcontains '[factory] maintenance')
        Assert 'sync creates paused by default' (-not (($after | Where-Object { $_.name -eq '[factory] needs-plan' }).enabled))
        Clear-Content $log
        & $sync @sa *>&1 | Out-Null
        Assert 'second sync is a no-op' (-not (Select-String -Path $log -Pattern '^(POST|PUT|DELETE)' -Quiet))
        & $sync @sa -Prune *>&1 | Out-Null
        Assert 'prune deletes obsolete factory automation' (-not (@((Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations").automations | ForEach-Object { $_.id }) -contains 'f-old'))
        Assert 'sync records factory version in description' ((Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations/a100").automation.description -match 'cezar-factory 0\.1\.0')
    }
    finally { if ($srv -and -not $srv.HasExited) { $srv.Kill() } }
}
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:fail) { Write-Host "FAILED: $script:fail assertion(s)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASSED' -ForegroundColor Green
