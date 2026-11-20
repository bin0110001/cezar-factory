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
    if ($status -in 'error', 'validator_error', 'validator-error') { return 'validator-error' }
    if ($status -in 'untested', 'skipped', 'not-run', 'missing', 'deferred', 'incomplete', '') { return 'untested' }
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

$script:RepairPolicyLimitKeys = 'maxRepairRounds', 'unchangedFindingPersistence', 'consecutiveNoProgress', 'oscillationLimit', 'replanAfterUnchanged', 'maxReplans', 'infraRetryBudget', 'maxSeconds', 'maxTokens', 'maxCostUsd'
$script:RepairGovernanceKeys = 'stopOnSafetyViolation', 'stopOnSecurityIssue', 'enforceRequiredGates', 'incompleteNeverSuccess', 'allowIndependentDiagnosis'

function ConvertTo-RepairDict([object]$Object) {
    $d = [ordered]@{}
    if ($null -eq $Object) { return $d }
    if ($Object -is [System.Collections.IDictionary]) { foreach ($k in $Object.Keys) { $d[[string]$k] = $Object[$k] } }
    else { foreach ($p in $Object.PSObject.Properties) { $d[$p.Name] = $p.Value } }
    return $d
}

function Get-RepairHash([object]$Object) {
    $json = $Object | ConvertTo-Json -Depth 12 -Compress
    $sha = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))
    return ([BitConverter]::ToString($sha) -replace '-', '').ToLowerInvariant()
}

# Layered policy (#740): defaults file -> legacy retry.yaml clamp -> project -> workflow -> validator. A layer can only
# tighten a limit and can never switch governance off; anything invalid or unreadable throws (fail closed). Returns a
# versioned, hashed effective snapshot that every receipt carries.
function Get-EffectiveRepairPolicy([object]$Legacy = $null, [string]$PolicyPath = (Join-Path $PSScriptRoot '../policies/repair-policy.json'), [string]$Workflow = '', [string]$Validator = '', [object[]]$ExtraLayers = @()) {
    if (-not (Test-Path -LiteralPath $PolicyPath)) { throw "Repair policy not found: $PolicyPath" }
    $raw = Get-Content -Raw -LiteralPath $PolicyPath
    $schema = Join-Path $PSScriptRoot '../schemas/repair-policy.schema.json'
    try { $valid = Test-Json -Json $raw -SchemaFile $schema -ErrorAction Stop } catch { throw "Repair policy $PolicyPath failed schema validation: $($_.Exception.Message)" }
    if (-not $valid) { throw "Repair policy $PolicyPath failed schema validation." }
    $doc = $raw | ConvertFrom-Json -Depth 10 -AsHashtable
    $limits = ConvertTo-RepairDict $doc.limits
    foreach ($k in $script:RepairPolicyLimitKeys) { if (-not $limits.Contains($k)) { throw "Repair policy $PolicyPath is missing limit $k." } }
    $gov = ConvertTo-RepairDict $doc.governance
    foreach ($k in $script:RepairGovernanceKeys) { if (-not $gov.Contains($k)) { throw "Repair policy $PolicyPath is missing governance flag $k." } }
    foreach ($k in 'stopOnSafetyViolation', 'stopOnSecurityIssue', 'enforceRequiredGates', 'incompleteNeverSuccess') { if ($gov[$k] -ne $true) { throw "Repair policy $PolicyPath disables mandatory governance flag $k." } }
    if ($gov.allowIndependentDiagnosis -ne $false) { throw "Repair policy $PolicyPath enables independent diagnosis, which is off by default and not selectable as a retry." }
    if ($null -ne $Legacy) { $limits.maxRepairRounds = [Math]::Min([int]$limits.maxRepairRounds, [int]$Legacy.maxAttempts); $limits.infraRetryBudget = [Math]::Min([int]$limits.infraRetryBudget, [int]$Legacy.maxAttempts) }
    $layers = [System.Collections.ArrayList]::new()
    $ov = if ($doc.ContainsKey('overrides') -and $doc.overrides) { $doc.overrides } else { @{} }
    if ($ov.ContainsKey('project') -and $ov.project) { [void]$layers.Add(@{ name = 'project'; layer = $ov.project }) }
    if ($Workflow -and $ov.ContainsKey('workflows') -and $ov.workflows.ContainsKey($Workflow)) { [void]$layers.Add(@{ name = "workflow:$Workflow"; layer = $ov.workflows[$Workflow] }) }
    if ($Validator -and $ov.ContainsKey('validators') -and $ov.validators.ContainsKey($Validator)) { [void]$layers.Add(@{ name = "validator:$Validator"; layer = $ov.validators[$Validator] }) }
    $i = 0; foreach ($x in $ExtraLayers) { $i++; [void]$layers.Add(@{ name = "extra:$i"; layer = (ConvertTo-RepairDict $x) }) }
    $applied = @()
    foreach ($entry in $layers) {
        $ll = $entry.layer; $applied += $entry.name
        $lg = if ($ll -is [System.Collections.IDictionary] -and $ll.Contains('governance')) { ConvertTo-RepairDict $ll['governance'] } else { [ordered]@{} }
        foreach ($k in $lg.Keys) {
            if ($k -notin $script:RepairGovernanceKeys) { throw "Repair policy layer $($entry.name) sets unknown governance key $k." }
            if ($k -eq 'allowIndependentDiagnosis') { if ($lg[$k] -ne $false) { throw "Repair policy layer $($entry.name) cannot enable independent diagnosis." } }
            elseif ($lg[$k] -ne $true) { throw "Repair policy layer $($entry.name) cannot disable mandatory governance flag $k." }
        }
        $ln = if ($ll -is [System.Collections.IDictionary] -and $ll.Contains('limits')) { ConvertTo-RepairDict $ll['limits'] } else { [ordered]@{} }
        foreach ($k in $ln.Keys) {
            if ($k -notin $script:RepairPolicyLimitKeys) { throw "Repair policy layer $($entry.name) sets unknown limit $k." }
            $v = $ln[$k]; $cur = $limits[$k]
            if ($null -eq $v) { if ($null -ne $cur) { throw "Repair policy layer $($entry.name) loosens $k (cannot remove a limit)." }; continue }
            if ($v -isnot [ValueType] -or $v -lt 0) { throw "Repair policy layer $($entry.name) has an invalid value for $k." }
            if ($null -ne $cur -and $v -gt $cur) { throw "Repair policy layer $($entry.name) loosens $k from $cur to $v; layers may only tighten." }
            $limits[$k] = $v
        }
    }
    $snapshot = [ordered]@{ schemaVersion = 1; policyVersion = [string]$doc.version; limits = $limits; governance = $gov; layers = @($applied) }
    $snapshot.hash = Get-RepairHash ([ordered]@{ policyVersion = $snapshot.policyVersion; limits = $limits; governance = $gov })
    return $snapshot
}

