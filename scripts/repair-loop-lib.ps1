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
        incomplete = ((& $v 'incomplete' $false) -eq $true); relevantChange = ((& $v 'relevantChange' $false) -eq $true); validatorError = ((& $v 'validatorError' $false) -eq $true)
    }
}

function Get-FailureClass([object]$Check) {
    $Check = ConvertTo-RepairCheck $Check
    $status = ([string]$Check.status).ToLowerInvariant()
    if ($Check.incomplete -eq $true) { return 'untested' }   # a truthfully incomplete check is never green
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
        $out = [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]@($l.entries) }
        $out.reservations = [System.Collections.ArrayList]@(if ($null -ne $l.reservations) { $l.reservations })
        $out.receipts = [System.Collections.ArrayList]@(if ($null -ne $l.receipts) { $l.receipts })
        return $out
    }
    return [ordered]@{ schemaVersion = 1; entries = [System.Collections.ArrayList]::new(); reservations = [System.Collections.ArrayList]::new(); receipts = [System.Collections.ArrayList]::new() }
}

# Additive ledger fields (reservations, receipts) are created on demand; legacy v1 ledgers keep working and their
# repair entries are migrated into reservations so the cap sees them.
function Initialize-RepairLedger([object]$Ledger) {
    $has = { param($n) if ($Ledger -is [System.Collections.IDictionary]) { $Ledger.Contains($n) } else { $null -ne $Ledger.PSObject.Properties[$n] } }
    if (-not (& $has 'receipts')) { $Ledger.receipts = [System.Collections.ArrayList]::new() }
    if (-not (& $has 'reservations')) {
        $Ledger.reservations = [System.Collections.ArrayList]::new()
        foreach ($e in @($Ledger.entries | Where-Object { $_.action -in 'repair', 'replan' })) {
            [void]$Ledger.reservations.Add([ordered]@{ key = "legacy-round-$($e.round)"; kind = $e.action; state = 'committed'; round = [int]$e.round; at = [string]$e.at })
        }
    }
}

function Get-RepairBudget([object]$Ledger, [object]$Policy) {
    Initialize-RepairLedger $Ledger
    $active = @($Ledger.reservations | Where-Object { $_.state -ne 'cancelled' })
    $seconds = [double]0; $tokens = [double]0; $usd = [double]0
    foreach ($e in $Ledger.entries) { $seconds += [double]$e.costSeconds; $ct = $e.PSObject.Properties['costTokens']; if ($ct) { $tokens += [double]$ct.Value }; $cu = $e.PSObject.Properties['costUsd']; if ($cu) { $usd += [double]$cu.Value } }
    $rounds = @($Ledger.entries | ForEach-Object { [int]$_.round } | Sort-Object -Unique).Count
    $infra = @($Ledger.entries | Where-Object { $_.action -in 'retry', 'backoff' }).Count
    return [ordered]@{
        maxAttempts = $Policy.maxAttempts; attemptsUsed = $active.Count
        attemptsRemaining = [Math]::Max(0, $Policy.maxAttempts - $active.Count)
        replansUsed = @($active | Where-Object { $_.kind -eq 'replan' }).Count
        flakyRetries = @($Ledger.entries | Where-Object { $_.action -eq 'retry' }).Count
        backoffs = @($Ledger.entries | Where-Object { $_.action -eq 'backoff' }).Count
        infrastructureRetriesUsed = $infra
        validationRounds = $rounds
        costSecondsTotal = $seconds; costTokensTotal = $tokens; costUsdTotal = $usd
    }
}

# ---- Layered repair authorization policy (#740) ----------------------------------------------------------------
$script:RepairLimitKeys = 'totalRepairRounds', 'unchangedFindingPersistence', 'consecutiveNoProgress', 'oscillationLimit', 'replanCap', 'infraRetryBudget'
$script:RepairGovernanceKeys = 'stopOnSafetyViolation', 'stopOnSecurityIssue', 'requireRequiredGates'

