#!/usr/bin/env pwsh
# End-to-end fixtures and failure injection for adaptive in-session repair (issue #742, parent #736).
# Runs locally with fake provider/session adapters; no provider calls, no GitHub Actions.
# Scenarios needing the coordinator/evaluator/policy modules (#739-#741) are gated on module presence and
# reported as SKIP, never silently passed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'fixtures/adaptive-repair/fake-session.ps1')
. (Join-Path $PSScriptRoot '../scripts/repair-loop-lib.ps1')
$failures = 0
function Check([string]$name, [bool]$c) { if ($c) { Write-Host "  ok   $name" } else { Write-Host "  FAIL $name"; $script:failures++ } }
function Skip([string]$name, [string]$why) { Write-Host "  SKIP $name ($why)" }
function F([string]$id, [string]$sev = 'medium') { [pscustomobject]@{ id = $id; severity = $sev } }
$cleanTests = @{ discoveredBefore = 10; discoveredAfter = 10; skippedBefore = 0; skippedAfter = 0; deleted = 0 }
function NewRound([int]$rev, [object[]]$f, [hashtable]$t = $cleanTests, [string]$o = '') { [pscustomobject]@{ revision = $rev; findings = $f; tests = $t; outcome = $o } }
function NewSession { $s = [FakeSession]::new(); $s.Create(); $s }
function Run([object[]]$rounds, [FakeSession]$s = $(NewSession), [hashtable]$opt = @{}) {
    $cap = if ($opt.cap) { $opt.cap } else { 6 }; $base = if ($opt.baseline) { $opt.baseline } else { @{} }
    Invoke-AdaptiveRepairRun $rounds $s ([FakeClock]::new()) $cap 2 $base
}

Write-Host '-- same-session repair path'
$s = NewSession
$rc = Run @((NewRound 1 @((F 'A'), (F 'B'))), (NewRound 2 @((F 'B'), (F 'C'))), (NewRound 3 @((F 'C'))), (NewRound 4 @())) $s
Check 'A/B -> B+C -> C -> pass succeeds' ($rc.status -eq 'passed' -and $rc.finalValidation)
Check 'session create count is 1' ($s.Creates -eq 1)
Check 'continuation count equals repair turns (3)' ($s.Continues -eq 3 -and $rc.turns -eq 3)
Check 'worktree and cache context built once, not rebuilt' ($s.WorktreeBuilds -eq 1 -and $s.CacheBuilds -eq 1)

Write-Host '-- table-driven policy scenarios'
$table = @(
    @{ n = 'unchanged finding stops after bound'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @((F 'A'))), (NewRound 3 @((F 'A'))), (NewRound 4 @((F 'A')))); stop = 'no_progress' }
    @{ n = 'same finding with relevant partial edit continues'; r = @((NewRound 1 @((F 'A'), (F 'B'))), (NewRound 2 @((F 'A'))), (NewRound 3 @())); status = 'passed' }
    @{ n = 'different findings reach total cap'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @((F 'B'))), (NewRound 3 @((F 'C'))), (NewRound 4 @((F 'D'))), (NewRound 5 @((F 'E')))); cap = 2; stop = 'total_cap' }
    @{ n = 'A<->B oscillation stops'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @((F 'B'))), (NewRound 3 @((F 'A'))), (NewRound 4 @((F 'B'))), (NewRound 5 @((F 'A'))), (NewRound 6 @((F 'B')))); stop = 'oscillation' }
    @{ n = 'regression severity stops'; r = @((NewRound 1 @((F 'A' 'low'))), (NewRound 2 @((F 'A' 'high')))); stop = 'regression' }
    @{ n = 'validator process failure stops'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @() $cleanTests 'process-failure')); stop = 'validator_inconclusive' }
    @{ n = 'validator inconclusive stops'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @() $cleanTests 'inconclusive')); stop = 'validator_inconclusive' }
    @{ n = 'command failure stops'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @() $cleanTests 'command-failure')); stop = 'command_failure' }
    @{ n = 'governance stop'; r = @((NewRound 1 @((F 'A'))), (NewRound 2 @() $cleanTests 'governance')); stop = 'governance' }
    @{ n = 'truthful incomplete when rounds run out'; r = @((NewRound 1 @((F 'A'), (F 'B'))), (NewRound 2 @((F 'A')))); status = 'incomplete'; stop = 'rounds_exhausted' }
)
foreach ($t in $table) {
    $rc = Run $t.r (NewSession) @{ cap = $t.cap }
    $okStatus = if ($t.status) { $rc.status -eq $t.status } else { $rc.status -eq 'incomplete' }
    $okStop = if ($t.stop) { $rc.stopReason -eq $t.stop } else { $true }
    Check $t.n ($okStatus -and $okStop -and -not ($rc.status -eq 'passed' -and -not $rc.finalValidation))
}

