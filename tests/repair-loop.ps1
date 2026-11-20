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
    Set-Content out/ledger.json '{not json'
    & pwsh -NoProfile -File $step -ChecksPath checks.json -LedgerPath out/ledger.json -OutputPath out/decision2.json -PolicyPath $pol 2>&1 | Out-Null
    Check 'corrupt ledger fails closed' ($LASTEXITCODE -ne 0 -and -not (Test-Path out/decision2.json))
} finally { Pop-Location; Remove-Item -Recurse -Force $tmp }
Check 'step is a runtime script' ($script:RuntimeScripts -contains 'repair-loop-step.ps1' -and $script:RuntimeScripts -contains 'repair-loop-lib.ps1')

# ---- #740: layered authorization, strategies, reservations, receipts --------------------------------------------
$auth = Get-RepairAuthorizationPolicy (Join-Path $PSScriptRoot '../policies/repair-policy.json') @() $policy
Check 'effective policy is versioned and digested' ($auth.policyVersion -eq 1 -and $auth.digest -match '^[0-9a-f]{64}$' -and $auth.limits.totalRepairRounds -eq 2)
function Ov($o) { $f = Join-Path $tmp2 "ov-$([guid]::NewGuid().ToString('N')).json"; Set-Content $f ($o | ConvertTo-Json -Depth 6); $f }
$tmp2 = Join-Path ([IO.Path]::GetTempPath()) "repair-loop740-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory $tmp2 | Out-Null
$fp = Join-Path $PSScriptRoot '../policies/repair-policy.json'
$tight = Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'project'; limits = @{ totalRepairRounds = 1 }; ceilings = @{ maxSeconds = 100 } })) $policy
Check 'override may tighten limits and add a ceiling' ($tight.limits.totalRepairRounds -eq 1 -and $tight.ceilings.maxSeconds -eq 100 -and $tight.layers.Count -eq 2 -and $tight.digest -ne $auth.digest)
Check 'override cannot loosen a limit' (Throws { Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'workflow'; limits = @{ totalRepairRounds = 9 } })) $policy })
Check 'override cannot disable governance' (Throws { Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'validator'; governance = @{ stopOnSecurityIssue = $false } })) $policy })
Check 'override cannot allow incomplete as success' (Throws { Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'project'; governance = @{ allowIncompleteAsSuccess = $true } })) $policy })
Check 'override cannot enable independent diagnosis' (Throws { Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'project'; independentDiagnosis = $true })) $policy })
Check 'unknown key in an override fails closed' (Throws { Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'project'; skipGates = $true })) $policy })
Check 'unreadable override fails closed' (Throws { Get-RepairAuthorizationPolicy $fp @((Join-Path $tmp2 'nope.json')) $policy })
Check 'independent diagnosis is off by default' ($auth.independentDiagnosis -eq $false)

function Dec($checks, $ledger, $a = $auth, $extra = @{}) { Invoke-RepairDecision -Checks $checks -Ledger $ledger -Policy $policy -Authorization $a @extra }
function Mk([int]$rounds) { $r = @{}; $r }
$wideAuth = Get-RepairAuthorizationPolicy $fp @() ([pscustomobject]@{ maxAttempts = 99 })
$wideAuth.limits.totalRepairRounds = 6; $wideAuth.limits.consecutiveNoProgress = 9; $wideAuth.limits.oscillationLimit = 9; $wideAuth.limits.unchangedFindingPersistence = 9

$l = NewLedger
$d = Dec @((C 'unit' 'passed')) $l
Check 'initial passing validation uses zero repair rounds' ($d.action -eq 'done' -and $d.reasonCode -eq 'passed' -and $d.budget.attemptsUsed -eq 0 -and $d.outcome -eq 'success')
Check 'every decision appends one receipt with a digest' ($l.receipts.Count -eq 1 -and $l.receipts[0].digest -match '^[0-9a-f]{64}$' -and $l.receipts[0].policy.digest -eq $auth.digest)
$schemaOk = Test-Json -Json ($l.receipts[0] | ConvertTo-Json -Depth 10) -SchemaFile (Join-Path $PSScriptRoot '../schemas/repair-receipt.schema.json')
Check 'receipt validates against its schema' $schemaOk