function Read-RepairPolicyLayer([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Repair policy not found: $Path" }
    $json = Get-Content -Raw -LiteralPath $Path
    $schema = Join-Path $PSScriptRoot '../schemas/repair-policy.schema.json'
    $ok = $false; try { $ok = Test-Json -Json $json -SchemaFile $schema -ErrorAction Stop } catch { $ok = $false }
    if (-not $ok) { throw "Repair policy $Path is invalid against schemas/repair-policy.schema.json." }
    return ($json | ConvertFrom-Json -Depth 10)
}

# Merges layers Factory -> project -> workflow -> validator. Overrides may only tighten: numeric limits and ceilings
# never exceed the layer below, governance flags can never be turned off, independent diagnosis cannot be enabled
# below the Factory layer. Any violation or unreadable layer throws (fail closed).
function Get-RepairAuthorizationPolicy([string]$FactoryPath, [string[]]$OverridePaths = @(), [object]$Legacy = $null) {
    $base = Read-RepairPolicyLayer $FactoryPath
    foreach ($k in $script:RepairLimitKeys) { if (-not $base.PSObject.Properties['limits'] -or $null -eq $base.limits.PSObject.Properties[$k]) { throw "Factory repair policy is missing limits.$k." } }
    foreach ($k in $script:RepairGovernanceKeys) { if (-not $base.PSObject.Properties['governance'] -or $null -eq $base.governance.PSObject.Properties[$k] -or $base.governance.$k -ne $true) { throw "Factory repair policy must keep governance.$k true." } }
    if (-not $base.governance.PSObject.Properties['allowIncompleteAsSuccess'] -or $base.governance.allowIncompleteAsSuccess -ne $false) { throw 'Factory repair policy must keep governance.allowIncompleteAsSuccess false.' }
    $eff = [ordered]@{ policyVersion = [int]$base.policyVersion; limits = [ordered]@{}; ceilings = [ordered]@{ maxSeconds = $null; maxTokens = $null; maxCostUsd = $null }
        governance = [ordered]@{ stopOnSafetyViolation = $true; stopOnSecurityIssue = $true; requireRequiredGates = $true; allowIncompleteAsSuccess = $false }
        independentDiagnosis = ($base.PSObject.Properties['independentDiagnosis'] -and $base.independentDiagnosis -eq $true); layers = @('factory') }
    foreach ($k in $script:RepairLimitKeys) { $eff.limits[$k] = [int]$base.limits.$k }
    foreach ($k in 'maxSeconds', 'maxTokens', 'maxCostUsd') { if ($base.PSObject.Properties['ceilings'] -and $null -ne $base.ceilings.$k) { $eff.ceilings[$k] = [double]$base.ceilings.$k } }
    # The legacy retry.yaml bound stays authoritative when it is tighter.
    if ($null -ne $Legacy -and $Legacy.maxAttempts -lt $eff.limits.totalRepairRounds) { $eff.limits.totalRepairRounds = [int]$Legacy.maxAttempts }
    foreach ($op in $OverridePaths) {
        $o = Read-RepairPolicyLayer $op
        $layer = if ($o.PSObject.Properties['layer']) { [string]$o.layer } else { 'override' }
        if ($layer -eq 'factory') { throw "Override $op may not claim the factory layer." }
        if ($o.PSObject.Properties['limits']) { foreach ($p in $o.limits.PSObject.Properties) {
            if ([int]$p.Value -gt $eff.limits[$p.Name]) { throw "Override $op loosens limits.$($p.Name) ($($p.Value) > $($eff.limits[$p.Name]))." }
            $eff.limits[$p.Name] = [int]$p.Value } }
        if ($o.PSObject.Properties['ceilings']) { foreach ($p in $o.ceilings.PSObject.Properties) {
            if ($null -eq $p.Value) { if ($null -ne $eff.ceilings[$p.Name]) { throw "Override $op removes the ceiling $($p.Name)." }; continue }
            if ($null -ne $eff.ceilings[$p.Name] -and [double]$p.Value -gt $eff.ceilings[$p.Name]) { throw "Override $op loosens ceilings.$($p.Name)." }
            $eff.ceilings[$p.Name] = [double]$p.Value } }
        if ($o.PSObject.Properties['governance']) { foreach ($p in $o.governance.PSObject.Properties) {
            $want = ($p.Name -ne 'allowIncompleteAsSuccess')
            if ($p.Value -ne $want) { throw "Override $op may not weaken governance.$($p.Name)." } } }
        if ($o.PSObject.Properties['independentDiagnosis'] -and $o.independentDiagnosis -eq $true -and -not $eff.independentDiagnosis) { throw "Override $op may not enable independent diagnosis." }
        $eff.layers += $layer
    }
    $canon = ($eff | ConvertTo-Json -Depth 6 -Compress)
    $eff.digest = ([BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canon))) -replace '-', '').ToLowerInvariant()
    return $eff
}

