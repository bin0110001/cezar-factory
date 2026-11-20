#!/usr/bin/env pwsh
# Bounded triage/repair loop (issue #105): classification, routing, bounds, budget, handoff. Deploys nothing.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/repair-loop-lib.ps1')
$failures = 0
. (Join-Path $PSScriptRoot '../scripts/lib.ps1')
function Check([string]$name, [bool]$c) { if ($c) { Write-Host "  ok   $name" } else { Write-Host "  FAIL $name"; $script:failures++ } }
$policy = Get-RepairPolicy (Join-Path $PSScriptRoot '../policies/retry.yaml')
Check 'policy read from retry.yaml' ($policy.maxAttempts -eq 2 -and 'repeated_failures' -in $policy.stopOn -and 'security_issue' -in $policy.stopOn)
$tmp = Join-Path ([IO.Path]::GetTempPath()) "repair-loop-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory $tmp | Out-Null
$bad = Join-Path $tmp 'bad.yaml'; Set-Content $bad 'max_implementation_retries: 2'
function Throws([scriptblock]$b) { try { & $b; $false } catch { $true } }
Check 'incomplete policy fails closed' (Throws { Get-RepairPolicy $bad })
Check 'missing policy fails closed' (Throws { Get-RepairPolicy (Join-Path $tmp 'none.yaml') })

function C($id, $status, $msg = '', $extra = @{}) { $o = @{ checkId = $id; status = $status; message = $msg; output = ''; commitSha = 'abc' } + $extra; [pscustomobject]$o }
Check 'passing check' ((Get-FailureClass (C 'a' 'passed')) -eq 'pass')
Check 'untested' ((Get-FailureClass (C 'a' 'untested')) -eq 'untested')
Check 'assertion is a code defect' ((Get-FailureClass (C 'a' 'failed' 'AssertionError: expected 1 got 2')) -eq 'code-defect')
Check 'timeout is infrastructure' ((Get-FailureClass (C 'a' 'failed' 'request timed out 503')) -eq 'infrastructure')
Check 'assertion outranks infrastructure words' ((Get-FailureClass (C 'a' 'failed' 'AssertionError: retries on connection refused')) -eq 'code-defect')
Check 'pass and fail on one commit is flaky' ((Get-FailureClass (C 'a' 'failed' 'boom' @{ history = @(@{ status = 'passed'; commitSha = 'abc' }, @{ status = 'failed'; commitSha = 'abc' }) })) -eq 'flaky')
Check 'unknown failure defaults to code defect' ((Get-FailureClass (C 'a' 'failed' 'boom')) -eq 'code-defect')

function NewLedger { [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]::new() } }
$l = NewLedger
$d = Invoke-RepairDecision @((C 'unit' 'failed' 'AssertionError x 1'), (C 'lint' 'passed')) $l $policy 12
Check 'code defect -> repair, only the failing check is impacted' ($d.action -eq 'repair' -and ($d.impactedChecks -join ',') -eq 'unit')
Check 'context carries the concise summary' ($d.summary.entries.Count -eq 1 -and $d.summary.entries[0].identifiers -contains 'unit')
Check 'budget recorded in ledger' ($d.budget.attemptsUsed -eq 1 -and $d.budget.attemptsRemaining -eq 1 -and $d.budget.costSecondsTotal -eq 12 -and $l.entries[0].outcome -eq 'pending')
$d2 = Invoke-RepairDecision @((C 'unit' 'passed')) $l $policy 0
Check 'fixed attempt closes pending and finishes' ($d2.action -eq 'done' -and $l.entries[0].outcome -eq 'fixed')

$l = NewLedger
$f = C 'unit' 'failed' 'boom' @{ flaky = $true }
$d = Invoke-RepairDecision @($f) $l $policy
Check 'flaky -> retry once, no repair' ($d.action -eq 'retry' -and $d.budget.attemptsUsed -eq 0 -and $d.budget.flakyRetries -eq 1)
$d = Invoke-RepairDecision @($f) $l $policy
Check 'flaky still failing -> investigate via handoff' ($d.action -eq 'handoff' -and $d.handoff.findings[0].reason -match 'investigation')

