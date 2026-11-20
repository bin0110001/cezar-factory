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
$wideFile = Join-Path $tmp 'wide.json'
$wideDoc = Get-Content -Raw (Join-Path $PSScriptRoot '../policies/repair-policy.json') | ConvertFrom-Json -AsHashtable
$wideDoc.limits.maxRepairRounds = 5; $wideDoc.limits.maxReplans = 0
$wideDoc | ConvertTo-Json -Depth 8 | Set-Content $wideFile
$wideEff = Get-EffectiveRepairPolicy -Legacy $wide -PolicyPath $wideFile
1..3 | ForEach-Object { $d = Invoke-RepairDecision @($a) $l $wide -Effective $wideEff }
Check 'identical failure after two repairs stops as repeated_failures' ($d.action -eq 'stop' -and $d.stopReason -eq 'repeated_failures')
foreach ($flag in 'safetyViolation', 'securityIssue') {
    $d = Invoke-RepairDecision @((C 'unit' 'failed' 'AssertionError x' @{ $flag = $true })) (NewLedger) $policy
    Check "$flag stops before any repair" ($d.action -eq 'stop' -and $d.impactedChecks.Count -eq 0)
}
$l = NewLedger
$many = Invoke-RepairDecision @((C 'a' 'failed' 'AssertionError a'), (C 'b' 'failed' 'AssertionError b')) $l $policy
Check 'several checks in one round charge one attempt' ($many.budget.attemptsUsed -eq 1 -and $many.impactedChecks.Count -eq 2)


# ---- #740: layered policy, reason codes, strategies, receipts, reservations ----
$repoPolicy = Join-Path $PSScriptRoot '../policies/repair-policy.json'
$eff = Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath $repoPolicy
Check 'effective policy is versioned, hashed and clamped by retry.yaml' ($eff.policyVersion -eq '1' -and $eff.hash.Length -eq 64 -and $eff.limits.maxRepairRounds -eq 2 -and $eff.governance.stopOnSafetyViolation)
function WithLayer([hashtable]$layer, [string]$name = 'project') {
    $doc = Get-Content -Raw $repoPolicy | ConvertFrom-Json -AsHashtable
    $doc.overrides.$name = $layer
    $f = Join-Path $tmp "layer-$([guid]::NewGuid().ToString('N')).json"; $doc | ConvertTo-Json -Depth 8 | Set-Content $f; $f
}
$tight = Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ limits = @{ maxRepairRounds = 1; maxSeconds = 30 } })
Check 'override may tighten, recorded in layers' ($tight.limits.maxRepairRounds -eq 1 -and $tight.limits.maxSeconds -eq 30 -and $tight.layers -contains 'project' -and $tight.hash -ne $eff.hash)
Check 'override loosening a limit is rejected' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ limits = @{ maxRepairRounds = 9 } }) })
Check 'override disabling governance is rejected' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ governance = @{ stopOnSecurityIssue = $false } }) })
Check 'override disabling required gates is rejected' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ governance = @{ enforceRequiredGates = $false } } 'project') })
Check 'override enabling independent diagnosis is rejected' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ governance = @{ allowIndependentDiagnosis = $true } }) })
Check 'unknown override key fails schema (closed)' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ limits = @{ bogus = 1 } }) })
$badJson = Join-Path $tmp 'bad.json'; Set-Content $badJson '{not json'
Check 'unreadable policy fails closed' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath $badJson })
Check 'missing repair policy fails closed' (Throws { Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (Join-Path $tmp 'nope.json') })
$wfEff = Get-EffectiveRepairPolicy -Legacy $policy -PolicyPath (WithLayer @{ wf = @{ limits = @{ maxReplans = 0 } } } 'workflows') -Workflow wf
Check 'workflow layer selected by name' ($wfEff.limits.maxReplans -eq 0 -and $wfEff.layers -contains 'workflow:wf')

