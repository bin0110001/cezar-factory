#!/usr/bin/env pwsh
# Documentation status read model and guarded actions (issue #180, epic #174).
#
# Dot-source this file; it defines functions only and has no side effects. The Factory UI (issue/run
# panel, project summary, diff/impact preview) renders the objects these functions return. It does not
# recompute freshness or convergence: it reads `factory-doc-state/v1` records (schemas/documentation-state)
# and only classifies them for display. See docs/documentation-status.md.
#
#   . ./scripts/documentation-status.ps1
#   $view = ConvertTo-DocumentationStatusView -Records $records -Target @{ branch = 'main'; sha = $sha }
#   $result = Invoke-DocumentationAction -Action approve -DocumentId $id -Actor 'a' -Permissions $perms `
#       -IdempotencyKey 'k1' -ExpectedSha $sha -Records $records -Ledger $ledger
#
# Invariants:
#   * Only a record that is `verified`, fresh, verifier-backed, with every claim verified, and observed
#     at the target SHA is labelled "Code verified". A proposed-only record is never labelled implemented.
#   * Stale, unknown and unsupported-version records are shown as such, never promoted.
#   * Actions are deny-by-default, idempotent per key, compare-and-set on the observed SHA, and every
#     attempt (including denied ones) is appended to the ledger. A missing backend/MCP returns
#     `unavailable` and never throws or blocks unrelated work.

$script:DocStatusSupportedVersion = 'factory-doc-state/v1'
$script:DocStatusPendingStates = @('proposed', 'approved', 'implemented')

function Get-DocProp($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] } else { return $null } }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { $p.Value } else { $null }
}

function Get-DocStatusLabel([string]$DisplayState, [string]$State) {
    switch ($DisplayState) {
        'verified' { 'Code verified' }
        'proposed' { 'Design proposed (not implemented)' }
        'approved' { 'Design approved (not implemented or verified)' }
        'implemented' { 'Implemented (not verified)' }
        'superseded' { 'Superseded' }
        'stale' { "Stale (last recorded state: $State)" }
        default { 'Unknown' }
    }
}

