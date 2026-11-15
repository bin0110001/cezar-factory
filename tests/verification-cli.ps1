#!/usr/bin/env pwsh
# Fixture-based tests for scripts/verification-cli.ps1 (modes, schema, determinism, new vs known, exit codes).
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cli = Join-Path $factory 'scripts/verification-cli.ps1'
$provider = Join-Path $factory 'tests/fixtures/verification-cli/provider.ps1'
$schema = Join-Path $factory 'schemas/verification-cli-output.schema.json'
$script:failures = 0
function Check([string]$Name, [bool]$Condition) { if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ } }
function Validates([string]$Json) { try { [bool](Test-Json -Json $Json -SchemaFile $schema -ErrorAction Stop) } catch { $false } }
function RunCli([string[]]$CliArgs, [string]$Outcomes = '') {
    $env:VC_OUTCOMES = $Outcomes
    $out = & pwsh -NoProfile -File $cli @CliArgs 2>$null
    $code = $LASTEXITCODE
    $env:VC_OUTCOMES = $null
    $text = (@($out) -join "`n")
    $doc = $null; try { $doc = $text | ConvertFrom-Json -AsHashtable } catch { }
    [pscustomobject]@{ Code = $code; Text = $text; Doc = $doc }
}
$fail = '{"unit-a":{"status":"failed","message":"boom password=hunter2","output":"x","fingerprint":"fp-a"},"lint":{"status":"failed","message":"lint broke","output":""}}'

foreach ($p in 'quick', 'standard', 'full') {
    $r = RunCli @('run', '--profile', $p, '--json', '--provider', $provider)
    Check "run --profile $p exits 0, is one JSON document and validates" ($r.Code -eq 0 -and $r.Doc.schemaVersion -eq 1 -and $r.Doc.profile -eq $p -and (Validates $r.Text))
}
$a = RunCli @('run', '--profile', 'standard', '--json', '--provider', $provider); $b = RunCli @('run', '--profile', 'standard', '--json', '--provider', $provider)
Check 'repeated run output is byte-identical' ($a.Text -ceq $b.Text)
Check 'selected tests are sorted ordinally' ((@($a.Doc.selection.selected.testId) -join ',') -ceq 'lint,unit-a,unit-b')

$r = RunCli @('run', '--profile', 'standard', '--json', '--provider', $provider) $fail
Check 'failing run exits 1 and validates' ($r.Code -eq 1 -and $r.Doc.status -eq 'failed' -and (Validates $r.Text))
$byId = @{}; foreach ($f in $r.Doc.failures) { $byId[$f.testId] = $f }
Check 'failures classified: new when never failed, known when failed before' ($byId['unit-a'].classification -eq 'new' -and $byId['lint'].classification -eq 'known')
Check 'failure message is redacted by the query layer' ($r.Text -notmatch 'hunter2')

$r = RunCli @('affected', '--changed', 'src/a/x.ps1,app/main.cs', '--json', '--provider', $provider)
Check 'affected selects only tests touching changed paths, with reasons' ($r.Code -eq 0 -and (@($r.Doc.selection.selected.testId) -join ',') -ceq 'e2e,lint,unit-a' -and $r.Doc.selection.selected[0].reason.content -ceq 'touches app/main.cs' -and (Validates $r.Text))
Check 'affected explains deferred tests' ($r.Doc.selection.deferred[0].testId -ceq 'unit-b' -and $r.Doc.selection.changedPaths.Count -eq 2)
$r = RunCli @('affected', '--changed', 'src/a/x.ps1', '--profile', 'quick', '--json', '--provider', $provider)
Check 'affected --profile limits the candidate set' ((@($r.Doc.selection.selected.testId) -join ',') -ceq 'unit-a' -and $r.Doc.profile -eq 'quick')
$r = RunCli @('affected', '--json', '--provider', $provider)
Check 'affected without changed paths is a usage error (exit 2)' ($r.Code -eq 2 -and $r.Doc.error.code -eq 'usage' -and (Validates $r.Text))

$r = RunCli @('last-failed', '--json', '--provider', $provider)
Check 'last-failed re-runs exactly the tests of the latest failed run' ($r.Code -eq 0 -and (@($r.Doc.selection.selected.testId) -join ',') -ceq 'lint,unit-b' -and $r.Doc.selection.source -ceq 'last-failed:run-base' -and (Validates $r.Text))

$r = RunCli @('compare', '--baseline', 'run-base', '--profile', 'standard', '--json', '--provider', $provider) $fail
Check 'compare labels each failure new or known and reports counts' ($r.Code -eq 1 -and $r.Doc.comparison.new -contains 'unit-a' -and $r.Doc.comparison.known -contains 'lint' -and $r.Doc.comparison.fixed -contains 'unit-b' -and $r.Doc.summary.new -eq 1 -and $r.Doc.summary.known -eq 1 -and $r.Doc.summary.fixed -eq 1 -and (Validates $r.Text))
$r = RunCli @('compare', '--json', '--provider', $provider)
Check 'compare without a baseline exits 2' ($r.Code -eq 2 -and (Validates $r.Text))
$r = RunCli @('compare', '--baseline', 'nope', '--json', '--provider', $provider)
Check 'compare with an unknown baseline exits 2' ($r.Code -eq 2 -and $r.Doc.error.code -eq 'config')

$r = RunCli @('run', '--profile', 'bogus', '--json', '--provider', $provider)
Check 'unknown profile exits 2' ($r.Code -eq 2 -and (Validates $r.Text))
$r = RunCli @('nonsense', '--json')
Check 'unknown command exits 2' ($r.Code -eq 2 -and (Validates $r.Text))
$r = RunCli @('run', '--profile', 'quick', '--json', '--provider', (Join-Path $factory 'tests/fixtures/verification-cli/missing.ps1'))
Check 'missing provider file exits 2' ($r.Code -eq 2)
$r = RunCli @('run', '--profile', 'quick', '--json')
Check 'no provider exits 3 (provider unavailable)' ($r.Code -eq 3 -and $r.Doc.error.code -eq 'provider_unavailable' -and (Validates $r.Text))
$r = RunCli @('run', '--profile', 'quick', '--json', '--provider', $provider) '{"unit-a":{"status":"throw"}}'
Check 'executor crash exits 3' ($r.Code -eq 3 -and $r.Doc.error.code -eq 'executor_failed' -and (Validates $r.Text))
$r = RunCli @('run', '--profile', 'quick', '--json', '--provider', $provider) '{"unit-a":{"status":"infrastructure-error","message":"worker lost"}}'
Check 'infrastructure-error result exits 3 and validates' ($r.Code -eq 3 -and $r.Doc.status -eq 'infrastructure-error' -and (Validates $r.Text))
$r = RunCli @('run', '--profile', 'quick', '--provider', $provider)
Check 'without --json the output is a human summary, not JSON' ($r.Code -eq 0 -and $r.Text -match '^run: passed' -and $null -eq $r.Doc)

if ($script:failures) { Write-Host "verification-cli tests: $($script:failures) failure(s)"; exit 1 }
Write-Host 'verification-cli tests passed'
exit 0
