# GitHub workflow projection (issue #767, parent #761). Dot-source this file. Pure and deterministic:
# it takes events, observed GitHub state, a ledger and an API status, and returns signals, a projection
# plan, drift/UNKNOWN evidence and migration receipts. It performs no GitHub writes (the lifecycle
# reconciler publishes the plan), so it is safe to replay. Policy: policies/workflow-projection.json.

$script:ProjectionSchema = 'factory-workflow-projection/v1'

function Get-WorkflowProjectionPolicy {
    param([string]$Path = (Join-Path $PSScriptRoot '../policies/workflow-projection.json'))
    $p = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    if ($p['schemaVersion'] -ne $script:ProjectionSchema) { throw "unsupported workflow projection schemaVersion '$($p['schemaVersion'])'" }
    $p
}

function Get-ProjectionIdempotencyKey([int]$Issue, [string]$State, [int]$Revision) {
    $bytes = [Text.Encoding]::UTF8.GetBytes("$Issue|$State|$Revision")
    -join ([Security.Cryptography.SHA256]::HashData($bytes) | ForEach-Object { $_.ToString('x2') })
}

function New-ProjectionLedger {
    # watermark: events at or before it are history and never admit work (no replay on enable).
    param([Parameter(Mandatory)][string]$Watermark)
    @{ schemaVersion = $script:ProjectionSchema; watermark = $Watermark; seen = @{}; published = @{}; queued = @{}; records = @() }
}

function Test-FactoryAuthoredEvent($Event, [hashtable]$Policy) {
    # A label change Factory itself projected must never re-enter as an inbound signal (ping-pong guard).
    if ($Event.actor -and $Event.actor -in $Policy.factoryActors) { return $true }
    if ($Event.body -and ([string]$Event.body).Contains($Policy.projectionMarker)) { return $true }
    $false
}

function ConvertTo-WorkflowSignals {
    # Dedupe by eventId, drop history at/below the watermark and Factory-authored events, order by
    # (timestamp, eventId) so duplicated, reordered and re-delivered input converges to the same list.
    param([object[]]$Events, [hashtable]$Policy, [hashtable]$Ledger)
    $out = @()
    $local = @{}
    foreach ($e in ($Events | Sort-Object { [datetime]$_.timestamp }, { [string]$_.eventId })) {
        $id = [string]$e.eventId
        if ($Ledger.seen.ContainsKey($id) -or $local.ContainsKey($id)) { continue }
        $local[$id] = $true
        if ([datetime]$e.timestamp -le [datetime]$Ledger.watermark) { continue }
        if (Test-FactoryAuthoredEvent $e $Policy) { continue }
        $out += [pscustomobject]@{ schemaVersion = $script:ProjectionSchema; kind = 'signal'; issue = [int]$e.issue; signalType = [string]$e.type; eventId = $id; label = [string]$e.label; actor = [string]$e.actor; timestamp = [string]$e.timestamp }
    }
    $out
}

function Test-ApprovalCondition {
    # Approval is satisfied only by real GitHub review state on the current head. Labels (including
    # approval-looking ones) and OCR/automated clean reviews are ignored. $null review state is UNKNOWN.
    param($PullRequest)
    if ($null -eq $PullRequest -or $null -eq $PullRequest.reviews) { return @{ satisfied = $false; status = 'unknown'; reason = 'approval_unverified' } }
    $latest = @{}
    foreach ($r in ($PullRequest.reviews | Sort-Object { [datetime]$_.submittedAt })) {
        if ($r.authorAssociation -notin 'OWNER', 'MEMBER', 'COLLABORATOR') { continue }
        if ($r.isBot) { continue }
        if ($r.commit -and $PullRequest.headSha -and $r.commit -ne $PullRequest.headSha -and $r.state -eq 'APPROVED') { continue }
        $latest[[string]$r.author] = [string]$r.state
    }
    $approved = @($latest.Values | Where-Object { $_ -eq 'APPROVED' }).Count -gt 0
    $blocked = @($latest.Values | Where-Object { $_ -eq 'CHANGES_REQUESTED' }).Count -gt 0
    $ok = $approved -and -not $blocked -and $PullRequest.mergeable -ne 'CONFLICTING' -and $PullRequest.protectionsSatisfied -ne $false
    @{ satisfied = [bool]$ok; status = $(if ($ok) { 'satisfied' } else { 'not-satisfied' }); reason = '' }
}

function Get-ProjectedState {
    param([string[]]$Labels, [hashtable]$Policy)
    $states = @($Labels | Where-Object { $Policy.labelToState.ContainsKey($_) })
    $states
}

function Compare-ProjectionDrift {
    # Both directions: observed labels versus the label Factory last projected / wants projected.
    param([int]$Issue, [string]$DesiredState, [string[]]$ObservedLabels, [hashtable]$Policy, [hashtable]$Ledger)
    $desiredLabel = ($Policy.labelToState.GetEnumerator() | Where-Object { $_.Value -eq $DesiredState } | Select-Object -First 1).Key
    $present = @($ObservedLabels | Where-Object { $Policy.labelToState.ContainsKey($_) })
    $records = @()
    if ($present.Count -gt 1) {
        $records += [pscustomobject]@{ kind = 'drift'; issue = $Issue; reason = 'duplicate_label'; evidence = "labels: $($present -join ',')"; resolution = 'reprojected' }
    } elseif ($present.Count -eq 0) {
        $records += [pscustomobject]@{ kind = 'drift'; issue = $Issue; reason = 'label_missing'; evidence = "expected $desiredLabel"; resolution = 'reprojected' }
    } elseif ($present[0] -ne $desiredLabel) {
        $obsState = $Policy.labelToState[$present[0]]
        $res = if ($obsState -in $Policy.humanOwnedStates -or $DesiredState -in $Policy.humanOwnedStates) { 'accepted' } else { 'reprojected' }
        $reason = if ($res -eq 'accepted') { 'accepted_human_edit' } else { 'manual_label_edit' }
        $records += [pscustomobject]@{ kind = 'drift'; issue = $Issue; reason = $reason; evidence = "observed $($present[0]) desired $desiredLabel"; resolution = $res }
    }
    $records | ForEach-Object { $_ | Add-Member schemaVersion $script:ProjectionSchema -PassThru }
}