# Classify one record for display. `$Target` may carry `sha`; without it the record cannot be shown as
# verified for a target, only as what it claims.
function ConvertTo-DocumentationItem($Record, $Target) {
    $id = [string](Get-DocProp $Record 'documentId')
    $version = [string](Get-DocProp $Record 'schemaVersion')
    if ($version -ne $script:DocStatusSupportedVersion) {
        return [ordered]@{
            documentId = $id; title = [string](Get-DocProp $Record 'title'); kind = ''; recordedState = ''
            displayState = 'unknown'; label = 'Unknown (unsupported record version, preserved unchanged)'
            codeVerified = $false; designProposed = $false; matchesTarget = $null; sourceSha = ''; groundedSha = ''
            reasons = @("unsupported schemaVersion '$version'"); claims = @(); sourceFiles = @(); evidence = @()
        }
    }
    $state = [string](Get-DocProp $Record 'state')
    $revision = Get-DocProp $Record 'revision'
    $observed = [string](Get-DocProp $revision 'observedSha')
    $freshness = Get-DocProp $Record 'freshness'
    $freshStatus = [string](Get-DocProp $freshness 'status')
    $grounded = [string](Get-DocProp $freshness 'checkedAgainstSha')
    $verification = Get-DocProp $Record 'verification'
    $claims = @(Get-DocProp $Record 'claims')
    $targetSha = [string](Get-DocProp $Target 'sha')
    $reasons = New-Object System.Collections.Generic.List[string]

    $matches = $null
    if ($targetSha) { $matches = ($observed -ceq $targetSha) }
    $isFresh = ($freshStatus -eq 'fresh' -and $grounded -and $grounded -ceq $observed)
    $allVerified = ($claims.Count -gt 0) -and (@($claims | Where-Object { (Get-DocProp $_ 'knowledge') -ne 'verified' -or (Get-DocProp $_ 'speculative') }).Count -eq 0)
    $hasVerifier = ((Get-DocProp $verification 'status') -eq 'verified') -and [bool](Get-DocProp $verification 'verifier') -and (@(Get-DocProp $verification 'evidence').Count -gt 0)

    $display = $state
    if ($state -eq 'superseded') { $display = 'superseded' }
    elseif ($freshStatus -eq 'stale' -or ($grounded -and $grounded -cne $observed)) { $display = 'stale'; $reasons.Add('evidence was checked against a different SHA than the observed source') }
    elseif ($state -in @('implemented', 'verified') -and $freshStatus -ne 'fresh') { $display = 'unknown'; $reasons.Add('no comparable freshness evidence') }
    elseif ($state -eq 'verified') {
        if (-not ($allVerified -and $hasVerifier)) { $display = 'implemented'; $reasons.Add('verification evidence incomplete; not shown as verified') }
        elseif ($targetSha -and -not $matches) { $display = 'stale'; $reasons.Add("source SHA differs from the target SHA $targetSha") }
        elseif (-not $targetSha) { $reasons.Add('no target SHA supplied; verification applies only to the observed SHA') }
    }
    elseif ($state -notin @('proposed', 'approved', 'implemented')) { $display = 'unknown'; $reasons.Add("unrecognised state '$state'") }
    if ($targetSha -and $matches -eq $false -and $display -notin @('stale', 'superseded')) { $reasons.Add("describes SHA $observed, not target $targetSha") }

    $codeVerified = ($display -eq 'verified') -and $isFresh -and ($matches -ne $false)
    if ($display -eq 'verified' -and -not $codeVerified) { $display = 'unknown' }

    $claimViews = @($claims | ForEach-Object {
        $spec = [bool](Get-DocProp $_ 'speculative')
        [ordered]@{ id = [string](Get-DocProp $_ 'id'); text = [string](Get-DocProp $_ 'text'); knowledge = [string](Get-DocProp $_ 'knowledge'); speculative = $spec
                    label = $(if ((Get-DocProp $_ 'knowledge') -eq 'verified' -and -not $spec -and $codeVerified) { 'Code verified' } else { 'Design proposed' })
                    sourceFiles = @(@(Get-DocProp $_ 'sourceAnchors') | ForEach-Object { [string](Get-DocProp $_ 'path') } | Where-Object { $_ }) }
    })
    $sources = @(@(Get-DocProp $revision 'sourceAnchors') | ForEach-Object { [string](Get-DocProp $_ 'path') } | Where-Object { $_ } | Sort-Object -Unique)
    [ordered]@{
        documentId = $id; title = [string](Get-DocProp $Record 'title'); kind = [string](Get-DocProp $Record 'kind'); recordedState = $state
        displayState = $display; label = (Get-DocStatusLabel $display $state)
        codeVerified = $codeVerified; designProposed = ($display -in @('proposed', 'approved') -or @($claimViews | Where-Object { $_.speculative }).Count -gt 0)
        matchesTarget = $matches; branch = [string](Get-DocProp $revision 'branch'); sourceSha = $observed; groundedSha = $grounded
        reasons = @($reasons); claims = $claimViews; sourceFiles = $sources
        evidence = @(@(Get-DocProp $verification 'evidence') | Where-Object { $_ })
        transitionedBy = [string](Get-DocProp $Record 'transitionedBy'); transitionedAt = [string](Get-DocProp $Record 'transitionedAt')
    }
}