$l = NewLedger
$i = C 'net' 'failed' 'connection refused'
$d = Invoke-RepairDecision @($i) $l $policy
$d2 = Invoke-RepairDecision @($i) $l $policy
Check 'infrastructure -> backoff growing, no repair' ($d.action -eq 'backoff' -and $d.backoffSeconds -eq 30 -and $d2.backoffSeconds -eq 60 -and $d2.budget.attemptsUsed -eq 0)
$d3 = Invoke-RepairDecision @($i) $l $policy
Check 'infrastructure backoff bound -> handoff, still no repair' ($d3.action -eq 'handoff' -and $d3.budget.attemptsUsed -eq 0)

$l = NewLedger
$u = C 'ui' 'untested'
$d = Invoke-RepairDecision @($u) $l $policy
Check 'untested -> no repair, gap visible and handed off' ($d.action -eq 'handoff' -and $d.budget.attemptsUsed -eq 0 -and $d.handoff.findings[0].class -eq 'untested')

$l = NewLedger
$a = C 'unit' 'failed' 'AssertionError one'; $b = C 'unit' 'failed' 'AssertionError other'
$d = Invoke-RepairDecision @($a) $l $policy
$d = Invoke-RepairDecision @($b) $l $policy
$d = Invoke-RepairDecision @($a) $l $policy
Check 'attempt bound stops further modification' ($d.action -eq 'stop' -and $d.stopReason -eq 'max_implementation_retries' -and $d.impactedChecks.Count -eq 0 -and $d.budget.attemptsUsed -eq 2)
Check 'persistent failure handed off, no issue, no waiver' ($d.handoff.findings.Count -eq 1 -and -not $d.handoff.createsIssue -and -not $d.handoff.waiver -and $d.handoff.target -eq 'failure-audit-publication')

$wide = [pscustomobject]@{ schemaVersion = 1; maxAttempts = 5; environmentHandling = 'retry_with_backoff'; flakyHandling = 'retry_once_then_investigate'; stopOn = @('repeated_failures') }
$l = NewLedger
$a = C 'unit' 'failed' 'AssertionError same 1'
1..3 | ForEach-Object { $d = Invoke-RepairDecision @($a) $l $wide }
Check 'identical failure after two repairs stops as repeated_failures' ($d.action -eq 'stop' -and $d.stopReason -eq 'repeated_failures')
foreach ($flag in 'safetyViolation', 'securityIssue') {
    $d = Invoke-RepairDecision @((C 'unit' 'failed' 'AssertionError x' @{ $flag = $true })) (NewLedger) $policy
    Check "$flag stops before any repair" ($d.action -eq 'stop' -and $d.impactedChecks.Count -eq 0)
}
$l = NewLedger
$many = Invoke-RepairDecision @((C 'a' 'failed' 'AssertionError a'), (C 'b' 'failed' 'AssertionError b')) $l $policy
Check 'several checks in one round charge one attempt' ($many.budget.attemptsUsed -eq 1 -and $many.impactedChecks.Count -eq 2)