# Exclusive lock on '<path>.lock' so concurrent evaluators never overspend a budget. Always released.
function Use-RepairLock([string]$Path, [scriptblock]$Body, [int]$TimeoutSeconds = 60) {
    $lockPath = "$Path.lock"
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($lockPath))) -Force | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds); $fs = $null
    while ($null -eq $fs) {
        try { $fs = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { if ([DateTime]::UtcNow -gt $deadline) { throw "Timed out waiting for repair ledger lock $lockPath." }; Start-Sleep -Milliseconds 20 }
    }
    try { & $Body } finally { $fs.Dispose() }
}

function Read-RepairLedger([string]$Path, [object]$Policy) {
    if (Test-Path -LiteralPath $Path) {
        try { $l = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -Depth 12 } catch { throw "Repair ledger $Path is unreadable: $($_.Exception.Message)" }
        if ($null -eq $l -or $l.schemaVersion -ne 1 -or $null -eq $l.entries) { throw "Repair ledger $Path has an unsupported shape." }
        $receipts = if ($null -ne $l.PSObject.Properties['receipts'] -and $null -ne $l.receipts) { @($l.receipts | ForEach-Object { ConvertTo-RepairDict $_ }) } else { @() }
        return [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]@($l.entries | ForEach-Object { ConvertTo-RepairDict $_ }); receipts = [System.Collections.ArrayList]$receipts }
    }
    return [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]::new(); receipts = [System.Collections.ArrayList]::new() }
}