# Build the whole view. `$Backend` is @{ available = bool; mcp = 'connected'|'missing'|'error'; indexEnabled = bool }.
# `$Operations` optionally carries read-model values owned by the backend (lastSuccess, lastFailure, costUsd,
# queue, repairJobs, refreshJobs); they are passed through, never computed here.
function ConvertTo-DocumentationStatusView {
    param($Records, $Target = @{}, $Backend = @{ available = $true; mcp = 'connected'; indexEnabled = $true }, $Operations = @{})
    $available = [bool](Get-DocProp $Backend 'available')
    $mcp = [string](Get-DocProp $Backend 'mcp')
    $indexEnabled = if ($null -eq (Get-DocProp $Backend 'indexEnabled')) { $true } else { [bool](Get-DocProp $Backend 'indexEnabled') }
    $view = [ordered]@{ schemaVersion = 1; target = [ordered]@{ branch = [string](Get-DocProp $Target 'branch'); sha = [string](Get-DocProp $Target 'sha') } }
    $banner = @()
    if (-not $indexEnabled) { $panel = 'index-disabled'; $banner += 'Documentation index is disabled for this project.' }
    elseif (-not $available) { $panel = 'unavailable'; $banner += 'Documentation backend is unavailable; unrelated coding work is not blocked.' }
    elseif ($mcp -in @('missing', 'error')) { $panel = 'degraded'; $banner += "MCP connection is $mcp; showing recorded state only." }
    else { $panel = 'ready' }
    $items = @()
    if ($panel -in @('ready', 'degraded')) { $items = @(@($Records) | Where-Object { $null -ne $_ } | ForEach-Object { ConvertTo-DocumentationItem $_ $Target } | Sort-Object { $_.documentId }) }
    if ($panel -eq 'ready' -and $items.Count -eq 0) { $panel = 'empty'; $banner += 'No documentation records for this issue or project.' }
    $view.panelState = $panel; $view.banners = $banner
    $view.documents = $items
    $claimTotal = 0; $claimVerified = 0
    foreach ($i in $items) { foreach ($c in $i.claims) { $claimTotal++; if ($c.label -eq 'Code verified') { $claimVerified++ } } }
    $by = [ordered]@{}
    foreach ($s in 'proposed', 'approved', 'implemented', 'verified', 'stale', 'unknown', 'superseded') { $by[$s] = @($items | Where-Object { $_.displayState -eq $s }).Count }
    $view.summary = [ordered]@{
        total = $items.Count; byDisplayState = $by
        staleCount = $by.stale; unknownCount = $by.unknown
        pendingCount = @($items | Where-Object { $_.displayState -in $script:DocStatusPendingStates }).Count
        verificationCoverage = $(if ($claimTotal) { [math]::Round($claimVerified / $claimTotal, 4) } else { $null })
        claimsVerified = $claimVerified; claimsTotal = $claimTotal
        indexFreshness = $(if ($items.Count) { if ($by.stale -eq 0 -and $by.unknown -eq 0) { 'fresh' } else { 'stale' } } else { 'unknown' })
        lastSuccess = Get-DocProp $Operations 'lastSuccess'; lastFailure = Get-DocProp $Operations 'lastFailure'
        costUsd = Get-DocProp $Operations 'costUsd'; queue = Get-DocProp $Operations 'queue'
    }
    $view.links = [ordered]@{
        refreshJobs = @(Get-DocProp $Operations 'refreshJobs'); repairJobs = @(Get-DocProp $Operations 'repairJobs')
        reuse = [ordered]@{ runExplorer = '#135'; mcpStatus = '#171'; langfuse = '#129'; graph = '#151'; decisions = '#152' }
    }
    $view
}

# Impact preview: which sections/source files changed between two renderings, kept honest about confidence.
function Get-DocumentationImpact {
    param($Before, $After, [string]$Confidence = 'unknown', [string[]]$Unknowns = @())
    $b = @{}; foreach ($d in @($Before)) { $b[$d.documentId] = $d }
    $changes = @(); foreach ($d in @($After)) {
        $old = $b[$d.documentId]
        if ($null -eq $old -or $old.displayState -ne $d.displayState -or $old.sourceSha -cne $d.sourceSha) {
            $changes += [ordered]@{ documentId = $d.documentId; from = $(if ($old) { $old.displayState } else { 'absent' }); to = $d.displayState
                                    sourceFiles = $d.sourceFiles; note = $(if ($d.codeVerified) { 'code verified' } else { 'design only; not verified against code' }) }
        }
    }
    [ordered]@{ changes = $changes; confidence = $Confidence; unknowns = $Unknowns }
}

function New-DocumentationLedger { @{ entries = (New-Object System.Collections.ArrayList); byKey = @{} } }