# Adaptive repair via standardized check-provider receipts (#744): one coordinator, policy and ledger for every provider.
function RC($id, $cat, $status, $msg = '', $extra = @{}) { $o = @{ checkId = $id; category = $cat; status = $status; message = $msg; commitSha = 'rev1'; disposition = 'new' }; foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] }; [pscustomobject]$o }
$l = NewLedger
$recs = @((RC 'project-tests' 'test' 'fail' 'unit suite: 2 failed'), (RC 'result-contract' 'custom' 'fail' 'implementation-result.json: $.testResult missing'), (RC 'lint' 'lint' 'pass'))
$d = Invoke-RepairDecision @($recs | ForEach-Object { ConvertFrom-CheckProviderReceipt $_ }) $l $policy 5
Check 'test provider and result-contract validator share one ledger and policy' ($d.action -eq 'repair' -and $l.entries.Count -eq 2 -and $d.budget.attemptsUsed -eq 1 -and $l.entries[0].source -eq 'receipt' -and ($l.entries.category -join ',') -eq 'test,custom')
Check 'focused feedback goes to the active session' ($d.feedback.Count -eq 2 -and $d.feedback[0].target -eq 'active-session' -and $d.feedback[1].checkId -eq 'result-contract')
$env1 = RC 'net' 'test' 'error' 'runner crashed' @{ disposition = 'infra-failure' }
$gov = RC 'sast' 'sast' 'fail' 'finding' @{ findings = @(@{ class = 'security' }) }
$wv = RC 'deps' 'lint' 'fail' 'x' @{ waived = $true }
$d = Invoke-RepairDecision @((ConvertFrom-CheckProviderReceipt $env1)) (NewLedger) $policy
Check 'environment category is backoff only, never repaired' ($d.action -eq 'backoff' -and $d.budget.attemptsUsed -eq 0)
$d = Invoke-RepairDecision @((ConvertFrom-CheckProviderReceipt $gov)) (NewLedger) $policy
Check 'security finding is a hard stop, never repaired' ($d.action -eq 'stop' -and $d.stopReason -eq 'security_issue' -and $d.impactedChecks.Count -eq 0)
$d = Invoke-RepairDecision @((ConvertFrom-CheckProviderReceipt $wv)) (NewLedger) $policy
Check 'waiver/governance is handed off, never repaired' ($d.action -eq 'handoff' -and $d.checks[0].class -eq 'governance' -and $d.budget.attemptsUsed -eq 0 -and $d.handoff.waiver -eq $false)
$d = Invoke-RepairDecision @((ConvertFrom-CheckProviderReceipt (RC 'lint' 'lint' 'warn' 'old warning' @{ disposition = 'known' }))) (NewLedger) $policy
Check 'accepted baseline finding is not repaired and not a regression' ($d.action -eq 'done' -and $d.checks[0].action -eq 'accepted' -and $d.budget.attemptsUsed -eq 0)
$d = Invoke-RepairDecision @((ConvertFrom-CheckProviderReceipt (RC 'lint' 'lint' 'warn' 'new warning' @{ disposition = 'worsened' }))) (NewLedger) $policy
Check 'fresh regression is repairable' ($d.action -eq 'repair')
$d = Invoke-RepairDecision @((ConvertFrom-CheckProviderReceipt (RC 'x' 'test' 'unknown'))) (NewLedger) $policy
Check 'unknown result is untested, never a pass' ($d.action -eq 'handoff' -and $d.checks[0].class -eq 'untested')