$l = NewLedger
$a = C 'unit' 'failed' 'AssertionError one'
$d = Dec @($a) $l
Check 'first code defect -> focused repair' ($d.action -eq 'repair' -and $d.strategy -eq 'focused-repair' -and $d.reasonCode -eq 'repair_authorized')
$d = Dec @($a) $l
Check 'unchanged finding after a repair -> in-session replan, same budget' ($d.action -eq 'replan' -and $d.strategy -eq 'in-session-replan' -and $d.budget.attemptsUsed -eq 2 -and $d.budget.replansUsed -eq 1)
$d = Dec @((C 'unit' 'failed' 'AssertionError gamma')) $l
Check 'exhausted cap -> global_budget_exhausted' ($d.action -eq 'stop' -and $d.reasonCode -eq 'global_budget_exhausted' -and $d.terminal)

# replan cap: with a wide total budget the replan happens once, then persistence applies
$l = NewLedger
$acts = 1..4 | ForEach-Object { (Dec @($a) $l $wideAuth).action }
Check 'replan cap holds (one replan, then repair)' (($acts -join ',') -eq 'repair,replan,repair,repair')

# repeated finding
$rp = Get-RepairAuthorizationPolicy $fp @() ([pscustomobject]@{ maxAttempts = 99 }); $rp.limits.totalRepairRounds = 6; $rp.limits.consecutiveNoProgress = 9; $rp.limits.oscillationLimit = 9; $rp.limits.replanCap = 0
$l = NewLedger; 1..3 | ForEach-Object { $d = Dec @($a) $l $rp }
Check 'same finding persisting -> repeated_finding' ($d.action -eq 'stop' -and $d.reasonCode -eq 'repeated_finding')
$l = NewLedger; 1..2 | ForEach-Object { [void](Dec @($a) $l $rp) }
$d = Dec @((C 'unit' 'failed' 'AssertionError one' @{ relevantChange = $true })) $l $rp
Check 'relevant change resets persistence' ($d.action -eq 'repair')

# mixed progress resets the no-progress streak
$np = Get-RepairAuthorizationPolicy $fp @() ([pscustomobject]@{ maxAttempts = 99 }); $np.limits.totalRepairRounds = 9; $np.limits.replanCap = 0; $np.limits.unchangedFindingPersistence = 9; $np.limits.oscillationLimit = 9; $np.limits.consecutiveNoProgress = 2
$x = C 'x' 'failed' 'AssertionError x'; $y = C 'y' 'failed' 'AssertionError y'
$l = NewLedger; [void](Dec @($x, $y) $l $np); $d = Dec @($x, $y) $l $np
Check 'one round without progress is allowed' ($d.action -eq 'repair' -and $d.receipt.counters.consecutiveNoProgress -eq 1)
$d = Dec @($x, $y) $l $np
Check 'consecutive no-progress -> no_progress' ($d.action -eq 'stop' -and $d.reasonCode -eq 'no_progress')
$l = NewLedger; [void](Dec @($x, $y) $l $np); [void](Dec @($x, $y) $l $np); $d = Dec @($x) $l $np
Check 'mixed progress (one finding fixed) keeps repairing' ($d.action -eq 'repair' -and $d.receipt.counters.progress -eq 'progress')
$l = NewLedger; [void](Dec @($x, $y) $l $np)
$d = Dec @($x, $y) $l $np -extra @{ Progress = [pscustomobject]@{ state = 'progress' } }
Check 'progress evaluator input is honoured' ($d.receipt.counters.progress -eq 'progress')
$l = NewLedger; [void](Dec @($x) $l $np); [void](Dec @($y) $l $np)
$d = Dec @($x) $l $np
Check 'unknown progress counts as none' ($d.receipt.counters.progress -eq 'progress')   # derived from the finding set changing
$d2 = Dec @($x) $l $np -extra @{ Progress = [pscustomobject]@{ state = 'unknown' } }
Check 'explicit unknown progress is conservative' ($d2.receipt.counters.progress -eq 'none')