Write-Host '-- progress integrity'
$tamper = @(
    @{ n = 'test deletion is not progress'; t = @{ discoveredBefore = 10; discoveredAfter = 9; skippedBefore = 0; skippedAfter = 0; deleted = 1 } }
    @{ n = 'new skip is not progress'; t = @{ discoveredBefore = 10; discoveredAfter = 10; skippedBefore = 0; skippedAfter = 1; deleted = 0 } }
    @{ n = 'discovery count change is not progress'; t = @{ discoveredBefore = 10; discoveredAfter = 12; skippedBefore = 0; skippedAfter = 0; deleted = 0 } }
)
foreach ($t in $tamper) {
    $rc = Run @((NewRound 1 @((F 'A'), (F 'B'))), (NewRound 2 @((F 'A')) $t.t))
    Check $t.n ($rc.stopReason -eq 'tampered' -and $rc.status -ne 'passed')
}
$rc = Run @((NewRound 5 @((F 'A'))), (NewRound 4 @((F 'A'))))
Check 'stale validation revision is rejected' ($rc.stopReason -eq 'stale_validation' -and $rc.ledger[-1].decision -eq 'rejected-stale')

Write-Host '-- baseline'
$rc = Run @((NewRound 1 @((F 'old'), (F 'A'))), (NewRound 2 @((F 'old')))) (NewSession) @{ baseline = @{ old = 'medium' } }
Check 'existing baseline failure accepted when not worsened' ($rc.status -eq 'passed' -and $rc.finalValidation)
$rc = Run @((NewRound 1 @((F 'old'), (F 'A'))), (NewRound 2 @((F 'old' 'high')))) (NewSession) @{ baseline = @{ old = 'medium' } }
Check 'worsened baseline failure is not accepted' ($rc.status -ne 'passed')

Write-Host '-- failure injection'
$s = NewSession
$k = 'dup-key'
$r1 = $s.Continue('fix A', $k); $r2 = $s.Continue('fix A', $k)
Check 'duplicate repair dispatch yields one dispatch' ($r1 -eq 'sent' -and $r2 -eq 'duplicate' -and $s.Continues -eq 1)
Check 'distinct dispatch while pending is busy' ($s.Continue('fix B', 'other') -eq 'busy' -and $s.Continues -eq 1)
# Crash after reservation: a restarted driver reuses the persisted key and must not dispatch twice.
$tmp = Join-Path ([IO.Path]::GetTempPath()) "adaptive-repair-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory $tmp | Out-Null
try {
    $resv = Join-Path $tmp 'reservation.json'
    Set-Content $resv (@{ key = 'k-1-1'; state = 'reserved' } | ConvertTo-Json)
    $s2 = NewSession
    $key = (Get-Content -Raw $resv | ConvertFrom-Json).key
    $first = $s2.Continue('fix A', $key)               # crash happened after this send
    $s3 = $s2                                           # resumed process rebuilds nothing, reuses key
    $again = $s3.Continue('fix A', $key)
    Check 'crash after reservation recovers idempotently' ($first -eq 'sent' -and $again -eq 'duplicate' -and $s3.Continues -eq 1 -and $s3.Creates -eq 1)
} finally { Remove-Item -Recurse -Force $tmp }
$s = NewSession; $s.Open = $false
$rc = Run @((NewRound 1 @((F 'A'))), (NewRound 2 @((F 'A')))) $s
Check 'resume unavailable stops truthfully, no silent new agent' ($rc.status -eq 'incomplete' -and $rc.stopReason -eq 'resume_session_unavailable' -and $s.Creates -eq 1)
$s = NewSession; $s.Live = $false
$rc = Run @((NewRound 1 @((F 'A'))), (NewRound 2 @((F 'A')))) $s
Check 'unsupported provider stops with a receipt, no new session' ($rc.stopReason -eq 'resume_unsupported' -and $s.Creates -eq 1)

