# Fake provider/session adapter for adaptive-repair end-to-end tests (issue #742). No provider calls.
# Mirrors the contract of cezar/packages/cezar/src/core/session-continuation.ts: one create, N continuations,
# idempotency keys, one pending turn, and a closed session never silently becomes a new one.
$script:SecretCanaries = @('sk-canary-0123456789abcdef', 'ghp_CANARY0123456789abcdefABCDEF012345', 'Bearer canary-token-9f8e7d')

class FakeClock { [int]$Ticks = 0; [string] Now() { $this.Ticks++; return ([DateTime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc).AddSeconds($this.Ticks).ToString('o')) } }

class FakeSession {
    [int]$Creates = 0; [int]$Continues = 0; [int]$WorktreeBuilds = 0; [int]$CacheBuilds = 0
    [bool]$Open = $true; [bool]$Live = $true
    [hashtable]$Accepted = @{}; [string]$Pending = ''
    [System.Collections.ArrayList]$Messages = [System.Collections.ArrayList]::new()
    [void] Create() { $this.Creates++; $this.WorktreeBuilds++; $this.CacheBuilds++ }
    # Returns sent | duplicate | busy | unsupported | session_unavailable. Never creates a replacement session.
    [string] Continue([string]$Feedback, [string]$Key) {
        if ($this.Accepted.ContainsKey($Key)) { return 'duplicate' }
        if (-not $this.Live) { return 'unsupported' }
        if (-not $this.Open) { return 'session_unavailable' }
        if ($this.Pending) { return 'busy' }
        $this.Pending = $Key; $this.Continues++; $this.Accepted[$Key] = $this.Continues
        [void]$this.Messages.Add($Feedback)
        return 'sent'
    }
    [bool] Complete([string]$Key) { if ($this.Pending -ne $Key) { return $false }; $this.Pending = ''; return $true }
}

# Progress model: a finding is {id; severity; kind}. Test deletion, skip or discovery-count change is never progress.
function Get-RoundProgress([object[]]$Prev, [object[]]$Next, [hashtable]$Tests) {
    $prevIds = @($Prev | ForEach-Object { $_.id }); $nextIds = @($Next | ForEach-Object { $_.id })
    if ($Tests.discoveredBefore -ne $Tests.discoveredAfter -or $Tests.skippedAfter -gt $Tests.skippedBefore -or $Tests.deleted -gt 0) { return 'tampered' }
    if ($nextIds.Count -eq 0) { return 'pass' }
    $sev = @{ low = 1; medium = 2; high = 3 }
    $worst = { param($f) if (@($f).Count -eq 0) { 0 } else { (@($f) | ForEach-Object { $sev[[string]$_.severity] } | Measure-Object -Maximum).Maximum } }
    if ((& $worst $Next) -gt (& $worst $Prev)) { return 'regression' }
    if ((@($nextIds | Where-Object { $_ -notin $prevIds }).Count -gt 0) -and $nextIds.Count -ge $prevIds.Count) { return 'different' }
    if ($nextIds.Count -lt $prevIds.Count) { return 'progress' }
    return 'unchanged'
}

# Bounded driver. $Rounds: scripted validator outputs, each {revision; findings; tests; outcome(optional: process-failure|inconclusive|command-failure|governance)}.
# Returns a receipt; secrets are never copied into it.
function Invoke-AdaptiveRepairRun([object[]]$Rounds, [FakeSession]$Session, [FakeClock]$Clock, [int]$MaxTurns = 6, [int]$MaxUnchanged = 2, [hashtable]$Baseline = @{}, [string]$PriorKey = '') {
    $ledger = [System.Collections.ArrayList]::new(); $seen = @{}; $prev = @(); $unchanged = 0; $best = [int]::MaxValue; $revision = 0
    $receipt = [ordered]@{ status = 'incomplete'; stopReason = ''; turns = 0; finalValidation = $false; ledger = $ledger }
    $i = 0
    foreach ($r in $Rounds) {
        $i++
        $at = $Clock.Now()
        if ($r.revision -lt $revision) { [void]$ledger.Add([ordered]@{ round = $i; at = $at; decision = 'rejected-stale' }); $receipt.stopReason = 'stale_validation'; return $receipt }
        $revision = $r.revision
        if ($r.outcome -in 'process-failure', 'inconclusive') { [void]$ledger.Add([ordered]@{ round = $i; at = $at; decision = 'stop' }); $receipt.stopReason = 'validator_inconclusive'; return $receipt }
        if ($r.outcome -eq 'command-failure') { [void]$ledger.Add([ordered]@{ round = $i; at = $at; decision = 'stop' }); $receipt.stopReason = 'command_failure'; return $receipt }
        if ($r.outcome -eq 'governance') { [void]$ledger.Add([ordered]@{ round = $i; at = $at; decision = 'stop' }); $receipt.stopReason = 'governance'; return $receipt }
        $findings = @($r.findings | Where-Object { $_.id -notin @($Baseline.Keys) -or $_.severity -ne $Baseline[$_.id] })
        $verdict = if ($i -eq 1) { 'initial' } else { Get-RoundProgress $prev $findings $r.tests }
        [void]$ledger.Add([ordered]@{ round = $i; at = $at; revision = $r.revision; findings = @($findings | ForEach-Object { $_.id }); verdict = $verdict })
        if ($verdict -eq 'pass') { $receipt.status = 'passed'; $receipt.finalValidation = $true; return $receipt }
        if ($verdict -in 'tampered', 'regression') { $receipt.stopReason = $verdict; return $receipt }
        if ($verdict -eq 'unchanged') { $unchanged++ } else { $unchanged = 0 }
        if ($unchanged -ge $MaxUnchanged) { $receipt.stopReason = 'no_progress'; return $receipt }
        $key = (@($findings | ForEach-Object { $_.id } | Sort-Object) -join ',')
        if ($seen.ContainsKey($key) -and $seen[$key] -ge 2) { $receipt.stopReason = 'oscillation'; return $receipt }
        $seen[$key] = 1 + [int]$seen[$key]
        if ($receipt.turns -ge $MaxTurns) { $receipt.stopReason = 'total_cap'; return $receipt }
        $res = $Session.Continue("repair: $($findings.id -join ',')", "k-$($r.revision)-$i")
        if ($res -notin 'sent', 'duplicate') { $receipt.stopReason = "resume_$res"; return $receipt }
        [void]$Session.Complete("k-$($r.revision)-$i")
        $receipt.turns++
        $prev = $findings
    }
    $receipt.stopReason = 'rounds_exhausted'
    return $receipt
}