function New-ProjectionPlan {
    # Idempotent publish plan for one issue. Factory run state is authoritative: execution never waits
    # on this result. Outage/restricted write yields queued/waiting UNKNOWN evidence, not a failure.
    param([int]$Issue, [string]$State, [int]$Revision, [string[]]$ObservedLabels, [ValidateSet('ok', 'outage', 'restricted')][string]$Api, [hashtable]$Policy, [hashtable]$Ledger)
    $key = Get-ProjectionIdempotencyKey $Issue $State $Revision
    $label = ($Policy.labelToState.GetEnumerator() | Where-Object { $_.Value -eq $State } | Select-Object -First 1).Key
    if (-not $label) { throw "no label mapping for workflow state '$State'" }
    $drift = @(Compare-ProjectionDrift $Issue $State $ObservedLabels $Policy $Ledger)
    $accepted = @($drift | Where-Object { $_.resolution -eq 'accepted' })
    $pub = $Ledger.published["$Issue"]
    $converged = ($ObservedLabels -contains $label) -and @($ObservedLabels | Where-Object { $Policy.labelToState.ContainsKey($_) }).Count -eq 1
    $status = 'published'; $reason = ''; $evidence = ''
    if ($accepted.Count) {
        $status = 'waiting'; $reason = 'accepted_human_edit'; $evidence = 'human-owned state edit accepted as a signal; not overwritten'
    } elseif ($converged -and $pub -and $pub.key -eq $key) {
        $status = 'noop'
    } elseif ($Api -eq 'outage') {
        $status = 'queued'; $reason = 'api_outage'; $evidence = $Policy.unknownReasons.api_outage
    } elseif ($Api -eq 'restricted') {
        $status = 'waiting'; $reason = 'restricted_write'; $evidence = $Policy.unknownReasons.restricted_write
    }
    [pscustomobject]@{
        schemaVersion = $script:ProjectionSchema; kind = 'projection'; issue = $Issue; state = $State; idempotencyKey = $key
        status = $status; reason = $reason; evidence = $evidence; addLabel = $label
        removeLabels = @($ObservedLabels | Where-Object { $Policy.labelToState.ContainsKey($_) -and $_ -ne $label })
        marker = "$($Policy.projectionMarker)$key -->"; drift = $drift
    }
}

function Invoke-ProjectionReconcile {
    # One level-triggered pass. Returns the plans and the next ledger; calling it again with the same
    # input yields only 'noop' plans, which is what makes missed, duplicated and reordered events converge.
    param([object[]]$Events, [object[]]$Issues, [string]$Api, [hashtable]$Policy, [hashtable]$Ledger)
    $signals = @(ConvertTo-WorkflowSignals $Events $Policy $Ledger)
    $next = @{ schemaVersion = $Ledger.schemaVersion; watermark = $Ledger.watermark; seen = $Ledger.seen.Clone(); published = $Ledger.published.Clone(); queued = $Ledger.queued.Clone(); records = @($Ledger.records) }
    foreach ($s in $signals) { $next.seen[$s.eventId] = $true }
    $plans = @()
    foreach ($i in ($Issues | Sort-Object issue)) {
        $plan = New-ProjectionPlan $i.issue $i.state $i.revision @($i.labels) $Api $Policy $Ledger
        $plans += $plan
        $next.records += @($plan.drift)
        if ($plan.status -eq 'published') { $next.published["$($i.issue)"] = @{ key = $plan.idempotencyKey; label = $plan.addLabel }; $next.queued.Remove("$($i.issue)") }
        elseif ($plan.status -in 'queued', 'waiting') { $next.queued["$($i.issue)"] = @{ key = $plan.idempotencyKey; reason = $plan.reason } }
    }
    @{ signals = $signals; plans = $plans; ledger = $next }
}

function Get-WebhookLossRecord {
    param([int]$Issue, [datetime]$LastEventAt, [datetime]$Now, [hashtable]$Policy)
    if (($Now - $LastEventAt).TotalSeconds -le $Policy.staleEventSeconds) { return $null }
    [pscustomobject]@{ schemaVersion = $script:ProjectionSchema; kind = 'drift'; issue = $Issue; status = 'unknown'; reason = 'webhook_loss'; evidence = $Policy.unknownReasons.webhook_loss; resolution = 'waiting' }
}

function New-MigrationReceipts {
    # Maps existing factory:* lifecycle labels to workflow states per the versioned table. Admission is
    # always 'none': enabling projection records a baseline and never replays historical jobs.
    param([object[]]$Issues, [hashtable]$Policy, [string]$Watermark)
    foreach ($i in ($Issues | Sort-Object issue)) {
        $hits = @($i.labels | Where-Object { $Policy.labelToState.ContainsKey($_) })
        $state = if ($hits.Count -eq 1) { $Policy.labelToState[$hits[0]] } else { 'unknown' }
        [pscustomobject]@{ schemaVersion = $script:ProjectionSchema; kind = 'migration-receipt'; issue = [int]$i.issue; state = $state; mappingVersion = $Policy.mappingVersion; watermark = $Watermark; admission = 'none'; evidence = "labels: $($hits -join ',')" }
    }
}