Write-Host '-- property invariants (seeded)'
$rng = [Random]::new(742); $ids = 'A', 'B', 'C', 'D'; $sevs = 'low', 'medium', 'high'
$det = $true; $bounded = $true; $monotone = $true
foreach ($n in 1..60) {
    $rounds = foreach ($rev in 1..($rng.Next(1, 10))) { NewRound $rev @($ids | Where-Object { $rng.Next(2) } | ForEach-Object { F $_ $sevs[$rng.Next(3)] }) }
    $a = Run $rounds (NewSession) @{ cap = 3 }; $b = Run $rounds (NewSession) @{ cap = 3 }
    if (($a | ConvertTo-Json -Depth 6) -ne ($b | ConvertTo-Json -Depth 6)) { $det = $false }
    if ($a.turns -gt 3) { $bounded = $false }
    if ($a.status -eq 'passed' -and @($rounds[-1].findings).Count -gt 0 -and $a.ledger[-1].findings.Count -gt 0) { $monotone = $false }
}
Check 'same input gives identical receipts' $det
Check 'turns never exceed the cap' $bounded
Check 'a pass is never reported with findings left' $monotone

Write-Host '-- real repair-loop ledger'
$policy = Get-RepairPolicy (Join-Path $PSScriptRoot '../policies/retry.yaml')
$canary = $script:SecretCanaries
$ledger = [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]::new() }
$chk = [pscustomobject]@{ checkId = 'unit'; status = 'failed'; message = 'AssertionError x'; output = ''; commitSha = 'abc' }
$d = Invoke-RepairDecision @($chk) $ledger $policy 5
Check 'repair decision records a pending ledger entry' ($d.action -eq 'repair' -and $ledger.entries.Count -eq 1)

Write-Host '-- secret canary scan'
$s = NewSession
$rc = Run @((NewRound 1 @((F 'A'))), (NewRound 2 @())) $s
$blob = ($rc | ConvertTo-Json -Depth 8) + ($d | ConvertTo-Json -Depth 10) + ($ledger | ConvertTo-Json -Depth 10)
$leak = @($canary | Where-Object { $blob.Contains($_) })
Check 'ledger and receipts leak no secret canaries' ($leak.Count -eq 0)
$cs = NewSession; [void]$cs.Continue("token $($canary[0])", 'x')
$withSecret = Run @((NewRound 1 @((F "leak-$($canary[1])"))), (NewRound 2 @())) (NewSession)
Check 'scan detects a canary when one is present (scanner is live)' ((($withSecret | ConvertTo-Json -Depth 8).Contains($canary[1])) -eq $true)

Write-Host '-- gated on dependent modules'
foreach ($m in @(@('coordinator', 'scripts/repair-coordinator.ps1'), @('evaluator', 'scripts/repair-evaluator.ps1'), @('policy', 'scripts/repair-policy.ps1'))) {
    if (Test-Path (Join-Path $PSScriptRoot "../$($m[1])")) { Skip "$($m[0]) module present: wire its scenarios into this table" 'module landed; scenarios must be bound' ; $script:failures++ }
    else { Skip "$($m[0]) contract scenarios" "$($m[1]) not landed; harness model used" }
}
if ($failures) { Write-Host "$failures failed"; exit 1 }