# oscillation A,B,A
$op = Get-RepairAuthorizationPolicy $fp @() ([pscustomobject]@{ maxAttempts = 99 }); $op.limits.totalRepairRounds = 9; $op.limits.replanCap = 0; $op.limits.consecutiveNoProgress = 9; $op.limits.unchangedFindingPersistence = 9; $op.limits.oscillationLimit = 1
$l = NewLedger; [void](Dec @($x) $l $op); [void](Dec @($y) $l $op); $d = Dec @($x) $l $op
Check 'A,B,A -> oscillation' ($d.action -eq 'stop' -and $d.reasonCode -eq 'oscillation')

# ceilings
$cp = Get-RepairAuthorizationPolicy $fp @((Ov @{ schemaVersion = 1; layer = 'workflow'; ceilings = @{ maxSeconds = 20; maxTokens = 1000; maxCostUsd = 1.5 } })) $policy
$l = NewLedger; $d = Dec @($x) $l $cp -extra @{ AttemptSeconds = 15 }
Check 'under the time ceiling repairs' ($d.action -eq 'repair')
$d = Dec @($y) $l $cp -extra @{ AttemptSeconds = 10 }
Check 'time ceiling -> global_budget_exhausted' ($d.action -eq 'stop' -and $d.reasonCode -eq 'global_budget_exhausted' -and $d.stopReason -eq 'ceiling_exceeded')
$l = NewLedger; $d = Dec @($x) $l $cp -extra @{ AttemptTokens = 2000 }
Check 'token ceiling stops' ($d.action -eq 'stop' -and $d.stopReason -eq 'ceiling_exceeded')
$l = NewLedger; $d = Dec @($x) $l $cp -extra @{ AttemptUsd = 2 }
Check 'cost ceiling stops' ($d.action -eq 'stop' -and $d.stopReason -eq 'ceiling_exceeded')

# governance, validator error, session, incomplete
$l = NewLedger; $d = Dec @((C 'unit' 'failed' 'AssertionError x' @{ securityIssue = $true })) $l
Check 'governance signal -> immediate governance_stop' ($d.action -eq 'stop' -and $d.reasonCode -eq 'governance_stop' -and $d.budget.attemptsUsed -eq 0)
$l = NewLedger; $d = Dec @((C 'unit' 'failed' 'AssertionError x' @{ validatorError = $true })) $l
Check 'validator error -> validator_error stop' ($d.action -eq 'stop' -and $d.reasonCode -eq 'validator_error')
$l = NewLedger; $d = Dec @($x) $l $auth -extra @{ SessionAvailable = $false }
Check 'no session -> session_unavailable stop' ($d.action -eq 'stop' -and $d.reasonCode -eq 'session_unavailable' -and $d.budget.attemptsUsed -eq 0)
$l = NewLedger; $d = Dec @((C 'unit' 'passed' '' @{ incomplete = $true })) $l
Check 'incomplete is never rewritten as success' ($d.action -eq 'handoff' -and $d.reasonCode -eq 'incomplete_reported' -and $d.outcome -eq 'incomplete' -and $d.action -ne 'done')
$l = NewLedger; $d = Dec @((C 'unit' 'failed' 'AssertionError x' @{ securityIssue = $true }), (C 'u2' 'failed' 'AssertionError y' @{ validatorError = $true })) $l
Check 'governance outranks other stop reasons' ($d.reasonCode -eq 'governance_stop')

# infrastructure retries are accounted separately from repairs
$l = NewLedger; $d = Dec @((C 'net' 'failed' 'connection refused')) $l
Check 'infrastructure retry is its own strategy and budget' ($d.action -eq 'backoff' -and $d.strategy -eq 'infrastructure-retry' -and $d.budget.attemptsUsed -eq 0 -and $d.budget.infrastructureRetriesUsed -eq 1)

# idempotency, cancellation, replan never resets
$l = NewLedger; $d1 = Dec @($x) $l $auth -extra @{ IdempotencyKey = 'k1' }
$d2 = Dec @($x) $l $auth -extra @{ IdempotencyKey = 'k1' }
Check 'idempotency key replays the original decision and receipt' ($d2.replayed -eq $true -and $d2.receipt.receiptId -eq $d1.receipt.receiptId -and $l.receipts.Count -eq 1 -and $l.reservations.Count -eq 1)
Set-RepairReservationState $l 'k1' 'cancelled'
$b = Get-RepairBudget $l $policy
Check 'cancellation releases the reservation' ($b.attemptsUsed -eq 0)
$r = Add-RepairReservation $l 'k1' 'repair' 2 1 'now'
Check 'a cancelled key is not silently re-granted' (-not $r.granted -and $r.replayed)