# Guarded actions. Returns @{ status = accepted|duplicate|denied|conflict|unavailable|invalid; ... }.
function Invoke-DocumentationAction {
    param(
        [Parameter(Mandatory)][ValidateSet('refresh', 'retry', 'approve', 'override')][string]$Action,
        [Parameter(Mandatory)][string]$DocumentId,
        [string]$Actor = '', [string[]]$Permissions = @(), [string]$IdempotencyKey = '',
        [string]$ExpectedSha = '', $Records = @(), $Backend = @{ available = $true; mcp = 'connected'; indexEnabled = $true },
        [string]$Reason = '', [string]$ReviewBy = '', [hashtable]$Ledger = (New-DocumentationLedger), [string]$Now = ''
    )
    if (-not $Now) { $Now = [DateTime]::UtcNow.ToString('o') }
    $fingerprint = "$Action|$DocumentId|$Actor|$ExpectedSha|$Reason|$ReviewBy"
    $record = @(@($Records) | Where-Object { (Get-DocProp $_ 'documentId') -ceq $DocumentId }) | Select-Object -First 1
    $requiredPermission = switch ($Action) { 'approve' { 'docs:approve' } 'override' { 'docs:override' } default { 'docs:refresh' } }
    $result = [ordered]@{ action = $Action; documentId = $DocumentId; actor = $Actor; idempotencyKey = $IdempotencyKey; at = $Now }
    $replay = $false

    if ($IdempotencyKey -and $Ledger.byKey.ContainsKey($IdempotencyKey)) {
        $prior = $Ledger.byKey[$IdempotencyKey]
        if ($prior.fingerprint -ceq $fingerprint) { $dup = [ordered]@{}; foreach ($k in $prior.result.Keys) { $dup[$k] = $prior.result[$k] }; $dup.originalStatus = $prior.result.status; $dup.status = 'duplicate'; return $dup }
        $result.status = 'conflict'; $result.reason = 'idempotency key already used for a different request'; $replay = $true
    }
    elseif (-not $Actor) { $result.status = 'denied'; $result.reason = 'no actor identity' }
    elseif ($Permissions -cnotcontains $requiredPermission) { $result.status = 'denied'; $result.reason = "missing permission $requiredPermission" }
    elseif (-not $IdempotencyKey) { $result.status = 'invalid'; $result.reason = 'an idempotency key is required' }
    elseif ($Action -in @('refresh', 'retry') -and (-not [bool](Get-DocProp $Backend 'available') -or -not [bool](Get-DocProp $Backend 'indexEnabled'))) {
        $result.status = 'unavailable'; $result.reason = 'documentation backend unavailable or index disabled; no job queued'
    }
    elseif ($Action -in @('approve', 'override') -and $null -eq $record) { $result.status = 'invalid'; $result.reason = 'unknown document' }
    elseif ($Action -in @('approve', 'override') -and ((Get-DocProp $record 'schemaVersion') -ne $script:DocStatusSupportedVersion)) { $result.status = 'denied'; $result.reason = 'unsupported record version cannot be used for decisions' }
    elseif ($Action -eq 'approve') {
        $rev = Get-DocProp $record 'revision'
        if ((Get-DocProp $record 'state') -ne 'proposed') { $result.status = 'conflict'; $result.reason = "document is '$(Get-DocProp $record 'state')', only a proposed document can be approved" }
        elseif (-not $Reason) { $result.status = 'invalid'; $result.reason = 'approval requires a reason' }
        elseif (-not $ExpectedSha -or $ExpectedSha -cne [string](Get-DocProp $rev 'observedSha')) { $result.status = 'conflict'; $result.reason = 'document changed since it was viewed; reload and review again' }
        else {
            $result.status = 'accepted'
            $result.transition = [ordered]@{ documentId = $DocumentId; from = 'proposed'; to = 'approved'; observedSha = $ExpectedSha; transitionedBy = $Actor; transitionedAt = $Now; transitionReason = $Reason }
        }
    }
    elseif ($Action -eq 'override') {
        $kind = [string](Get-DocProp $record 'kind'); $mandatory = @(Get-DocProp (Get-DocProp $record 'projectPolicy') 'mandatoryGates')
        if ($kind -eq 'approved-contract' -or $mandatory -contains 'security' -or $mandatory -contains 'approved-contract') { $result.status = 'denied'; $result.reason = 'mandatory approved-contract and security gates cannot be overridden' }
        elseif (-not $Reason -or -not $ReviewBy) { $result.status = 'invalid'; $result.reason = 'override requires a reason and a review-by point' }
        else { $result.status = 'accepted'; $result.override = [ordered]@{ scope = 'advisory-routing'; reason = $Reason; reviewBy = $ReviewBy; actor = $Actor } }
    }
    else {
        $result.status = 'accepted'
        $result.job = [ordered]@{ kind = $Action; documentId = $DocumentId; jobKey = "docs-$Action-$DocumentId-$IdempotencyKey" }
    }
    $null = $Ledger.entries.Add([ordered]@{ at = $Now; action = $Action; documentId = $DocumentId; actor = $Actor; idempotencyKey = $IdempotencyKey; status = $result.status; reason = [string]$result.reason })
    if ($IdempotencyKey -and -not $replay) { $Ledger.byKey[$IdempotencyKey] = @{ fingerprint = $fingerprint; result = $result } }
    $result
}