$m = { param($rev, $status = 'pass') [pscustomobject]@{ revision = 'rev1'; requiredCheckIds = @('project-tests', 'result-contract'); results = @([pscustomobject]@{ checkId = 'project-tests'; status = 'pass'; commitSha = 'rev1' }, [pscustomobject]@{ checkId = 'result-contract'; status = $status; commitSha = $rev }) } }
$scoped = @((ConvertFrom-CheckProviderReceipt (RC 'project-tests' 'test' 'pass')))
$d = Invoke-RepairDecision $scoped (NewLedger) $policy 0 ([DateTime]::UtcNow.ToString('o')) (& $m 'rev1' 'fail')
Check 'scoped pass with failing matrix stays provisional' ($d.action -eq 'rerun-full-matrix' -and $d.confirmation.state -eq 'provisional')
$d = Invoke-RepairDecision $scoped (NewLedger) $policy 0 ([DateTime]::UtcNow.ToString('o')) (& $m 'rev0')
Check 'matrix evidence for another revision stays provisional' ($d.action -eq 'rerun-full-matrix')
$inc = & $m 'rev1'; $inc.results = @($inc.results[0])
Check 'incomplete matrix is provisional' ((Get-RepairConfirmation $inc).state -eq 'provisional')
$d = Invoke-RepairDecision $scoped (NewLedger) $policy 0 ([DateTime]::UtcNow.ToString('o')) (& $m 'rev1')
Check 'full mandatory matrix at the exact revision confirms success' ($d.action -eq 'done' -and $d.confirmation.state -eq 'confirmed')
Check 'legacy callers (no matrix) behave unchanged' ((Invoke-RepairDecision $scoped (NewLedger) $policy).action -eq 'done')
Check 'worker may validate but not take over the session' ((Test-RepairSessionAction (NewLedger) 'worker' 'validate').allowed -and -not (Test-RepairSessionAction (NewLedger) 'worker' 'repair').allowed -and -not (Test-RepairSessionAction (NewLedger) 'worker' 'takeover').allowed)
$libText = Get-Content -Raw (Join-Path $PSScriptRoot '../scripts/repair-loop-lib.ps1')
Check 'no new finding registry or check runner' ($libText -notmatch '(?i)function\s+(Register-Finding|New-FindingRegistry|Invoke-Check(Provider)?Runner|Start-Check)' -and $libText -notmatch '(?i)Start-Process|Invoke-Expression')

# CLI step: ledger persisted, fail closed on a corrupt ledger, optional Hindsight absence is fine, nothing outside .factory.
$work = Join-Path $tmp 'w'; New-Item -ItemType Directory $work | Out-Null
Push-Location $work
try {
    Set-Content 'checks.json' (@{ checks = @(@{ checkId = 'unit'; status = 'failed'; message = 'AssertionError z' }) } | ConvertTo-Json -Depth 5)
    $step = Join-Path $PSScriptRoot '../scripts/repair-loop-step.ps1'
    $pol = Join-Path $PSScriptRoot '../policies/retry.yaml'
    & pwsh -NoProfile -File $step -ChecksPath checks.json -LedgerPath out/ledger.json -OutputPath out/decision.json -HandoffPath out/handoff.json -PolicyPath $pol -HindsightPath missing.json | Out-Null
    Check 'step exits 0 without Hindsight' ($LASTEXITCODE -eq 0 -and (Test-Path out/decision.json))
    Check 'step persisted the ledger' ((Get-Content -Raw out/ledger.json | ConvertFrom-Json).entries.Count -eq 1)
    Set-Content 'rec.json' (@{ revision = 'rev1'; requiredCheckIds = @('project-tests'); matrix = @(@{ checkId = 'project-tests'; status = 'pass'; commitSha = 'rev1' }); receipts = @(@{ checkId = 'project-tests'; category = 'test'; status = 'fail'; message = 'AssertionError q'; commitSha = 'rev1'; disposition = 'new' }) } | ConvertTo-Json -Depth 6)
    & pwsh -NoProfile -File $step -ReceiptsPath rec.json -LedgerPath out/l2.json -OutputPath out/d3.json -PolicyPath $pol | Out-Null
    $rd = Get-Content -Raw out/d3.json | ConvertFrom-Json
    Check 'step consumes provider receipts' ($LASTEXITCODE -eq 0 -and $rd.action -eq 'repair' -and $rd.feedback[0].target -eq 'active-session')
    Set-Content out/ledger.json '{not json'
    & pwsh -NoProfile -File $step -ChecksPath checks.json -LedgerPath out/ledger.json -OutputPath out/decision2.json -PolicyPath $pol 2>&1 | Out-Null
    Check 'corrupt ledger fails closed' ($LASTEXITCODE -ne 0 -and -not (Test-Path out/decision2.json))
} finally { Pop-Location; Remove-Item -Recurse -Force $tmp }
Check 'step is a runtime script' ($script:RuntimeScripts -contains 'repair-loop-step.ps1' -and $script:RuntimeScripts -contains 'repair-loop-lib.ps1')
if ($failures) { Write-Host "$failures failed"; exit 1 }