# legacy ledger without reservations migrates its repairs into the cap
$legacy = [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]@([ordered]@{ round = 1; at = 'x'; checkId = 'x'; class = 'code-defect'; action = 'repair'; fingerprint = 'f'; outcome = 'still-failing'; costSeconds = 0; stopReason = '' }, [ordered]@{ round = 2; at = 'x'; checkId = 'x'; class = 'code-defect'; action = 'repair'; fingerprint = 'g'; outcome = 'still-failing'; costSeconds = 0; stopReason = '' }) }
$d = Dec @($x) $legacy
Check 'legacy v1 ledger keeps counting toward the cap' ($d.action -eq 'stop' -and $d.reasonCode -eq 'global_budget_exhausted')

# concurrency: parallel processes on one ledger file never exceed the cap
$ledgerFile = Join-Path $tmp2 'conc.json'
$libPath = (Resolve-Path (Join-Path $PSScriptRoot '../scripts/repair-loop-lib.ps1')).Path
$procs = 1..8 | ForEach-Object {
    $k = "p$_"
    Start-Process pwsh -ArgumentList '-NoProfile', '-Command', "`$ErrorActionPreference='Stop'; . '$libPath'; `$pol=[pscustomobject]@{maxAttempts=3}; [void](Use-RepairLedgerLock '$ledgerFile' `$pol { param(`$l) Add-RepairReservation `$l '$k' 'repair' 3 1 'now' })" -PassThru -RedirectStandardError (Join-Path $tmp2 "err-$k.txt")
}
$procs | Wait-Process -Timeout 120
$cl = Get-Content -Raw $ledgerFile | ConvertFrom-Json
Check 'concurrent reservations never exceed the cap' (@($cl.reservations | Where-Object { $_.state -ne 'cancelled' }).Count -eq 3)
Remove-Item -Recurse -Force $tmp2

# CLI step with the default policy writes a receipt
$work2 = Join-Path ([IO.Path]::GetTempPath()) "repair-loop-step740-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory $work2 | Out-Null
Push-Location $work2
try {
    Set-Content 'checks.json' (@{ checks = @(@{ checkId = 'unit'; status = 'failed'; message = 'AssertionError z' }) } | ConvertTo-Json -Depth 5)
    $step = Join-Path $PSScriptRoot '../scripts/repair-loop-step.ps1'
    & pwsh -NoProfile -File $step -ChecksPath checks.json -LedgerPath out/ledger.json -OutputPath out/decision.json -HandoffPath out/handoff.json -PolicyPath (Join-Path $PSScriptRoot '../policies/retry.yaml') | Out-Null
    $dj = Get-Content -Raw out/decision.json | ConvertFrom-Json
    Check 'step decision carries reason code and receipt' ($LASTEXITCODE -eq 0 -and $dj.reasonCode -eq 'repair_authorized' -and $dj.receipt.policy.policyVersion -eq 1)
    Check 'step ledger stores the receipt' ((Get-Content -Raw out/ledger.json | ConvertFrom-Json).receipts.Count -eq 1)
    Set-Content bad-override.json '{"schemaVersion":1,"layer":"project","governance":{"stopOnSecurityIssue":false}}'
    & pwsh -NoProfile -File $step -ChecksPath checks.json -LedgerPath out/l2.json -OutputPath out/d2.json -PolicyPath (Join-Path $PSScriptRoot '../policies/retry.yaml') -OverridePolicyPath bad-override.json 2>&1 | Out-Null
    Check 'step fails closed on a governance-weakening override' ($LASTEXITCODE -ne 0 -and -not (Test-Path out/d2.json))
} finally { Pop-Location; Remove-Item -Recurse -Force $work2 }
if ($failures) { Write-Host "$failures failed"; exit 1 }
