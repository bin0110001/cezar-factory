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
if ($failures) { Write-Host "$failures failed"; exit 1 }