$l = NewLedger
$d = Invoke-RepairDecision @((C 'unit' 'passed')) $l $policy
Check 'initial all-pass validation: done/passed, zero repair rounds' ($d.action -eq 'done' -and $d.reasonCode -eq 'passed' -and $d.budget.attemptsUsed -eq 0 -and $d.handoff.successful)
$d = Invoke-RepairDecision @((C 'unit' 'failed' 'AssertionError a')) (NewLedger) $policy
Check 'receipt: one per evaluation with policy snapshot and hash chain' ($d.receipt.decision -eq 'repair' -and $d.receipt.reasonCode -eq 'repair_authorized' -and $d.receipt.policy.hash -eq $eff.hash -and $d.receipt.hash.Length -eq 64 -and $d.strategy -eq 'focused_repair')
$l = NewLedger
$u = C 'ui' 'untested'
$d = Invoke-RepairDecision @($u) $l $policy
Check 'incomplete_reported is a handoff, never a successful one' ($d.action -eq 'handoff' -and $d.reasonCode -eq 'incomplete_reported' -and -not $d.handoff.successful -and $d.handoff.incomplete)
$d2 = Invoke-RepairDecision @($u) $l $policy
Check 'ledger carries one receipt per evaluation, chained' ($l.receipts.Count -eq 2 -and $l.receipts[1].previousHash -eq $l.receipts[0].hash)
Check 'validator error stops with validator_error' ((Invoke-RepairDecision @((C 'v' 'error' 'validator crashed')) (NewLedger) $policy).reasonCode -eq 'validator_error')
$d = Invoke-RepairDecision @((C 'unit' 'failed' 'AssertionError x' @{ securityIssue = $true })) (NewLedger) $policy
Check 'security signal is governance_stop' ($d.action -eq 'stop' -and $d.reasonCode -eq 'governance_stop' -and $d.strategy -eq 'stop_escalate')
$d = Invoke-RepairDecision @((C 'unit' 'failed' 'AssertionError x')) (NewLedger) $policy -SessionAvailable $false
Check 'unavailable session stops with session_unavailable and spends nothing' ($d.reasonCode -eq 'session_unavailable' -and $d.budget.attemptsUsed -eq 0)

# exhausted cap
$l = NewLedger
$a = C 'unit' 'failed' 'AssertionError one'; $b = C 'unit' 'failed' 'AssertionError other'
Invoke-RepairDecision @($a) $l $policy | Out-Null; Invoke-RepairDecision @($b) $l $policy | Out-Null
Check 'exhausted cap -> global_budget_exhausted' ((Invoke-RepairDecision @($a) $l $policy).reasonCode -eq 'global_budget_exhausted')

# unchanged same finding: focused repair, then replan, then repeated_finding stop
$bigFile = Join-Path $tmp 'big.json'
$bd = Get-Content -Raw $repoPolicy | ConvertFrom-Json -AsHashtable; $bd.limits.maxRepairRounds = 9; $bd.limits.maxReplans = 1; $bd.limits.unchangedFindingPersistence = 3; $bd.limits.consecutiveNoProgress = 3; $bd | ConvertTo-Json -Depth 8 | Set-Content $bigFile
$wide9 = [pscustomobject]@{ schemaVersion = 1; maxAttempts = 9; environmentHandling = 'retry_with_backoff'; flakyHandling = 'retry_once_then_investigate'; stopOn = @('repeated_failures') }
$big = Get-EffectiveRepairPolicy -Legacy $wide9 -PolicyPath $bigFile
$same = C 'unit' 'failed' 'AssertionError same'
$l = NewLedger
$r1 = Invoke-RepairDecision @($same) $l $wide9 -Effective $big
$r2 = Invoke-RepairDecision @($same) $l $wide9 -Effective $big
Check 'unchanged finding -> in-session replan once, not new session' ($r1.action -eq 'repair' -and $r2.action -eq 'replan' -and $r2.strategy -eq 'replan' -and $r2.budget.attemptsUsed -eq 2 -and $r2.budget.replansUsed -eq 1)
$r3 = Invoke-RepairDecision @($same) $l $wide9 -Effective $big
Check 'replan cap respected: next unchanged round repairs again' ($r3.action -eq 'repair' -and $r3.budget.replansUsed -eq 1)
$r4 = Invoke-RepairDecision @($same) $l $wide9 -Effective $big
Check 'unchanged same finding -> repeated_finding, replan did not reset budget' ($r4.action -eq 'stop' -and $r4.reasonCode -eq 'repeated_finding' -and $r4.budget.attemptsUsed -eq 3)