function Write-RepairLedger([string]$Path, [object]$Ledger) {
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($Path))) -Force | Out-Null
    $tmp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    Set-Content -LiteralPath $tmp -Value ($Ledger | ConvertTo-Json -Depth 12)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-RepairBudget([object]$Ledger, [object]$Policy, [object]$Effective = $null) {
    $max = if ($Effective) { [int]$Effective.limits.maxRepairRounds } else { [int]$Policy.maxAttempts }
    $infraMax = if ($Effective) { [int]$Effective.limits.infraRetryBudget } else { [int]$Policy.maxAttempts }
    $live = @($Ledger.entries | Where-Object { $_.outcome -ne 'cancelled' })
    $repairs = @($live | Where-Object { $_.action -in 'repair', 'replan' })
    $seconds = [double]0; $tokens = [double]0; $usd = [double]0
    foreach ($e in $live) { $seconds += [double]$e.costSeconds; if ($e.Contains('tokens')) { $tokens += [double]$e.tokens }; if ($e.Contains('costUsd')) { $usd += [double]$e.costUsd } }
    $backoffs = @($live | Where-Object { $_.action -eq 'backoff' }).Count
    return [ordered]@{
        maxAttempts = $max; attemptsUsed = $repairs.Count
        attemptsRemaining = [Math]::Max(0, $max - $repairs.Count)
        replansUsed = @($repairs | Where-Object { $_.action -eq 'replan' }).Count
        flakyRetries = @($live | Where-Object { $_.action -eq 'retry' }).Count
        backoffs = $backoffs
        infraRetryBudget = $infraMax; infraRetriesRemaining = [Math]::Max(0, $infraMax - $backoffs)
        costSecondsTotal = $seconds; tokensTotal = $tokens; costUsdTotal = $usd
    }
}

# Atomic attempt reservation against the ledger file. Idempotent per key (a replay returns the original reservation);
# a granted reservation counts against the cap until cancelled. Kind 'repair' charges the repair budget, 'infra' the
# separate infrastructure budget. Session continuation or replan never resets either.
function Request-RepairReservation([string]$LedgerPath, [string]$Key, [object]$Effective, [string]$Kind = 'repair', [string]$Now = ([DateTime]::UtcNow.ToString('o'))) {
    if (-not $Key) { throw 'A reservation needs an idempotency key.' }
    Use-RepairLock $LedgerPath {
        $l = Read-RepairLedger $LedgerPath $null
        $existing = @($l.entries | Where-Object { $_.Contains('reservationKey') -and $_.reservationKey -eq $Key })
        if ($existing.Count) { return [ordered]@{ granted = ($existing[0].outcome -ne 'cancelled'); replayed = $true; round = [int]$existing[0].round; reasonCode = 'repair_authorized' } }
        $b = Get-RepairBudget $l $null $Effective
        $remaining = if ($Kind -eq 'infra') { $b.infraRetriesRemaining } else { $b.attemptsRemaining }
        if ($remaining -le 0) { return [ordered]@{ granted = $false; replayed = $false; round = 0; reasonCode = 'global_budget_exhausted' } }
        $round = 1; foreach ($e in $l.entries) { if ([int]$e.round -ge $round) { $round = [int]$e.round + 1 } }
        [void]$l.entries.Add([ordered]@{ round = $round; at = $Now; checkId = ''; class = 'reservation'; action = $(if ($Kind -eq 'infra') { 'backoff' } else { 'repair' }); fingerprint = ''; outcome = 'pending'; costSeconds = 0; stopReason = ''; reservationKey = $Key })
        Write-RepairLedger $LedgerPath $l
        return [ordered]@{ granted = $true; replayed = $false; round = $round; reasonCode = 'repair_authorized' }
    }
}

function Stop-RepairReservation([string]$LedgerPath, [string]$Key) {
    Use-RepairLock $LedgerPath {
        $l = Read-RepairLedger $LedgerPath $null
        $e = @($l.entries | Where-Object { $_.Contains('reservationKey') -and $_.reservationKey -eq $Key })
        if (-not $e.Count) { return $false }
        $e[0].outcome = 'cancelled'
        Write-RepairLedger $LedgerPath $l
        return $true
    }
}

$script:StopRank = @{ governance_stop = 0; validator_error = 1; global_budget_exhausted = 2; repeated_finding = 3; oscillation = 4; no_progress = 5; session_unavailable = 6 }