# Snapshot used when the caller supplies only the legacy retry.yaml policy: same bounds as before #740, no replans.
function Get-LegacyAuthorization([object]$Policy) {
    $eff = [ordered]@{ policyVersion = 0; limits = [ordered]@{ totalRepairRounds = [int]$Policy.maxAttempts; unchangedFindingPersistence = 2; consecutiveNoProgress = [int]::MaxValue; oscillationLimit = [int]::MaxValue; replanCap = 0; infraRetryBudget = [int]$Policy.maxAttempts }
        ceilings = [ordered]@{ maxSeconds = $null; maxTokens = $null; maxCostUsd = $null }
        governance = [ordered]@{ stopOnSafetyViolation = $true; stopOnSecurityIssue = $true; requireRequiredGates = $true; allowIncompleteAsSuccess = $false }
        independentDiagnosis = $false; layers = @('legacy') }
    $eff.digest = ([BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($eff | ConvertTo-Json -Depth 6 -Compress)))) -replace '-', '').ToLowerInvariant()
    return $eff
}

# ---- Atomic reservation ----------------------------------------------------------------------------------------
# In-memory reservation against the ledger: idempotent on $Key, never exceeds $Cap active reservations.
function Add-RepairReservation([object]$Ledger, [string]$Key, [string]$Kind, [int]$Cap, [int]$Round, [string]$Now) {
    Initialize-RepairLedger $Ledger
    $existing = @($Ledger.reservations | Where-Object { $_.key -eq $Key })
    if ($existing.Count) { return [pscustomobject]@{ granted = ($existing[0].state -ne 'cancelled'); replayed = $true; reservation = $existing[0] } }
    $active = @($Ledger.reservations | Where-Object { $_.state -ne 'cancelled' }).Count
    if ($active -ge $Cap) { return [pscustomobject]@{ granted = $false; replayed = $false; reservation = $null } }
    $r = [ordered]@{ key = $Key; kind = $Kind; state = 'reserved'; round = $Round; at = $Now }
    [void]$Ledger.reservations.Add($r)
    return [pscustomobject]@{ granted = $true; replayed = $false; reservation = $r }
}

function Set-RepairReservationState([object]$Ledger, [string]$Key, [ValidateSet('committed', 'cancelled')][string]$State, [string]$Now = ([DateTime]::UtcNow.ToString('o'))) {
    Initialize-RepairLedger $Ledger
    $r = @($Ledger.reservations | Where-Object { $_.key -eq $Key })
    if (-not $r.Count) { throw "No reservation $Key." }
    if ($r[0].state -eq 'cancelled' -and $State -eq 'committed') { throw "Reservation $Key was cancelled." }
    $r[0].state = $State; $r[0].updatedAt = $Now
}