# relevant change resets persistence
$l = NewLedger
Invoke-RepairDecision @($same) $l $wide9 -Effective $big | Out-Null
Invoke-RepairDecision @($same) $l $wide9 -Effective $big -Progress @{ outcome = 'progress'; relevantChange = $true } | Out-Null
Invoke-RepairDecision @($same) $l $wide9 -Effective $big -Progress @{ outcome = 'progress'; relevantChange = $true } | Out-Null
$rr = Invoke-RepairDecision @($same) $l $wide9 -Effective $big -Progress @{ outcome = 'progress'; relevantChange = $true }
Check 'relevant change resets unchanged-finding persistence' ($rr.action -ne 'stop' -and $rr.reasonCode -in 'repair_authorized', 'replan_authorized')

# consecutive no-progress and mixed progress
$words = "alpha", "bravo", "charlie", "delta", "echo", "foxtrot"; $mk = { param($n) C "unit" "failed" "AssertionError distinct $($words[$n])" }
$l = NewLedger
$np = @{ outcome = 'no_progress'; relevantChange = $false }
Invoke-RepairDecision @((& $mk 1)) $l $wide9 -Effective $big | Out-Null
foreach ($n in 2..3) { Invoke-RepairDecision @((& $mk $n)) $l $wide9 -Effective $big -Progress $np | Out-Null }
$z = Invoke-RepairDecision @((& $mk 4)) $l $wide9 -Effective $big -Progress $np
Check 'three consecutive no-progress rounds -> no_progress' ($z.action -eq 'stop' -and $z.reasonCode -eq 'no_progress')
$l = NewLedger
Invoke-RepairDecision @((& $mk 1)) $l $wide9 -Effective $big | Out-Null
Invoke-RepairDecision @((& $mk 2)) $l $wide9 -Effective $big -Progress $np | Out-Null
Invoke-RepairDecision @((& $mk 3)) $l $wide9 -Effective $big -Progress @{ outcome = 'progress'; relevantChange = $false } | Out-Null
Invoke-RepairDecision @((& $mk 4)) $l $wide9 -Effective $big -Progress $np | Out-Null
$z = Invoke-RepairDecision @((& $mk 5)) $l $wide9 -Effective $big -Progress $np
Check 'mixed progress breaks the no-progress streak' ($z.action -eq 'repair')
$l = NewLedger
1..5 | ForEach-Object { $z = Invoke-RepairDecision @((& $mk $_)) $l $wide9 -Effective $big }
Check 'missing progress data is unknown and never extra budget or a stop' ($z.action -eq 'repair' -and $z.receipt.progress.outcome -eq 'unknown' -and $z.budget.attemptsUsed -eq 5)

# oscillation A,B,A,B
$l = NewLedger
$A = C 'unit' 'failed' 'AssertionError alpha'; $B = C 'unit' 'failed' 'AssertionError beta'
foreach ($x in $A, $B, $A) { $z = Invoke-RepairDecision @($x) $l $wide9 -Effective $big }
Check 'one return to an earlier failure is tolerated' ($z.action -ne 'stop')
$z = Invoke-RepairDecision @($B) $l $wide9 -Effective $big
Check 'A,B,A,B -> oscillation' ($z.action -eq 'stop' -and $z.reasonCode -eq 'oscillation')

