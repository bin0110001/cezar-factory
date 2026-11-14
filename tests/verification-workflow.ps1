#!/usr/bin/env pwsh
# Fixture tests for the verify workflow's steps: scoped selection, check invocation, policy evaluation and
# ledger recording. Uses a throwaway git repository; nothing is deployed or pushed.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('factory-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
# Policy, ledger and forged inputs live outside the fixture repository so they are not counted as changed files.
$aux = $tmp + '-aux'
New-Item -ItemType Directory -Path $aux | Out-Null
$passed = 0; $failed = 0
function Assert([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name"; $script:passed++ } else { Write-Host "  FAIL $Name"; $script:failed++ }
}
function Invoke-FixtureGit([string[]]$Arguments) { $o = & git -C $tmp @Arguments 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $o" } }
function Step([string]$Script, [string[]]$Arguments) {
    Push-Location $tmp
    try { $out = & pwsh -NoProfile -File (Join-Path $factory "scripts/$Script") @Arguments 2>&1 | Out-String; [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out } }
    finally { Pop-Location }
}
function Json([string]$Relative) { Get-Content -Raw (Join-Path $tmp $Relative) | ConvertFrom-Json -AsHashtable }
try {
    & git init -q -b main $tmp
    Invoke-FixtureGit @('config', 'user.email', 'test@example.com'); Invoke-FixtureGit @('config', 'user.name', 'Factory Test')
    New-Item -ItemType Directory -Force -Path (Join-Path $tmp '.ai/factory'), (Join-Path $tmp 'src'), (Join-Path $tmp 'docs') | Out-Null
    "factory:`n  source: fixture`n  version: `"0.0.1`"`nvalidation:`n  changed: `"skip`"`n  full: `"skip`"`n  verify: `"skip`"`n" | Set-Content (Join-Path $tmp '.ai/factory/factory.config.yaml')
    function Write-Map([string]$MandatoryCommand) {
        $map = [ordered]@{ schemaVersion = 1; unmapped = 'error'; checks = @(
            [ordered]@{ id = 'src-check'; patterns = @('src/**'); command = "Write-Output 'ran src-check'" },
            [ordered]@{ id = 'docs-check'; patterns = @('docs/**', '.ai/**'); command = "Write-Output 'ran docs-check'" },
            [ordered]@{ id = 'always'; patterns = @('never/**'); command = $MandatoryCommand }) }
        ConvertTo-Json -InputObject $map -Depth 6 | Set-Content (Join-Path $tmp '.ai/factory/test-ownership.json')
    }
    Write-Map "Write-Output 'ran always'"
    'seed' | Set-Content (Join-Path $tmp 'src/a.txt'); 'seed' | Set-Content (Join-Path $tmp 'docs/a.txt')
    Invoke-FixtureGit @('add', '-A'); Invoke-FixtureGit @('commit', '-q', '-m', 'seed')
    'change' | Set-Content (Join-Path $tmp 'src/a.txt'); Invoke-FixtureGit @('commit', '-q', '-am', 'change src')
    $policy = Join-Path $aux 'policy.json'
    '{"schemaVersion":1,"mandatoryChecks":["always"],"checkTimeoutSeconds":60}' | Set-Content $policy
    $ledger = Join-Path $aux 'ledger.jsonl'
    $common = @('-PolicyPath', $policy)

    $sel = Step 'verification-select.ps1' $common; if ($sel.Code -ne 0) { Write-Host $sel.Output }
    $selection = Json '.factory/verification/selection.json'
    $ids = @($selection.selected | ForEach-Object { $_.id })
    Assert 'scoped selection picks the impacted check and the mandatory check only' ($sel.Code -eq 0 -and ($ids -join ',') -eq 'src-check,always')
    Assert 'selection records why each check was chosen' (($selection.selected | Where-Object id -eq 'always').reason -eq 'mandatory' -and ($selection.selected | Where-Object id -eq 'src-check').reason -eq 'impact')

    $inv = Step 'verification-invoke.ps1' $common
    $results = Json '.factory/verification/results.json'
    Assert 'invocation runs each selected check and records its result' ($inv.Code -eq 0 -and $results.results.Count -eq 2 -and @($results.results | Where-Object status -ne 'passed').Count -eq 0)
    Assert 'a check outside the selection is not executed' ((Get-Content -Raw (Join-Path $tmp '.factory/verification/results.json')) -notmatch 'docs-check')

    $ev = Step 'verification-evaluate.ps1' ($common + @('-LedgerPath', $ledger, '-Task', 'GitHub issue #102'))
    $verdict = Json '.factory/verification/verdict.json'
    Assert 'policy evaluation passes and writes a result file' ($ev.Code -eq 0 -and $verdict.verdict -eq 'pass' -and $verdict.issue -eq 102)
    $lines = @(Get-Content $ledger)
    Assert 'the verdict is appended to the ledger' ($lines.Count -eq 1 -and ($lines[0] | ConvertFrom-Json).verdict -eq 'pass')

    # A second verdict chains to the first.
    $null = Step 'verification-evaluate.ps1' ($common + @('-LedgerPath', $ledger))
    $lines = @(Get-Content $ledger)
    . (Join-Path $factory 'scripts/lib.ps1')
    Assert 'ledger is append-only and hash-chained' ($lines.Count -eq 2 -and ($lines[1] | ConvertFrom-Json).previousDigest -eq (Get-TextHash $lines[0]))

    # Mandatory enforcement: a selection that drops the mandatory check cannot pass.
    $forged = Json '.factory/verification/selection.json'
    $forged.selected = @($forged.selected | Where-Object id -ne 'always')
    $forgedPath = Join-Path $aux 'forged-selection.json'
    ConvertTo-Json -InputObject $forged -Depth 8 | Set-Content $forgedPath
    $forgedResults = Json '.factory/verification/results.json'
    $forgedResults.results = @($forgedResults.results | Where-Object id -ne 'always')
    $forgedResultsPath = Join-Path $aux 'forged-results.json'
    ConvertTo-Json -InputObject $forgedResults -Depth 8 | Set-Content $forgedResultsPath
    $fv = Step 'verification-evaluate.ps1' ($common + @('-SelectionPath', $forgedPath, '-ResultsPath', $forgedResultsPath, '-LedgerPath', $ledger, '-OutputPath', (Join-Path $aux 'forged-verdict.json')))
    $forgedVerdict = Get-Content -Raw (Join-Path $aux 'forged-verdict.json') | ConvertFrom-Json
    Assert 'a mandatory check missing from the run fails the verdict, and the failure is recorded' ($fv.Code -ne 0 -and $forgedVerdict.verdict -eq 'fail' -and ($forgedVerdict.reasons -join ' ') -match "mandatory check 'always' did not run" -and @(Get-Content $ledger).Count -eq 3)

    # Invocation never trusts a command in the selection file.
    $tampered = Json '.factory/verification/selection.json'
    ($tampered.selected | Where-Object id -eq 'src-check').command = "Write-Output 'injected'"
    $tamperedPath = Join-Path $aux 'tampered-selection.json'
    ConvertTo-Json -InputObject $tampered -Depth 8 | Set-Content $tamperedPath
    $null = Step 'verification-invoke.ps1' ($common + @('-SelectionPath', $tamperedPath, '-OutputPath', (Join-Path $aux 'tampered-results.json')))
    $tr = Get-Content -Raw (Join-Path $aux 'tampered-results.json') | ConvertFrom-Json
    Assert 'invocation refuses a selection command that differs from the ownership map' (($tr.results | Where-Object id -eq 'src-check').status -eq 'error' -and (Get-Content -Raw (Join-Path $aux 'tampered-results.json')) -notmatch 'injected\b.*passed')

    # A failing mandatory check fails the verdict (and the evaluate step).
    Write-Map "Write-Error 'boom'; exit 3"
    $null = Step 'verification-select.ps1' $common
    $null = Step 'verification-invoke.ps1' $common
    $bad = Step 'verification-evaluate.ps1' ($common + @('-LedgerPath', $ledger))
    $badVerdict = Json '.factory/verification/verdict.json'
    Assert 'a failing check yields a fail verdict and a non-zero step' ($bad.Code -ne 0 -and $badVerdict.verdict -eq 'fail' -and @(Get-Content $ledger).Count -eq 4)

    # A mandatory id the ownership map does not define is a policy error, not a silent pass.
    '{"schemaVersion":1,"mandatoryChecks":["nonexistent"]}' | Set-Content $policy
    $missing = Step 'verification-select.ps1' $common
    Assert 'a mandatory check unknown to the ownership map stops selection' ($missing.Code -ne 0 -and $missing.Output -match "Mandatory check 'nonexistent'")

    # Workflow contract: command steps only; shipped policy references real checks.
    $wf = Get-Content -Raw (Join-Path $factory 'workflows/verify.yaml')
    Assert 'verify workflow runs select, invoke and evaluate as command steps with no agent step' (($wf -match 'id: select-scoped') -and ($wf -match 'id: invoke-checks') -and ($wf -match 'id: policy-evaluate') -and $wf -notmatch '(?m)^\s+(skill|prompt):')
    $shipped = Get-Content -Raw (Join-Path $factory 'policies/verification.json') | ConvertFrom-Json
    $factoryChecks = @((Get-Content -Raw (Join-Path $factory '.ai/factory/test-ownership.json') | ConvertFrom-Json).checks | ForEach-Object { $_.id })
    Assert 'the shipped policy names mandatory checks that exist in the ownership map' (@($shipped.mandatoryChecks).Count -gt 0 -and @($shipped.mandatoryChecks | Where-Object { $_ -notin $factoryChecks }).Count -eq 0)
} finally {
    Remove-Item -Recurse -Force $tmp, $aux -ErrorAction SilentlyContinue
}
Write-Host "$passed passed, $failed failed"
if ($failed) { exit 1 }