# Runs $Action with the ledger file locked (exclusive open of <ledger>.lock), then writes the ledger atomically.
# $Action receives the ledger and returns a value; processes serialize on the lock, so reservations cannot overspend.
function Use-RepairLedgerLock([string]$LedgerPath, [object]$Policy, [scriptblock]$Action, [int]$TimeoutSeconds = 30) {
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($LedgerPath))) -Force | Out-Null
    $lockPath = "$LedgerPath.lock"; $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds); $fs = $null
    while ($null -eq $fs) {
        try { $fs = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { if ([DateTime]::UtcNow -gt $deadline) { throw "Timed out waiting for the repair ledger lock $lockPath." }; Start-Sleep -Milliseconds 25 }
    }
    try {
        $ledger = Read-RepairLedger $LedgerPath $Policy
        $result = & $Action $ledger
        $tmp = "$LedgerPath.$([guid]::NewGuid().ToString('N')).tmp"
        Set-Content -LiteralPath $tmp -Value ($ledger | ConvertTo-Json -Depth 10)
        Move-Item -LiteralPath $tmp -Destination $LedgerPath -Force
        return $result
    } finally { $fs.Dispose() }
}

function Get-RoundFailingSet([object]$Ledger, [int]$Round) {
    return @($Ledger.entries | Where-Object { [int]$_.round -eq $Round -and $_.fingerprint } | ForEach-Object { [string]$_.fingerprint } | Sort-Object -Unique)
}

function Get-RepairDigest([object]$Obj) {
    return ([BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 8 -Compress)))) -replace '-', '').ToLowerInvariant()
}

$script:StopRank = @{ safety_violation = 0; security_issue = 0; validator_error = 1; session_unavailable = 2; repeated_failures = 3; max_implementation_retries = 4; ceiling_exceeded = 4; oscillation = 5; no_progress = 6 }
$script:StopReasonCode = @{ safety_violation = 'governance_stop'; security_issue = 'governance_stop'; validator_error = 'validator_error'; session_unavailable = 'session_unavailable'; repeated_failures = 'repeated_finding'; max_implementation_retries = 'global_budget_exhausted'; ceiling_exceeded = 'global_budget_exhausted'; oscillation = 'oscillation'; no_progress = 'no_progress' }

# True when the failing set moved forward: something previously failing is gone, or fewer findings remain.
function Test-RepairProgress([string[]]$Previous, [string[]]$Current) {
    if ($Current.Count -eq 0) { return $true }
    if ($Current.Count -lt $Previous.Count) { return $true }
    foreach ($p in $Previous) { if ($p -notin $Current) { return $true } }
    return $false
}