# One decision round. $Checks: {checkId,status,message,output,commitSha,history,flaky,safetyViolation,securityIssue}.
# $Progress (#736 contract, optional): {outcome: progress|no_progress|unknown, relevantChange: bool} about the previous
# attempt; missing means unknown and never grants budget. Mutates $Ledger (resolves pending outcomes, appends this
# round's entries and exactly one hash-chained receipt). Pure otherwise: no network, no git.
function Invoke-RepairDecision([object[]]$Checks, [object]$Ledger, [object]$Policy, [double]$AttemptSeconds = 0, [string]$Now = ([DateTime]::UtcNow.ToString('o')), [object]$Effective = $null, [object]$Progress = $null, [string]$IdempotencyKey = '', [double]$AttemptTokens = 0, [double]$AttemptCostUsd = 0, [bool]$SessionAvailable = $true) {
    if ($null -eq $Effective) { $Effective = Get-EffectiveRepairPolicy -Legacy $Policy }
    $lim = $Effective.limits
    if (-not $Ledger.Contains('receipts')) { $Ledger['receipts'] = [System.Collections.ArrayList]::new() }
    if ($IdempotencyKey) {
        $prev = @($Ledger.receipts | Where-Object { $_.idempotencyKey -eq $IdempotencyKey })
        if ($prev.Count) { return [ordered]@{ schemaVersion = 1; action = $prev[0].decision; round = [int]$prev[0].round; reasonCode = $prev[0].reasonCode; strategy = $prev[0].strategy; replayed = $true; receipt = $prev[0]; budget = (Get-RepairBudget $Ledger $Policy $Effective) } }
    }
    $progressOutcome = 'unknown'; $relevant = $false
    if ($null -ne $Progress) {
        $pd = ConvertTo-RepairDict $Progress
        if ($pd.Contains('outcome') -and $pd.outcome -in 'progress', 'no_progress') { $progressOutcome = [string]$pd.outcome }
        $relevant = ($pd.Contains('relevantChange') -and $pd.relevantChange -eq $true)
    }
    $failing = @(); $perCheck = @(); $st = @{ code = $null; legacy = '' }
    $setStop = { param($code, $legacy) if ($null -eq $st.code -or $script:StopRank[$code] -lt $script:StopRank[$st.code]) { $st.code = $code; $st.legacy = $legacy } }
    foreach ($c in @($Checks | ForEach-Object { ConvertTo-RepairCheck $_ })) {
        $class = Get-FailureClass $c
        $fp = if ($class -eq 'pass') { '' } else { Get-FailureFingerprint $c }
        # Close the previous round's pending outcome for this check and stamp the progress verdict on it.
        foreach ($e in @($Ledger.entries | Where-Object { $_.checkId -eq $c.checkId -and $_.outcome -eq 'pending' })) {
            $e.outcome = if ($class -eq 'pass') { 'fixed' } else { 'still-failing' }
            $e['progress'] = $progressOutcome; $e['relevantChange'] = $relevant
        }
        if ($class -eq 'pass') { continue }
        $failing += [pscustomobject]@{ check = $c; class = $class; fingerprint = $fp }
    }
    $budget = Get-RepairBudget $Ledger $Policy $Effective
    # Consecutive no-progress rounds, newest first; a round with progress or unknown progress ends the streak.
    $noProgress = 0
    $roundProgress = @($Ledger.entries | Group-Object { [int]$_.round } | Sort-Object { [int]$_.Name } -Descending | ForEach-Object { $p = @($_.Group | Where-Object { $_.Contains('progress') -and $_.progress } | ForEach-Object { $_.progress }); if ($p.Count) { $p[0] } else { 'unknown' } })
    foreach ($p in $roundProgress) { if ($p -eq 'no_progress') { $noProgress++ } else { break } }
    $ceilingHit = (($null -ne $lim.maxSeconds -and $budget.costSecondsTotal -ge [double]$lim.maxSeconds) -or ($null -ne $lim.maxTokens -and $budget.tokensTotal -ge [double]$lim.maxTokens) -or ($null -ne $lim.maxCostUsd -and $budget.costUsdTotal -ge [double]$lim.maxCostUsd))
    foreach ($f in $failing) {
        $c = $f.check
        $prior = @($Ledger.entries | Where-Object { $_.checkId -eq $c.checkId -and $_.outcome -ne 'cancelled' })
        $priorRepairs = @($prior | Where-Object { $_.action -in 'repair', 'repair-batched', 'replan' })
        $action = 'none'; $reason = ''; $backoff = 0
        if ($c.safetyViolation -eq $true) { & $setStop 'governance_stop' 'safety_violation' }
        if ($c.securityIssue -eq $true) { & $setStop 'governance_stop' 'security_issue' }
        $unchanged = 0
        foreach ($e in $priorRepairs) { if ($e['relevantChange'] -eq $true) { $unchanged = 0 } elseif ($e.fingerprint -eq $f.fingerprint -and $e.outcome -eq 'still-failing') { $unchanged++ } }
        if ($unchanged -ge [int]$lim.unchangedFindingPersistence) { & $setStop 'repeated_finding' 'repeated_failures' }
        $seq = @(); foreach ($x in (@($prior | Where-Object { $_.fingerprint } | ForEach-Object { $_.fingerprint }) + @($f.fingerprint))) { if ($seq.Count -eq 0 -or $seq[-1] -ne $x) { $seq += $x } }
        $osc = 0; for ($i = 2; $i -lt $seq.Count; $i++) { if ($seq[$i] -eq $seq[$i - 2]) { $osc++ } }
        if ($osc -ge [int]$lim.oscillationLimit) { & $setStop 'oscillation' 'oscillation' }
        if ($noProgress -ge [int]$lim.consecutiveNoProgress -and $f.class -eq 'code-defect') { & $setStop 'no_progress' 'no_progress' }
        switch ($f.class) {
            'validator-error' { & $setStop 'validator_error' 'validator_error'; $action = 'none'; $reason = 'validator error: the check itself could not report a result' }
            'untested' { $action = 'none'; $reason = 'untested: no repair attempted; the gap stays visible' }
            'flaky' {
                $n = @($prior | Where-Object { $_.action -eq 'retry' }).Count
                if ($n -lt 1) { $action = 'retry'; $reason = 'flaky: retry once' } else { $action = 'investigate'; $reason = 'flaky: still failing after the single retry; flagged for investigation' }
            }
            'infrastructure' {
                $n = @($prior | Where-Object { $_.action -eq 'backoff' }).Count
                if ($n -lt [int]$lim.infraRetryBudget) { $action = 'backoff'; $backoff = [int][Math]::Min(900, 30 * [Math]::Pow(2, $n)); $reason = "infrastructure: back off $backoff s, no repair attempt" }
                else { $action = 'investigate'; $reason = 'infrastructure: backoff bound reached; no repair attempt' }
            }
            'code-defect' {
                if ($budget.attemptsRemaining -le 0) { & $setStop 'global_budget_exhausted' 'max_implementation_retries'; $action = 'none' }
                elseif ($ceilingHit) { & $setStop 'global_budget_exhausted' 'budget_ceiling'; $action = 'none' }
                elseif (-not $SessionAvailable) { & $setStop 'session_unavailable' 'session_unavailable'; $action = 'none' }
                elseif ($unchanged -ge [int]$lim.replanAfterUnchanged -and $budget.replansUsed -lt [int]$lim.maxReplans) { $action = 'replan'; $reason = 'code defect: same finding persisted; in-session replan' }
                else { $action = 'repair'; $reason = 'code defect: targeted repair attempt' }
            }
        }
        $perCheck += [pscustomobject]@{ checkId = [string]$c.checkId; class = $f.class; action = $action; reason = $reason; backoffSeconds = $backoff; fingerprint = $f.fingerprint; message = [string]$c.message; output = [string]$c.output }
    }
    $stop = $st.legacy
    if ($st.code) { foreach ($p in $perCheck) { if ($p.action -in 'repair', 'replan', 'retry', 'backoff') { $p.action = 'stopped'; $p.reason = "stopped: $stop" } } }
    $attempts = @($perCheck | Where-Object { $_.action -in 'repair', 'replan' })
    # Only one attempt is charged per round even when several checks need repair.
    $action = if ($st.code) { 'stop' } elseif (@($perCheck | Where-Object { $_.action -eq 'replan' }).Count) { 'replan' } elseif ($attempts.Count) { 'repair' } elseif (@($perCheck | Where-Object { $_.action -eq 'retry' }).Count) { 'retry' } elseif (@($perCheck | Where-Object { $_.action -eq 'backoff' }).Count) { 'backoff' } elseif ($perCheck.Count) { 'handoff' } else { 'done' }
    $round = 1; foreach ($e in $Ledger.entries) { if ([int]$e.round -ge $round) { $round = [int]$e.round + 1 } }
    $first = $true
    foreach ($p in $perCheck) {
        $charged = ($p.action -in 'repair', 'replan' -and $first)
        if ($p.action -in 'repair', 'replan') { $first = $false }
        [void]$Ledger.entries.Add([ordered]@{
            round = $round; at = $Now; checkId = $p.checkId; class = $p.class; action = $p.action; fingerprint = $p.fingerprint
            outcome = if (@('repair', 'replan', 'retry', 'backoff') -contains $p.action) { 'pending' } else { 'not-attempted' }
            costSeconds = if ($charged) { $AttemptSeconds } else { 0 }; tokens = $(if ($charged) { $AttemptTokens } else { 0 }); costUsd = $(if ($charged) { $AttemptCostUsd } else { 0 })
            stopReason = [string]$stop
        })
        if ($p.action -in 'repair', 'replan' -and -not $charged) { $Ledger.entries[$Ledger.entries.Count - 1].action = 'repair-batched' }
    }
    $maxBackoff = 0; foreach ($p in $perCheck) { if ($p.backoffSeconds -gt $maxBackoff) { $maxBackoff = $p.backoffSeconds } }
    $impacted = @($perCheck | Where-Object { $_.action -in 'repair', 'replan', 'retry' } | ForEach-Object { $_.checkId })
    $records = @($perCheck | ForEach-Object { [pscustomobject]@{ findingId = $_.fingerprint; identifier = $_.checkId; message = $_.message; detailPath = ''; occurrence = 1 } })
    $handoff = @()
    if ($action -in 'stop', 'handoff') { $handoff = @($perCheck | Where-Object { $_.action -notin 'retry', 'backoff' }) }
    elseif ($action -in 'retry', 'backoff') { $handoff = @($perCheck | Where-Object { $_.action -eq 'investigate' }) }
    $reasonCode = if ($st.code) { $st.code } else {
        switch ($action) {
            'done' { 'passed' } 'repair' { 'repair_authorized' } 'replan' { 'replan_authorized' } 'retry' { 'infrastructure_retry' } 'backoff' { 'infrastructure_backoff' }
            default { if (@($perCheck | Where-Object { $_.class -eq 'untested' }).Count) { 'incomplete_reported' } elseif (@($perCheck | Where-Object { $_.class -eq 'infrastructure' }).Count) { 'infrastructure_budget_exhausted' } else { 'flaky_unresolved' } }
        }
    }
    $strategy = switch ($action) { 'repair' { 'focused_repair' } 'replan' { 'replan' } { $_ -in 'retry', 'backoff' } { 'infrastructure_retry' } { $_ -in 'stop', 'handoff' } { 'stop_escalate' } default { 'none' } }
    $budgetNow = Get-RepairBudget $Ledger $Policy $Effective
    $last = if ($Ledger.receipts.Count) { [string]$Ledger.receipts[$Ledger.receipts.Count - 1].hash } else { '' }
    $receipt = [ordered]@{
        schemaVersion = 1; receiptId = ''; round = $round; at = $Now; idempotencyKey = $IdempotencyKey
        decision = $action; reasonCode = $reasonCode; terminal = ($action -in 'stop', 'handoff', 'done'); strategy = $strategy
        progress = [ordered]@{ outcome = $progressOutcome; relevantChange = $relevant }
        policy = [ordered]@{ policyVersion = $Effective.policyVersion; hash = $Effective.hash; snapshot = $Effective }
        budget = $budgetNow
        checks = @($perCheck | ForEach-Object { [ordered]@{ checkId = $_.checkId; class = $_.class; action = $_.action; fingerprint = $_.fingerprint } })
        previousHash = $last; hash = ''
    }
    $receipt.receiptId = "r$round-$((Get-RepairHash ([ordered]@{ round = $round; at = $Now; key = $IdempotencyKey; prev = $last })).Substring(0, 12))"
    $receipt.hash = Get-RepairHash $receipt
    [void]$Ledger.receipts.Add($receipt)
    return [ordered]@{
        schemaVersion = 1; action = $action; round = $round; stopReason = [string]$stop; reasonCode = $reasonCode; strategy = $strategy; receipt = $receipt
        impactedChecks = $impacted
        backoffSeconds = [int]$maxBackoff
        checks = @($perCheck | ForEach-Object { [ordered]@{ checkId = $_.checkId; class = $_.class; action = $_.action; reason = $_.reason } })
        summary = $(if ($records.Count) { New-FailureSummary -Records $records } else { [ordered]@{ schemaVersion = 1; totalFindings = 0; totalOccurrences = 0; truncated = $false; omittedEntries = 0; omittedOccurrences = 0; entries = @() } })
        budget = $budgetNow
        handoff = [ordered]@{
            target = 'failure-audit-publication'; createsIssue = $false; waiver = $false
            successful = ($action -eq 'done'); incomplete = ($action -in 'stop', 'handoff')
            findings = @($handoff | ForEach-Object { [ordered]@{ findingId = $_.fingerprint; identifier = $_.checkId; class = $_.class; reason = $_.reason; message = (Protect-FailureText $_.message 200); occurrence = 1 } })
        }
    }
}
