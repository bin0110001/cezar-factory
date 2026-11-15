# Bounded triage/repair loop controller (issue #105). Deterministic: bounds live here and in
# policies/retry.yaml, never in prompt text. Dot-sourced by repair-loop-step.ps1 (a workflow command: step).
. (Join-Path $PSScriptRoot 'failure-summary-lib.ps1')

# Reads only the keys the loop consumes. Fails closed on an unreadable or incomplete policy.
function Get-RepairPolicy([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Retry policy not found: $Path" }
    $text = Get-Content -Raw -LiteralPath $Path
    $maxRetries = $null
    if ($text -match '(?m)^max_implementation_retries:\s*(\d+)\s*(#.*)?$') { $maxRetries = [int]$Matches[1] }
    $env = if ($text -match '(?m)^environment_failure_handling:\s*"?([A-Za-z_]+)"?\s*$') { $Matches[1] } else { $null }
    $flaky = if ($text -match '(?m)^flaky_test_handling:\s*"?([A-Za-z_]+)"?\s*$') { $Matches[1] } else { $null }
    $stops = @()
    if ($text -match '(?ms)^stop_automatic_modifications_on:\s*\r?\n((?:[ \t]+-[ \t]*\S+[ \t]*\r?\n?)+)') {
        $stops = @([regex]::Matches($Matches[1], '-\s*(\S+)') | ForEach-Object { $_.Groups[1].Value })
    }
    if ($null -eq $maxRetries -or -not $env -or -not $flaky -or $stops.Count -eq 0) { throw "Retry policy $Path is missing max_implementation_retries, environment_failure_handling, flaky_test_handling or stop_automatic_modifications_on." }
    if ($flaky -ne 'retry_once_then_investigate' -or $env -ne 'retry_with_backoff') { throw "Unsupported handling in ${Path}: flaky=$flaky environment=$env." }
    return [ordered]@{ maxAttempts = $maxRetries; environmentHandling = $env; flakyHandling = $flaky; stopOn = $stops }
}

$script:AssertionPattern = '(?i)\b(AssertionError|assert(ion)? failed|SyntaxError|TypeError|parse error|compilation? (error|failed)|cannot find symbol|expected .* (but|got)|FAIL\s+[A-Za-z0-9_./-]+)'
$script:InfrastructurePattern = '(?i)(timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|connection (refused|reset)|\b(429|502|503|504)\b|rate limit|service unavailable|no space left|temporary failure in name resolution|network is unreachable|cancell?ed)'

# Classes: pass | untested | flaky | infrastructure | code-defect. Assertion/syntax/type evidence outranks
# infrastructure words (a test of network handling is not an outage); same-commit pass+fail history is flaky.
function ConvertTo-RepairCheck([object]$Check) {
    $v = { param($n, $d) $p = $Check.PSObject.Properties[$n]; if ($null -ne $p -and $null -ne $p.Value) { $p.Value } else { $d } }
    return [pscustomobject]@{
        checkId = [string](& $v 'checkId' ''); status = [string](& $v 'status' ''); message = [string](& $v 'message' ''); output = [string](& $v 'output' '')
        commitSha = [string](& $v 'commitSha' ''); history = @(& $v 'history' @()); flaky = ((& $v 'flaky' $false) -eq $true)
        safetyViolation = ((& $v 'safetyViolation' $false) -eq $true); securityIssue = ((& $v 'securityIssue' $false) -eq $true)
    }
}

function Get-FailureClass([object]$Check) {
    $Check = ConvertTo-RepairCheck $Check
    $status = ([string]$Check.status).ToLowerInvariant()
    if ($status -in 'passed', 'pass', 'ok') { return 'pass' }
    if ($status -in 'untested', 'skipped', 'not-run', 'missing', 'deferred', '') { return 'untested' }
    $text = "$($Check.message) $($Check.output)"
    $sha = [string]$Check.commitSha
    $hist = @($Check.history)
    if ($sha -and ($hist | Where-Object { $_.commitSha -eq $sha -and $_.status -in 'passed', 'pass' }) -and ($hist | Where-Object { $_.commitSha -eq $sha -and $_.status -in 'failed', 'fail' })) { return 'flaky' }
    if ($Check.flaky -eq $true) { return 'flaky' }
    if ($text -match $script:AssertionPattern) { return 'code-defect' }
    if ($text -match $script:InfrastructurePattern) { return 'infrastructure' }
    return 'code-defect'
}

function Get-FailureFingerprint([object]$Check) {
    $norm = ("$($Check.checkId)|$($Check.message)" -replace '\d+', '#' -replace '\s+', ' ').Trim().ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($norm))
    return ([BitConverter]::ToString($sha) -replace '-', '').Substring(0, 16).ToLowerInvariant()
}