# One decision round. $Checks: {checkId,status,message,output,commitSha,history,flaky,safetyViolation,securityIssue,
# incomplete,validatorError,relevantChange}. Mutates $Ledger (resolves pending outcomes, appends entries, reservations and
# one immutable receipt). Pure otherwise: no network, no git. Callers that share a ledger file wrap the call in
# Use-RepairLedgerLock. $Authorization is the effective layered snapshot (Get-RepairAuthorizationPolicy); without it the
# legacy retry.yaml bounds apply. $Progress is the optional progress-evaluator contract {state: progress|none|unknown};
# missing or unknown counts as no progress (never extra budget).
function Invoke-RepairDecision([object[]]$Checks, [object]$Ledger, [object]$Policy, [double]$AttemptSeconds = 0, [string]$Now = ([DateTime]::UtcNow.ToString('o')),
    [object]$Authorization = $null, [string]$IdempotencyKey = '', [bool]$SessionAvailable = $true, [object]$Progress = $null, [double]$AttemptTokens = 0, [double]$AttemptUsd = 0) {
    Initialize-RepairLedger $Ledger
    if ($null -eq $Authorization) { $Authorization = Get-LegacyAuthorization $Policy }
    $lim = $Authorization.limits
    $round = 1; foreach ($e in $Ledger.entries) { if ([int]$e.round -ge $round) { $round = [int]$e.round + 1 } }
    if (-not $IdempotencyKey) { $IdempotencyKey = "round-$round" }
    $prev = @($Ledger.receipts | Where-Object { $_.idempotencyKey -eq $IdempotencyKey })
    if ($prev.Count) {
        $d = [ordered]@{}; foreach ($pp in $prev[0].decision.PSObject.Properties) { $d[$pp.Name] = $pp.Value }
        $d.receipt = $prev[0]; $d.replayed = $true
        return $d
    }
    $failing = @(); $perCheck = @(); $stops = [System.Collections.ArrayList]::new()
    foreach ($c in @($Checks | ForEach-Object { ConvertTo-RepairCheck $_ })) {
        $class = Get-FailureClass $c
        $fp = if ($class -eq 'pass') { '' } else { Get-FailureFingerprint $c }
        foreach ($e in @($Ledger.entries | Where-Object { $_.checkId -eq $c.checkId -and $_.outcome -eq 'pending' })) {
            $e.outcome = if ($class -eq 'pass') { 'fixed' } else { 'still-failing' }
        }
        if ($c.validatorError -eq $true) { [void]$stops.Add('validator_error') }
        if ($class -eq 'pass') { continue }
        $failing += [pscustomobject]@{ check = $c; class = $class; fingerprint = $fp }
    }
    $cap = [int]$lim.totalRepairRounds
    $budget = Get-RepairBudget $Ledger $Policy
    $remaining = [Math]::Max(0, $cap - $budget.attemptsUsed)
    $replansLeft = [Math]::Max(0, [int]$lim.replanCap - $budget.replansUsed)
    $wantsReplan = $false
    foreach ($f in $failing) {
        $c = $f.check
        $prior = @($Ledger.entries | Where-Object { $_.checkId -eq $c.checkId })
        $priorRepairs = @($prior | Where-Object { $_.action -in 'repair', 'repair-batched', 'replan' })
        $action = 'none'; $reason = ''; $backoff = 0
        if ($c.safetyViolation -eq $true -and $Authorization.governance.stopOnSafetyViolation) { [void]$stops.Add('safety_violation') }
        if ($c.securityIssue -eq $true -and $Authorization.governance.stopOnSecurityIssue) { [void]$stops.Add('security_issue') }
        $sameRepeats = @(if ($c.relevantChange -eq $true) { @() } else { @($priorRepairs | Where-Object { $_.fingerprint -eq $f.fingerprint -and $_.outcome -eq 'still-failing' }) })
        if ('repeated_failures' -in $Policy.stopOn -and $sameRepeats.Count -ge [int]$lim.unchangedFindingPersistence) { [void]$stops.Add('repeated_failures') }
        switch ($f.class) {
            'untested' { $action = 'none'; $reason = $(if ($c.incomplete) { 'incomplete: reported incomplete; never treated as success' } else { 'untested: no repair attempted; the gap stays visible' }) }
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
                if ($remaining -le 0) { [void]$stops.Add('max_implementation_retries'); $action = 'none' }
                else {
                    $action = 'repair'; $reason = 'code defect: targeted repair attempt'
                    if ($sameRepeats.Count -ge 1 -and $replansLeft -gt 0) { $wantsReplan = $true; $reason = 'code defect: repair did not change the finding; in-session replan' }
                }
            }
        }
        $perCheck += [pscustomobject]@{ checkId = [string]$c.checkId; class = $f.class; action = $action; reason = $reason; backoffSeconds = $backoff; fingerprint = $f.fingerprint; message = [string]$c.message; output = [string]$c.output }
    }
    $wantsRepair = [bool]@($perCheck | Where-Object { $_.action -eq 'repair' }).Count
    # Progress, oscillation and cost bounds guard further repair authorization.
    $current = @($failing | ForEach-Object { $_.fingerprint } | Sort-Object -Unique)
    $roundNums = @($Ledger.entries | ForEach-Object { [int]$_.round } | Sort-Object -Unique)
    $sets = @(); foreach ($rn in $roundNums) { $sets += , @(Get-RoundFailingSet $Ledger $rn) }
    $sets += , $current
    $noProgress = 0; $oscillations = 0; $progressState = 'initial'
    for ($i = 1; $i -lt $sets.Count; $i++) {
        $isCur = ($i -eq $sets.Count - 1)
        $moved = Test-RepairProgress @($sets[$i - 1]) @($sets[$i])
        if ($isCur -and $null -ne $Progress -and $Progress.PSObject.Properties['state']) { $moved = ([string]$Progress.state -eq 'progress') }
        $noProgress = if ($moved) { 0 } else { $noProgress + 1 }
        if ($isCur) { $progressState = if ($moved) { 'progress' } else { 'none' } }
        if ($i -ge 2 -and $sets[$i].Count -gt 0 -and ($sets[$i] -join ',') -eq ($sets[$i - 2] -join ',') -and ($sets[$i] -join ',') -ne ($sets[$i - 1] -join ',')) { $oscillations++ }
    }
    if ($wantsRepair) {
        if (-not $SessionAvailable) { [void]$stops.Add('session_unavailable') }
        if ($noProgress -ge [int]$lim.consecutiveNoProgress) { [void]$stops.Add('no_progress') }
        if ($oscillations -ge [int]$lim.oscillationLimit) { [void]$stops.Add('oscillation') }
        $ce = $Authorization.ceilings
        foreach ($pair in @(@($ce.maxSeconds, $budget.costSecondsTotal, $AttemptSeconds), @($ce.maxTokens, $budget.costTokensTotal, $AttemptTokens), @($ce.maxCostUsd, $budget.costUsdTotal, $AttemptUsd))) {
            if ($null -ne $pair[0] -and ($pair[1] -ge [double]$pair[0] -or ($pair[1] + $pair[2]) -gt [double]$pair[0])) { [void]$stops.Add('ceiling_exceeded') }
        }
    }
    $stop = $null
    if ($stops.Count) { $stop = @($stops | Sort-Object { $script:StopRank[$_] })[0] }
    # Reserve the attempt atomically (idempotent on the key); a denied reservation is an exhausted budget.
    $kind = if ($wantsReplan) { 'replan' } else { 'repair' }
    if (-not $stop -and $wantsRepair) {
        $res = Add-RepairReservation $Ledger $IdempotencyKey $kind $cap $round $Now
        if (-not $res.granted) { $stop = 'max_implementation_retries' }
    }
    if ($stop) { foreach ($p in $perCheck) { if ($p.action -in 'repair', 'retry', 'backoff') { $p.action = 'stopped'; $p.reason = "stopped: $stop" } } }
    $repairs = @($perCheck | Where-Object { $_.action -eq 'repair' })
    $action = if ($stop) { 'stop' } elseif ($repairs.Count) { $(if ($wantsReplan) { 'replan' } else { 'repair' }) } elseif (@($perCheck | Where-Object { $_.action -eq 'retry' }).Count) { 'retry' } elseif (@($perCheck | Where-Object { $_.action -eq 'backoff' }).Count) { 'backoff' } elseif ($perCheck.Count) { 'handoff' } else { 'done' }
    $first = $true
    foreach ($p in $perCheck) {
        $charged = ($p.action -eq 'repair' -and $first)
        if ($p.action -eq 'repair') { $first = $false }
        $entry = [ordered]@{
            round = $round; at = $Now; checkId = $p.checkId; class = $p.class; action = $p.action; fingerprint = $p.fingerprint
            outcome = if (@('repair', 'retry', 'backoff') -contains $p.action) { 'pending' } else { 'not-attempted' }
            costSeconds = if ($charged) { $AttemptSeconds } else { 0 }; costTokens = if ($charged) { $AttemptTokens } else { 0 }; costUsd = if ($charged) { $AttemptUsd } else { 0 }
            stopReason = [string]$stop
        }
        if ($p.action -eq 'repair' -and -not $charged) { $entry.action = 'repair-batched' }
        elseif ($charged -and $action -eq 'replan') { $entry.action = 'replan' }
        [void]$Ledger.entries.Add($entry)
    }
    $maxBackoff = 0; foreach ($p in $perCheck) { if ($p.backoffSeconds -gt $maxBackoff) { $maxBackoff = $p.backoffSeconds } }
    $impacted = @($perCheck | Where-Object { $_.action -in 'repair', 'retry' } | ForEach-Object { $_.checkId })
    $records = @($perCheck | ForEach-Object { [pscustomobject]@{ findingId = $_.fingerprint; identifier = $_.checkId; message = $_.message; detailPath = ''; occurrence = 1 } })
    $handoff = @()
    if ($action -in 'stop', 'handoff') { $handoff = @($perCheck | Where-Object { $_.action -notin 'retry', 'backoff' }) }
    elseif ($action -in 'retry', 'backoff') { $handoff = @($perCheck | Where-Object { $_.action -eq 'investigate' }) }

    $reasonCode = switch ($action) {
        'done' { 'passed' } 'handoff' { 'incomplete_reported' } 'stop' { $script:StopReasonCode[$stop] }
        'repair' { 'repair_authorized' } 'replan' { 'replan_authorized' } 'retry' { 'retry_authorized' } 'backoff' { 'backoff_authorized' }
    }
    if ($reasonCode -eq 'passed' -and $perCheck.Count) { throw 'Invariant: a round with unresolved checks cannot be reported passed.' }
    $strategy = switch ($action) { 'repair' { 'focused-repair' } 'replan' { 'in-session-replan' } { $_ -in 'retry', 'backoff' } { 'infrastructure-retry' } { $_ -in 'stop', 'handoff' } { 'stop-escalate' } default { 'none' } }
    $terminal = $action -in 'stop', 'handoff', 'done'
    $outcome = switch ($action) { 'done' { 'success' } 'stop' { 'stopped' } 'handoff' { 'incomplete' } default { 'continuing' } }
    $budgetNow = Get-RepairBudget $Ledger $Policy
    $budgetNow.maxAttempts = $cap; $budgetNow.attemptsRemaining = [Math]::Max(0, $cap - $budgetNow.attemptsUsed)
    $checksOut = @($perCheck | ForEach-Object { [ordered]@{ checkId = $_.checkId; class = $_.class; action = $_.action; reason = $_.reason } })
    $receipt = [ordered]@{
        schemaVersion = 1; receiptId = "rcpt-$IdempotencyKey"; idempotencyKey = $IdempotencyKey; evaluatedAt = $Now; round = $round
        action = $action; strategy = $strategy; reasonCode = $reasonCode; terminal = $terminal; outcome = $outcome
        detail = $(if ($stop) { $stop } elseif ($perCheck.Count) { [string]$perCheck[0].reason } else { 'all checks passed' })
        policy = [ordered]@{ policyVersion = [int]$Authorization.policyVersion; digest = [string]$Authorization.digest; effective = $Authorization }
        counters = [ordered]@{ attemptsUsed = $budgetNow.attemptsUsed; attemptsRemaining = $budgetNow.attemptsRemaining; replansUsed = $budgetNow.replansUsed; infrastructureRetriesUsed = $budgetNow.infrastructureRetriesUsed; validationRounds = $budgetNow.validationRounds; consecutiveNoProgress = $noProgress; oscillations = $oscillations; progress = $progressState }
        decision = [ordered]@{ schemaVersion = 1; action = $action; round = $round; stopReason = [string]$stop; impactedChecks = $impacted; backoffSeconds = [int]$maxBackoff; checks = $checksOut; outcome = $outcome; reasonCode = $reasonCode }
    }
    $receipt.digest = Get-RepairDigest $receipt
    [void]$Ledger.receipts.Add($receipt)
    return [ordered]@{
        schemaVersion = 1; action = $action; round = $round; stopReason = [string]$stop
        reasonCode = $reasonCode; strategy = $strategy; outcome = $outcome; terminal = $terminal
        impactedChecks = $impacted
        backoffSeconds = [int]$maxBackoff
        checks = $checksOut
        summary = $(if ($records.Count) { New-FailureSummary -Records $records } else { [ordered]@{ schemaVersion = 1; totalFindings = 0; totalOccurrences = 0; truncated = $false; omittedEntries = 0; omittedOccurrences = 0; entries = @() } })
        budget = $budgetNow
        receipt = $receipt
        handoff = [ordered]@{
            target = 'failure-audit-publication'; createsIssue = $false; waiver = $false
            findings = @($handoff | ForEach-Object { [ordered]@{ findingId = $_.fingerprint; identifier = $_.checkId; class = $_.class; reason = $_.reason; message = (Protect-FailureText $_.message 200); occurrence = 1 } })
        }
    }
}