# time / token / cost ceilings
foreach ($case in @(@('maxSeconds', 10, @{ AttemptSeconds = 12 }), @('maxTokens', 100, @{ AttemptTokens = 150 }), @('maxCostUsd', 1, @{ AttemptCostUsd = 1.5 }))) {
    $cd = Get-Content -Raw $bigFile | ConvertFrom-Json -AsHashtable; $cd.limits[$case[0]] = $case[1]
    $cf = Join-Path $tmp "ceil-$($case[0]).json"; $cd | ConvertTo-Json -Depth 8 | Set-Content $cf
    $ce = Get-EffectiveRepairPolicy -Legacy $wide9 -PolicyPath $cf
    $l = NewLedger; $extra = $case[2]
    Invoke-RepairDecision @((& $mk 1)) $l $wide9 -Effective $ce @extra | Out-Null
    $z = Invoke-RepairDecision @((& $mk 2)) $l $wide9 -Effective $ce
    Check "$($case[0]) ceiling -> global_budget_exhausted" ($z.action -eq 'stop' -and $z.reasonCode -eq 'global_budget_exhausted' -and $z.stopReason -eq 'budget_ceiling')
}

# infra retry budget is separate from the repair budget
$l = NewLedger
$net = C 'net' 'failed' 'connection refused'
1..2 | ForEach-Object { $z = Invoke-RepairDecision @($net) $l $policy }
Check 'infrastructure retries use their own budget and never repair rounds' ($z.budget.backoffs -eq 2 -and $z.budget.attemptsUsed -eq 0 -and $z.strategy -eq 'infrastructure_retry')
$z = Invoke-RepairDecision @($net) $l $policy
Check 'infrastructure budget exhausted is a truthful handoff' ($z.action -eq 'handoff' -and $z.reasonCode -eq 'infrastructure_budget_exhausted' -and -not $z.handoff.successful)

# idempotent replay
$l = NewLedger
$first = Invoke-RepairDecision @($same) $l $policy -IdempotencyKey 'k1'
$again = Invoke-RepairDecision @($same) $l $policy -IdempotencyKey 'k1'
Check 'idempotency key replay returns the original decision and charges nothing' ($again.replayed -and $again.round -eq $first.round -and $l.receipts.Count -eq 1 -and $l.entries.Count -eq 1)

# atomic reservation: cancellation, idempotency, concurrency
$ledgerFile = Join-Path $tmp 'res/ledger.json'
$r = Request-RepairReservation $ledgerFile 'a' $eff
$rr = Request-RepairReservation $ledgerFile 'a' $eff
Check 'reservation is granted once and replays by key' ($r.granted -and -not $r.replayed -and $rr.granted -and $rr.replayed -and $rr.round -eq $r.round)
Request-RepairReservation $ledgerFile 'b' $eff | Out-Null
Check 'reservation over the cap is refused' (-not (Request-RepairReservation $ledgerFile 'c' $eff).granted)
Stop-RepairReservation $ledgerFile 'b' | Out-Null
Check 'cancellation releases the attempt and is recorded' ((Request-RepairReservation $ledgerFile 'c' $eff).granted -and (Read-RepairLedger $ledgerFile $null).entries.Where({ $_.reservationKey -eq 'b' })[0].outcome -eq 'cancelled')
$conc = Join-Path $tmp 'conc/ledger.json'
$lib = (Resolve-Path (Join-Path $PSScriptRoot '../scripts/repair-loop-lib.ps1')).Path
$polPath = (Resolve-Path $repoPolicy).Path
$legacyYaml = (Resolve-Path (Join-Path $PSScriptRoot '../policies/retry.yaml')).Path
$jobs = 1..8 | ForEach-Object {
    Start-Process pwsh -ArgumentList '-NoProfile', '-Command', ". '$lib'; `$p = Get-RepairPolicy '$legacyYaml'; `$e = Get-EffectiveRepairPolicy -Legacy `$p -PolicyPath '$polPath'; (Request-RepairReservation '$conc' 'job$_' `$e).granted | Out-File '$tmp/granted$_.txt'" -PassThru
}
$jobs | Wait-Process -Timeout 120
$granted = @(1..8 | Where-Object { (Get-Content "$tmp/granted$_.txt" -ErrorAction SilentlyContinue) -eq 'True' }).Count
Check 'concurrent reservations never exceed the cap' ($granted -eq 2 -and (Read-RepairLedger $conc $null).entries.Count -eq 2)

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
if ($failures) { Write-Host "$failures failed"; exit 1 }