function Read-RepairLedger([string]$Path, [object]$Policy) {
    if (Test-Path -LiteralPath $Path) {
        try { $l = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -Depth 10 } catch { throw "Repair ledger $Path is unreadable: $($_.Exception.Message)" }
        if ($null -eq $l -or $l.schemaVersion -ne 1 -or $null -eq $l.entries) { throw "Repair ledger $Path has an unsupported shape." }
        return [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]@($l.entries) }
    }
    return [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]::new() }
}

function Get-RepairBudget([object]$Ledger, [object]$Policy) {
    $repairs = @($Ledger.entries | Where-Object { $_.action -eq 'repair' })
    $seconds = [double]0; foreach ($e in $Ledger.entries) { $seconds += [double]$e.costSeconds }
    return [ordered]@{
        maxAttempts = $Policy.maxAttempts; attemptsUsed = $repairs.Count
        attemptsRemaining = [Math]::Max(0, $Policy.maxAttempts - $repairs.Count)
        flakyRetries = @($Ledger.entries | Where-Object { $_.action -eq 'retry' }).Count
        backoffs = @($Ledger.entries | Where-Object { $_.action -eq 'backoff' }).Count
        costSecondsTotal = $seconds
    }
}

# One decision round. $Checks: {checkId,status,message,output,commitSha,history,flaky,safetyViolation,securityIssue}.
# Mutates $Ledger (resolves pending outcomes, appends this round's entries). Pure otherwise: no network, no git.
function Invoke-RepairDecision([object[]]$Checks, [object]$Ledger, [object]$Policy, [double]$AttemptSeconds = 0, [string]$Now = ([DateTime]::UtcNow.ToString('o'))) {
    $failing = @(); $perCheck = @(); $stop = $null
    foreach ($c in @($Checks | ForEach-Object { ConvertTo-RepairCheck $_ })) {
        $class = Get-FailureClass $c
        $fp = if ($class -eq 'pass') { '' } else { Get-FailureFingerprint $c }
        # Close the previous round's pending outcome for this check.
        foreach ($e in @($Ledger.entries | Where-Object { $_.checkId -eq $c.checkId -and $_.outcome -eq 'pending' })) {
            $e.outcome = if ($class -eq 'pass') { 'fixed' } else { 'still-failing' }
        }
        if ($class -eq 'pass') { continue }
        $failing += [pscustomobject]@{ check = $c; class = $class; fingerprint = $fp }
    }
    $budget = Get-RepairBudget $Ledger $Policy
    foreach ($f in $failing) {
        $c = $f.check
        $prior = @($Ledger.entries | Where-Object { $_.checkId -eq $c.checkId })
        $priorRepairs = @($prior | Where-Object { $_.action -in 'repair', 'repair-batched' })
        $action = 'none'; $reason = ''; $backoff = 0
        if ($c.safetyViolation -eq $true -and 'safety_violation' -in $Policy.stopOn) { $stop = 'safety_violation' }
        if ($c.securityIssue -eq $true -and 'security_issue' -in $Policy.stopOn) { $stop = 'security_issue' }
        $sameRepeats = @($priorRepairs | Where-Object { $_.fingerprint -eq $f.fingerprint -and $_.outcome -eq 'still-failing' })
        if ('repeated_failures' -in $Policy.stopOn -and $sameRepeats.Count -ge 2) { if (-not $stop) { $stop = 'repeated_failures' } }
        switch ($f.class) {
            'untested' { $action = 'none'; $reason = 'untested: no repair attempted; the gap stays visible' }
            'flaky' {
                $n = @($prior | Where-Object { $_.action -eq 'retry' }).Count
                if ($n -lt 1) { $action = 'retry'; $reason = 'flaky: retry once' } else { $action = 'investigate'; $reason = 'flaky: still failing after the single retry; flagged for investigation' }
            }
            'infrastructure' {
                $n = @($prior | Where-Object { $_.action -eq 'backoff' }).Count
                if ($n -lt $Policy.maxAttempts) { $action = 'backoff'; $backoff = [int][Math]::Min(900, 30 * [Math]::Pow(2, $n)); $reason = "infrastructure: back off $backoff s, no repair attempt" }
                else { $action = 'investigate'; $reason = 'infrastructure: backoff bound reached; no repair attempt' }
            }
            'code-defect' {
                if ($budget.attemptsRemaining -le 0) { if (-not $stop) { $stop = 'max_implementation_retries' }; $action = 'none' }
                else { $action = 'repair'; $reason = 'code defect: targeted repair attempt' }
            }
        }
        $perCheck += [pscustomobject]@{ checkId = [string]$c.checkId; class = $f.class; action = $action; reason = $reason; backoffSeconds = $backoff; fingerprint = $f.fingerprint; message = [string]$c.message; output = [string]$c.output }
    }
    if ($stop) { foreach ($p in $perCheck) { if ($p.action -in 'repair', 'retry', 'backoff') { $p.action = 'stopped'; $p.reason = "stopped: $stop" } } }
    $repairs = @($perCheck | Where-Object { $_.action -eq 'repair' })
    # Only one attempt is charged per round even when several checks need repair.
    $action = if ($stop) { 'stop' } elseif ($repairs.Count) { 'repair' } elseif (@($perCheck | Where-Object { $_.action -eq 'retry' }).Count) { 'retry' } elseif (@($perCheck | Where-Object { $_.action -eq 'backoff' }).Count) { 'backoff' } elseif ($perCheck.Count) { 'handoff' } else { 'done' }
    $round = 1; foreach ($e in $Ledger.entries) { if ([int]$e.round -ge $round) { $round = [int]$e.round + 1 } }
    $first = $true
    foreach ($p in $perCheck) {
        $charged = ($p.action -eq 'repair' -and $first)
        if ($p.action -eq 'repair') { $first = $false }
        [void]$Ledger.entries.Add([ordered]@{
            round = $round; at = $Now; checkId = $p.checkId; class = $p.class; action = $p.action; fingerprint = $p.fingerprint
            outcome = if (@('repair', 'retry', 'backoff') -contains $p.action) { 'pending' } else { 'not-attempted' }
            costSeconds = if ($charged) { $AttemptSeconds } else { 0 }; stopReason = [string]$stop
        })
        if ($p.action -eq 'repair' -and -not $charged) { $Ledger.entries[$Ledger.entries.Count - 1].action = 'repair-batched' }
    }
    $maxBackoff = 0; foreach ($p in $perCheck) { if ($p.backoffSeconds -gt $maxBackoff) { $maxBackoff = $p.backoffSeconds } }
    $impacted = @($perCheck | Where-Object { $_.action -in 'repair', 'retry' } | ForEach-Object { $_.checkId })
    $records = @($perCheck | ForEach-Object { [pscustomobject]@{ findingId = $_.fingerprint; identifier = $_.checkId; message = $_.message; detailPath = ''; occurrence = 1 } })
    $handoff = @()
    if ($action -in 'stop', 'handoff') { $handoff = @($perCheck | Where-Object { $_.action -notin 'retry', 'backoff' }) }
    elseif ($action -in 'retry', 'backoff') { $handoff = @($perCheck | Where-Object { $_.action -eq 'investigate' }) }
    return [ordered]@{
        schemaVersion = 1; action = $action; round = $round; stopReason = [string]$stop
        impactedChecks = $impacted
        backoffSeconds = [int]$maxBackoff
        checks = @($perCheck | ForEach-Object { [ordered]@{ checkId = $_.checkId; class = $_.class; action = $_.action; reason = $_.reason } })
        summary = $(if ($records.Count) { New-FailureSummary -Records $records } else { [ordered]@{ schemaVersion = 1; totalFindings = 0; totalOccurrences = 0; truncated = $false; omittedEntries = 0; omittedOccurrences = 0; entries = @() } })
        budget = (Get-RepairBudget $Ledger $Policy)
        handoff = [ordered]@{
            target = 'failure-audit-publication'; createsIssue = $false; waiver = $false
            findings = @($handoff | ForEach-Object { [ordered]@{ findingId = $_.fingerprint; identifier = $_.checkId; class = $_.class; reason = $_.reason; message = (Protect-FailureText $_.message 200); occurrence = 1 } })
        }
    }
}
