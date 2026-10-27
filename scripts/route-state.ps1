#!/usr/bin/env pwsh
<#
.SYNOPSIS
Deterministic GitHub state routing for factory workflows. Applies the lifecycle in policies/labels.yaml.
.DESCRIPTION
For `start`, pass -Issue or -Task (the workflow task text; the issue number is parsed from it).
Events: start, plan-result, implement-result, review-result, investigate-result.
Guarantees a single factory:* state label, refuses transitions from the wrong source state, caps
review/fix rounds and investigation retries per policies/retry.yaml, and posts escalation summaries.
-GhCommand lets tests substitute a fake gh.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('start', 'intake-result', 'plan-result', 'implement-result', 'implement-finalize', 'review-result', 'investigate-result', 'already-resolved')][string]$Event,
    [string]$Path,
    [string]$GatePath,
    [int]$Issue,
    [string]$Task,
    [string]$GhCommand = 'gh',
    [string]$PoliciesDir = (Join-Path $PSScriptRoot '../policies'),
    [string]$ProjectPath = (Get-Location).Path
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

if ($Event -ne 'already-resolved' -and (Test-Path (Join-Path $ProjectPath '.factory/already-resolved.json'))) {
    Write-Output (@{ status = 'skipped'; event = $Event; reason = 'already-resolved' } | ConvertTo-Json -Compress); exit 0
}

function Fail([string]$Msg) { Write-Output (@{ status = 'refused'; event = $Event; reason = $Msg } | ConvertTo-Json -Compress); exit 1 }
function Invoke-Gh { & $GhCommand @args; if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') failed ($LASTEXITCODE)" } }

if ($Event -eq 'implement-finalize') {
    try {
        if ([string]::IsNullOrWhiteSpace($env:CEZAR_INPUT_JSON)) { throw 'finalizer input is missing' }
        $finalizerInput = $env:CEZAR_INPUT_JSON | ConvertFrom-Json -AsHashtable -Depth 40
        $finalization = $finalizerInput.finalization
        $outcome = $finalization.outcome
        $contractRecovery = $finalization.terminal -eq 'failed' -and $outcome.kind -eq 'contract_failure' -and $outcome.stepId -eq 'implement'
        $completedImplementation = $finalization.terminal -eq 'success' -and $null -eq $outcome
        if (-not $completedImplementation -and -not $contractRecovery) {
            Write-Output (@{ status = 'skipped'; event = $Event; reason = 'terminal-outcome-does-not-route-implementation' } | ConvertTo-Json -Compress)
            exit 0
        }
        if ($contractRecovery) { $script:contractFailureReason = [string]$outcome.reasonCode }
        $Event = 'implement-result'
    } catch {
        Fail "cannot classify implementation finalizer: $($_.Exception.Message)"
    }
}

# Workflow commands pass the raw task text ("GitHub issue #N (...) at <url>") so no agent has to extract it.
if ($Issue -lt 1 -and $Task -match 'GitHub issue #(\d+)|/issues/(\d+)|#(\d+)') {
    $Issue = [int](($Matches[1], $Matches[2], $Matches[3]) | Where-Object { $_ } | Select-Object -First 1)
}

# --- policy ---------------------------------------------------------------
$stateLabels = @()
$inState = $false
foreach ($l in Get-Content (Join-Path $PoliciesDir 'labels.yaml')) {
    if ($l -match '^factory-state:') { $inState = $true; continue }
    if ($inState -and $l -match '^\s+-\s+(\S+)') { $stateLabels += $Matches[1]; continue }
    if ($inState -and $l -match '^\S') { break }
}
if (-not $stateLabels) { Fail 'could not read factory-state labels from policies/labels.yaml' }
$complexityLabels = @()
$inComplexity = $false
foreach ($l in Get-Content (Join-Path $PoliciesDir 'labels.yaml')) {
    if ($l -match '^complexity:') { $inComplexity = $true; continue }
    if ($inComplexity -and $l -match '^\s+-\s+(\S+)') { $complexityLabels += $Matches[1]; continue }
    if ($inComplexity -and $l -match '^\S') { break }
}
# Older installed Factory layers predate complexity labels. Keep lifecycle
# routing backward-compatible so `start` can still make progress, while using
# the canonical taxonomy for plan-result validation until the layer is updated.
if (-not $complexityLabels) { $complexityLabels = @('complexity:small', 'complexity:medium', 'complexity:large') }
$retryText = Get-Content -Raw (Join-Path $PoliciesDir 'retry.yaml')
$maxRounds = if ($retryText -match 'max_review_fix_rounds:\s*(\d+)') { [int]$Matches[1] } else { 2 }
$maxInvestigateRetries = 1

# --- input ----------------------------------------------------------------
$result = $null
if ($Event -notin 'start', 'already-resolved') {
    if ($script:contractFailureReason) {
        $result = [pscustomobject]@{
            issue = $Issue
            status = 'failure'
            summary = 'Cezar rejected the implementation result contract before a validated handoff was available.'
            testsRun = @()
            testResult = 'not-run'
            acceptanceCriteriaStatus = 'Not met'
            knownConcerns = "Cezar terminal reason: $($script:contractFailureReason)"
        }
    } else {
        if (-not $Path -or -not (Test-Path $Path)) { Fail "result file not found: $Path" }
        $result = Get-Content -Raw $Path | ConvertFrom-Json
        $Issue = [int]$result.issue
    }
}
if ($Issue -lt 1) { Fail 'issue number required' }

# --- GitHub helpers ---------------------------------------------------------
$view = Invoke-Gh issue view $Issue --json 'labels,comments,updatedAt' | ConvertFrom-Json
$labels = @($view.labels | ForEach-Object { $_.name })
$comments = @($view.comments | ForEach-Object { $_.body })
$current = @($labels | Where-Object { $stateLabels -contains $_ })
$currentComplexity = @($labels | Where-Object { $complexityLabels -contains $_ })
$script:effectRevision = [string]$view.updatedAt
$script:actionReceipts = @()

function Get-LiveIssue { Invoke-Gh issue view $Issue --json 'labels,comments,updatedAt' | ConvertFrom-Json }
function Get-LabelNames($IssueView) { @($IssueView.labels | ForEach-Object { [string]$_.name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
function Get-StateNames([string[]]$IssueLabels) { @($IssueLabels | Where-Object { $stateLabels -contains $_ } | Sort-Object) }
function Assert-EffectRevision($IssueView, [string[]]$ExpectedStates) {
    if ([string]$IssueView.updatedAt -ne $script:effectRevision) { Fail 'issue revision changed before the side effect; refusing stale workflow action' }
    $liveStates = @(Get-StateNames (Get-LabelNames $IssueView))
    if (($liveStates -join "`n") -ne (@($ExpectedStates | Sort-Object) -join "`n")) {
        Fail "issue lifecycle state changed before the side effect; found [$($liveStates -join ', ')]"
    }
}

function Assert-Source([string[]]$Allowed) {
    if ($current.Count -eq 0 -or -not ($current | Where-Object { $Allowed -contains $_ })) {
        Fail "illegal transition: issue #$Issue is in [$($current -join ', ')], expected one of [$($Allowed -join ', ')]"
    }
}
function New-LabelAction([string[]]$AddLabels, [string[]]$RemoveLabels, [string]$Rationale, [string]$Revision) {
    $add = @($AddLabels | Sort-Object -Unique)
    $remove = @($RemoveLabels | Sort-Object -Unique)
    if (-not $add.Count -and -not $remove.Count) { return $null }
    $fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes((@($add) + '--' + @($remove) | ConvertTo-Json -Compress)))).ToLowerInvariant()
    $action = [ordered]@{
        schemaVersion = 1
        target = [ordered]@{ kind = 'github_issue'; id = $Issue }
        expectedRevision = ([DateTimeOffset]$Revision).ToUniversalTime().ToString('o')
        operation = 'github.issue.update_labels'
        arguments = [ordered]@{ addLabels = $add; removeLabels = $remove }
        rationale = $Rationale
        operationKey = "factory:route-labels:${Event}:${Issue}:$fingerprint"
    }
    $schemaPath = Join-Path $PSScriptRoot '../schemas/workflow-effect-action.schema.json'
    if (-not (Test-Json -Json ($action | ConvertTo-Json -Compress -Depth 8) -SchemaFile $schemaPath -ErrorAction Stop)) { Fail 'label action does not satisfy the shared workflow effect contract' }
    $action
}
function Add-LabelActionReceipt($Action, [string]$Status, [string]$ObservedRevision = '') {
    if (-not $Action) { return }
    $receipt = [ordered]@{ operationKey = $Action.operationKey; status = $Status; action = $Action }
    if ($ObservedRevision) { $receipt.observedRevision = $ObservedRevision }
    $existing = -1
    for ($i = 0; $i -lt $script:actionReceipts.Count; $i++) {
        if ($script:actionReceipts[$i].operationKey -eq $Action.operationKey) { $existing = $i; break }
    }
    if ($existing -ge 0) { $script:actionReceipts[$existing] = $receipt }
    else { $script:actionReceipts += $receipt }
}
function Set-State([string]$Target) {
    $before = Get-LiveIssue
    Assert-EffectRevision $before $current
    $beforeLabels = @(Get-LabelNames $before)
    $beforeStates = @(Get-StateNames $beforeLabels)
    $remove = @($beforeStates | Where-Object { $_ -ne $Target })
    $ghArgs = @('issue', 'edit', $Issue)
    if ($beforeStates -notcontains $Target) { $ghArgs += '--add-label', $Target }
    if ($remove.Count) { $ghArgs += '--remove-label', ($remove -join ',') }
    $action = New-LabelAction @($Target) $remove "route $Event to $Target" ([string]$before.updatedAt)
    Add-LabelActionReceipt $action 'applying'
    if ($ghArgs.Count -gt 3) {
        try { Invoke-Gh @ghArgs | Out-Null }
        catch {
            $afterAmbiguous = Get-LiveIssue
            $ambiguousStates = @(Get-StateNames (Get-LabelNames $afterAmbiguous))
            if ($ambiguousStates.Count -ne 1 -or $ambiguousStates[0] -ne $Target) { throw }
            $script:effectRevision = [string]$afterAmbiguous.updatedAt
            $script:current = @($ambiguousStates)
            $script:labels = @(Get-LabelNames $afterAmbiguous)
            Add-LabelActionReceipt $action 'verified' ([string]$afterAmbiguous.updatedAt)
            return
        }
    }
    $after = Get-LiveIssue
    $afterStates = @(Get-StateNames (Get-LabelNames $after))
    if ($afterStates.Count -ne 1 -or $afterStates[0] -ne $Target) { Fail "lifecycle label effect is unresolved; expected only '$Target'" }
    $script:effectRevision = [string]$after.updatedAt
    $script:current = @($afterStates)
    $script:labels = @(Get-LabelNames $after)
    Add-LabelActionReceipt $action 'verified' ([string]$after.updatedAt)
}
function Set-Complexity([string]$Target) {
    if ($complexityLabels -notcontains $Target) { Fail "unknown complexity label '$Target'" }
    $before = Get-LiveIssue
    Assert-EffectRevision $before $current
    $beforeLabels = @(Get-LabelNames $before)
    $liveComplexity = @($beforeLabels | Where-Object { $complexityLabels -contains $_ })
    if ((@($liveComplexity | Sort-Object) -join "`n") -ne (@($currentComplexity | Sort-Object) -join "`n")) { Fail 'issue complexity changed before the side effect' }
    $remove = @($liveComplexity | Where-Object { $_ -ne $Target })
    $ghArgs = @('issue', 'edit', $Issue)
    if ($liveComplexity -notcontains $Target) { $ghArgs += '--add-label', $Target }
    if ($remove.Count) { $ghArgs += '--remove-label', ($remove -join ',') }
    $action = New-LabelAction @($Target) $remove "set issue complexity to $Target" ([string]$before.updatedAt)
    Add-LabelActionReceipt $action 'applying'
    if ($ghArgs.Count -gt 3) {
        try { Invoke-Gh @ghArgs | Out-Null }
        catch {
            $afterAmbiguous = Get-LiveIssue
            $afterComplexity = @(Get-LabelNames $afterAmbiguous | Where-Object { $complexityLabels -contains $_ })
            if ($afterComplexity.Count -ne 1 -or $afterComplexity[0] -ne $Target) { throw }
            $script:effectRevision = [string]$afterAmbiguous.updatedAt
            $script:currentComplexity = @($afterComplexity)
            $script:labels = @(Get-LabelNames $afterAmbiguous)
            Add-LabelActionReceipt $action 'verified' ([string]$afterAmbiguous.updatedAt)
            return
        }
    }
    $after = Get-LiveIssue
    $afterComplexity = @(Get-LabelNames $after | Where-Object { $complexityLabels -contains $_ })
    if ($afterComplexity.Count -ne 1 -or $afterComplexity[0] -ne $Target) { Fail "complexity label effect is unresolved; expected only '$Target'" }
    $script:effectRevision = [string]$after.updatedAt
    $script:currentComplexity = @($afterComplexity)
    $script:labels = @(Get-LabelNames $after)
    Add-LabelActionReceipt $action 'verified' ([string]$after.updatedAt)
}
function Set-Classification([string]$Type, [string]$Risk) {
    if ($Type -notmatch '^type:' -or $Risk -notmatch '^risk:') { Fail 'intake classification labels are invalid' }
    $before = Get-LiveIssue
    Assert-EffectRevision $before $current
    $beforeLabels = @(Get-LabelNames $before)
    $add = @(); foreach ($label in @($Type, $Risk)) { if ($beforeLabels -notcontains $label) { $add += $label } }
    $action = New-LabelAction $add @() 'apply validated intake classification' ([string]$before.updatedAt)
    Add-LabelActionReceipt $action 'applying'
    if ($add.Count) {
        try { Invoke-Gh issue edit $Issue --add-label ($add -join ',') | Out-Null }
        catch {
            $afterAmbiguous = Get-LiveIssue
            $afterAmbiguousLabels = @(Get-LabelNames $afterAmbiguous)
            if (@($afterAmbiguousLabels | Where-Object { $_ -in @($Type, $Risk) }).Count -ne 2) { throw }
            $script:effectRevision = [string]$afterAmbiguous.updatedAt
            $script:labels = $afterAmbiguousLabels
            Add-LabelActionReceipt $action 'verified' ([string]$afterAmbiguous.updatedAt)
            return
        }
    }
    $after = Get-LiveIssue
    $afterLabels = @(Get-LabelNames $after)
    if (@($afterLabels | Where-Object { $_ -in @($Type, $Risk) }).Count -ne 2) { Fail 'classification label effect is unresolved' }
    $script:effectRevision = [string]$after.updatedAt
    $script:labels = $afterLabels
    Add-LabelActionReceipt $action 'verified' ([string]$after.updatedAt)
}
function Add-Comment([string]$Body) {
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Body))).ToLowerInvariant()
    $operation = "factory:route-effect:${Event}:${Issue}:$hash"
    $marker = "<!-- $operation -->"
    $before = Get-LiveIssue
    $prior = @($before.comments | ForEach-Object { [string]$_.body } | Where-Object { $_ -match [regex]::Escape($marker) })
    if ($prior.Count) {
        $script:effectRevision = [string]$before.updatedAt
        return
    }
    Assert-EffectRevision $before $current
    $action = [ordered]@{
        schemaVersion = 1
        target = [ordered]@{ kind = 'github_issue'; id = $Issue }
        # ConvertFrom-Json may materialize ISO timestamps as DateTime values;
        # normalize those to a culture-independent ISO representation for the
        # persisted action contract.
        expectedRevision = ([DateTimeOffset]$before.updatedAt).ToUniversalTime().ToString('o')
        operation = 'github.issue.add_comment'
        arguments = [ordered]@{ bodySha256 = $hash }
        rationale = [string]$Event
        operationKey = $operation
    }
    if (-not $action.expectedRevision -or $action.rationale.Length -gt 500 -or $action.operationKey.Length -gt 256) {
        Fail 'comment action is missing a bounded revision, rationale or operation key'
    }
    $actionJson = $action | ConvertTo-Json -Compress -Depth 6
    $actionSchemaPath = Join-Path $PSScriptRoot '../schemas/workflow-effect-action.schema.json'
    try {
        if (-not (Test-Json -Json $actionJson -SchemaFile $actionSchemaPath -ErrorAction Stop)) {
            Fail 'comment action does not satisfy the shared workflow effect contract'
        }
    } catch { Fail "comment action schema validation failed: $($_.Exception.Message)" }
    $actionPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actionJson))
    $actionMarker = "<!-- factory:effect-action:v1:$actionPayload -->"
    $markedBody = $Body + "`n`n" + $marker + "`n" + $actionMarker
    $f = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($f, $markedBody)
        try { Invoke-Gh issue comment $Issue --body-file $f | Out-Null }
        catch {
            $afterAmbiguous = Get-LiveIssue
            $found = @($afterAmbiguous.comments | ForEach-Object { [string]$_.body } | Where-Object { $_ -match [regex]::Escape($marker) })
            if (-not $found.Count) { throw }
            $script:effectRevision = [string]$afterAmbiguous.updatedAt
            return
        }
        $after = Get-LiveIssue
        $found = @($after.comments | ForEach-Object { [string]$_.body } | Where-Object { $_ -match [regex]::Escape($marker) })
        if (-not $found.Count) { Fail "comment side effect is unresolved for $operation" }
        $script:effectRevision = [string]$after.updatedAt
    } finally { Remove-Item $f -ErrorAction SilentlyContinue }
}
function Add-PlanCommentOnce([string]$Body) {
    $prefix = "<!-- factory:plan-result:${Issue}:"
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Body))).ToLowerInvariant()
    $receipt = "$prefix$hash -->"
    $fresh = Get-LiveIssue
    $freshStates = @(Get-StateNames (Get-LabelNames $fresh))
    if ($freshStates.Count -ne 1 -or $freshStates[0] -notin @('factory:needs-plan', 'factory:new') -or $current -notcontains $freshStates[0]) {
        Fail 'issue state changed before the plan-result comment could be applied'
    }
    $prior = @($fresh.comments | ForEach-Object { [string]$_.body } | Where-Object { $_ -match [regex]::Escape($prefix) })
    if ($prior.Count -gt 0) {
        if ($prior | Where-Object { $_ -notmatch [regex]::Escape($receipt) }) { Fail 'a prior plan-result comment has different content; reconcile the issue before retrying' }
        $script:effectRevision = [string]$fresh.updatedAt
        return
    }
    Assert-EffectRevision $fresh $current
    Add-Comment ($Body + "`n`n$receipt")
}
function Get-SelectedWorker([string[]]$IssueLabels) {
    # Complexity is an implementation-tier guard. Medium and large work must
    # never fall through to the bounded local worker, even if a stale or
    # conflicting agent:local label is present.
    if ($IssueLabels -contains 'complexity:medium' -or $IssueLabels -contains 'complexity:large') { return 'codex' }
    if ($IssueLabels -contains 'agent:codex') { return 'codex' }
    if ($IssueLabels -contains 'agent:claude') { return 'claude' }
    if ($IssueLabels -contains 'agent:local') { return 'local' }
    if ($IssueLabels -contains 'type:docs' -or $IssueLabels -contains 'type:maintenance') { return 'local' }
    if ($IssueLabels -contains 'agent:auto' -or $IssueLabels -contains 'agent:either') { return 'codex' }
    'codex'
}
function Write-ExecutionRecord([string]$Status, $Result = $null) {
    # Keep only workflow-decision data in the project artifact; Cezar owns
    # the session transcript, command history, and worktree internals.
    $path = Join-Path $ProjectPath '.factory/execution.json'
    $worker = Get-SelectedWorker $labels
    $record = [ordered]@{
        execution = [ordered]@{
            provider = if ($worker -eq 'local') { 'local' } else { 'cezar' }
            agent = $worker
            status = $Status
            issue = $Issue
            metadata = [ordered]@{
                project = if ($env:CEZ_PROJECT_ID) { $env:CEZ_PROJECT_ID } else { Split-Path $ProjectPath -Leaf }
                workflow = if ($env:CEZ_WORKFLOW_NAME) { $env:CEZ_WORKFLOW_NAME } else { "factory-$Event" }
                github_issue = $Issue
                worker = $worker
                provider = if ($worker -eq 'local') { 'local' } else { 'cezar' }
                model = if ($env:FACTORY_MODEL) { $env:FACTORY_MODEL } else { $worker }
            }
        }
    }
    if ($Result) {
        if ($Result.PSObject.Properties['pr']) { $record.execution.pr = $Result.pr }
        if ($Result.PSObject.Properties['status']) { $record.execution.result = $Result.status }
        if ($Result.PSObject.Properties['branch']) { $record.execution.branch = $Result.branch }
    }
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    $record | ConvertTo-Json -Depth 5 | Set-Content -Path $path -Encoding utf8
}
function Text($v) { if ($v -is [array]) { ($v | ForEach-Object { "- $_" }) -join "`n" } else { "$v" } }
function Get-ImplementationCommentBody($ImplementationResult) {
    if ($ImplementationResult.status -ne 'success') {
        return "## Factory implementation failed`n`n$(Text $ImplementationResult.summary)`n`nTests: $(Text $ImplementationResult.testResult)`nConcerns: $(Text $ImplementationResult.knownConcerns)"
    }
    "## Factory implementation`n`nPR: $($ImplementationResult.pr)`n`n$(Text $ImplementationResult.summary)`n`n**Tests run**`n$(Text $ImplementationResult.testsRun)`n`n**Result:** $(Text $ImplementationResult.testResult)`n`n**Acceptance criteria**`n$(Text $ImplementationResult.acceptanceCriteriaStatus)`n`n**Known concerns**`n$(Text $ImplementationResult.knownConcerns)"
}
function Get-RouteReceiptMarker([string]$Body) {
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Body))).ToLowerInvariant()
    "<!-- factory:route-effect:${Event}:${Issue}:$hash -->"
}
function New-Escalation([string]$Observed, [string]$Attempts, [string]$Evidence, [string]$Hypothesis, [string]$Decision) {
    "## Factory escalation`n`n**Observed problem**`n$Observed`n`n**Attempts made**`n$Attempts`n`n**Relevant logs/artifacts**`n$Evidence`n`n**Current hypothesis**`n$Hypothesis`n`n**Recommended next step / major architectural decision**`n$Decision"
}
function Done([string]$To, [string]$Note = '') {
    Write-Output (@{ status = 'ok'; event = $Event; issue = $Issue; state = $To; note = $Note; actionReceipts = @($script:actionReceipts) } | ConvertTo-Json -Compress -Depth 12)
    exit 0
}

switch ($Event) {
    'intake-result' {
        Assert-Source 'factory:new'
        Set-Classification ([string]$result.type) ([string]$result.risk)
        Add-Comment "## Factory intake`n`n$(Text $result.summary)`n`n**Type:** $($result.type)`n**Risk:** $($result.risk)"
        if (-not [string]::IsNullOrWhiteSpace([string]$result.unresolvedQuestions)) {
            Add-Comment (New-Escalation (Text $result.unresolvedQuestions) 'Intake classification completed.' '(see intake result)' 'The issue cannot be safely planned without an answer.' 'Answer the questions, then relabel the issue factory:needs-plan.')
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'intake question'
        }
        Set-State 'factory:needs-plan'; Done 'factory:needs-plan' 'classified'
    }
    'already-resolved' {
        # Closed/done issue: collapse to the single terminal state label. No comment; nothing new happened.
        Set-State 'factory:done'; Done 'factory:done' 'already resolved'
    }
    'start' {
        if ($current -contains 'factory:working') { Done 'factory:working' 'already working' }
        Assert-Source 'factory:ready', 'factory:changes-requested', 'factory:blocked'
        Write-ExecutionRecord 'selected'
        Set-State 'factory:working'; Done 'factory:working'
    }
    'plan-result' {
        Assert-Source 'factory:needs-plan', 'factory:new'
        Set-Complexity $result.complexity
        $plan = "## Factory plan`n`n**Objective**`n$(Text $result.objective)`n`n**Acceptance criteria**`n$(Text $result.acceptanceCriteria)`n`n**Non-goals**`n$(Text $result.nonGoals)`n`n**Risks**`n$(Text $result.risks)`n`n**Dependencies**`n$(Text $result.dependencies)`n`n**Work breakdown**`n$(Text $result.suggestedWorkBreakdown)`n`n**Project skills**`n$(Text $result.requiredProjectSkills)"
        if ($result.readyNotReadyStatus -eq 'decomposed') {
            # Create each sub-issue as factory:needs-plan so decomposition continues autonomously, skipping any that a
            # previous attempt already created (matched by the parent marker in the body and the title).
            $marker = "<!-- factory-parent:$Issue -->"
            $existing = @{}
            $existingBySlot = @{}
            foreach ($e in @(Invoke-Gh issue list --state all --search "factory-parent:$Issue in:body" --json 'number,title,body' --limit 200 | ConvertFrom-Json)) {
                if ($e.body -like "*$marker*") {
                    $existing[[string]$e.title] = [int]$e.number
                    $slotMatch = [regex]::Match([string]$e.body, "<!-- factory:plan-child:${Issue}:(?<slot>\d+):(?<digest>[a-f0-9]{64}) -->")
                    if ($slotMatch.Success) { $existingBySlot[[int]$slotMatch.Groups['slot'].Value] = [ordered]@{ number = [int]$e.number; digest = $slotMatch.Groups['digest'].Value } }
                }
            }
            $subs = @($result.subIssues)
            $numbers = @()
            $actionSchemaPath = Join-Path $PSScriptRoot '../schemas/workflow-effect-action.schema.json'
            for ($i = 0; $i -lt $subs.Count; $i++) {
                $sub = $subs[$i]
                $subTitle = [string]$sub.title
                $subBody = [string]$sub.body
                $subType = [string]$sub.type
                $subRisk = [string]$sub.risk
                $subComplexity = [string]$sub.complexity
                $subDependencies = if ($sub.PSObject.Properties['dependsOn']) { @($sub.dependsOn) } else { @() }
                $specification = [ordered]@{ slot = $i; title = $subTitle; body = $subBody; type = $subType; risk = $subRisk; complexity = $subComplexity; dependsOn = $subDependencies }
                $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($specification | ConvertTo-Json -Compress -Depth 8)))).ToLowerInvariant()
                $slotMarker = "<!-- factory:plan-child:${Issue}:${i}:$digest -->"
                if ($existingBySlot.ContainsKey($i)) {
                    if ($existingBySlot[$i].digest -ne $digest) { Fail "decomposition slot $i already has a child issue with different content; reconcile before retrying" }
                    $numbers += [int]$existingBySlot[$i].number
                    continue
                }
                if ($existing.ContainsKey($subTitle)) { $numbers += $existing[$subTitle]; continue }
                $freshParent = Get-LiveIssue
                Assert-EffectRevision $freshParent $current
                $expectedRevision = ([DateTimeOffset]$freshParent.updatedAt).ToUniversalTime().ToString('o')
                $labelsForChild = @('factory:needs-plan', $subType, $subRisk, $subComplexity)
                $operationKey = "factory:plan-result:${Issue}:child:${i}:$digest"
                $action = [ordered]@{
                    schemaVersion = 1
                    target = [ordered]@{ kind = 'github_issue'; id = $Issue }
                    expectedRevision = $expectedRevision
                    operation = 'github.issue.create_child'
                    arguments = [ordered]@{ slot = $i; title = $subTitle; bodySha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($subBody))).ToLowerInvariant(); labels = $labelsForChild }
                    rationale = 'plan-result decomposition'
                    operationKey = $operationKey
                }
                $actionJson = $action | ConvertTo-Json -Compress -Depth 8
                try {
                    if (-not (Test-Json -Json $actionJson -SchemaFile $actionSchemaPath -ErrorAction Stop)) { Fail "sub-issue action for slot $i does not satisfy the shared effect contract" }
                } catch { Fail "sub-issue action schema validation failed for slot ${i}: $($_.Exception.Message)" }
                $actionPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actionJson))
                $effectMarker = "<!-- factory:effect-action:v1:$actionPayload -->"
                $body = "$subBody`n`n---`nParent: #$Issue (decomposed by the factory planner)`n$marker`n$slotMarker`n$effectMarker"
                $f = [IO.Path]::GetTempFileName()
                $createdNumber = 0
                $url = ''
                $createFailure = $null
                try {
                    [IO.File]::WriteAllText($f, $body)
                    try { $url = (Invoke-Gh issue create --title $subTitle --body-file $f --label ($labelsForChild -join ',') | Out-String).Trim() }
                    catch { $createFailure = $_ }
                } finally { Remove-Item $f -ErrorAction SilentlyContinue }
                if ($url -match '/issues/(\d+)') { $createdNumber = [int]$Matches[1] }
                if ($createdNumber -lt 1) {
                    try {
                        $reconciled = @(Invoke-Gh issue list --state all --search "factory-parent:$Issue in:body" --json 'number,title,body' --limit 200 | ConvertFrom-Json | Where-Object { [string]$_.body -like "*$slotMarker*" })
                    } catch { if ($createFailure) { throw $createFailure }; throw }
                    if ($reconciled.Count -eq 1) { $createdNumber = [int]$reconciled[0].number }
                    elseif ($reconciled.Count -gt 1) { Fail "sub-issue creation for slot $i has multiple matching remote results; reconcile manually" }
                    elseif ($createFailure) { throw $createFailure }
                    else { Fail "sub-issue creation for slot $i returned no verifiable issue URL or receipt" }
                }
                $numbers += $createdNumber
            }
            $rows = for ($i = 0; $i -lt $subs.Count; $i++) {
                $deps = if ($subs[$i].PSObject.Properties['dependsOn'] -and @($subs[$i].dependsOn).Count) { (@($subs[$i].dependsOn) | ForEach-Object { "#$($numbers[$_])" }) -join ', ' } else { '-' }
                "| #$($numbers[$i]) | $($subs[$i].title) | $($subs[$i].type) | $($subs[$i].risk) | $deps |"
            }
            $table = "## Factory decomposition`n`nCreated $($subs.Count) sub-issues and queued them as ``factory:needs-plan`` for autonomous planning and implementation in dependency order. This parent is a tracking record and is closed after decomposition.`n`n| Issue | Title | Type | Risk | Depends on |`n|---|---|---|---|---|`n$($rows -join "`n")"
            Add-PlanCommentOnce ($plan + "`n`n" + $table)
            Set-State 'factory:done'
            Invoke-Gh issue close $Issue --comment "Decomposed into $($subs.Count) child issues, queued for autonomous planning and implementation in dependency order." | Out-Null
            Done 'factory:done' "decomposed into $($subs.Count) queued sub-issues"
        }
        if ($result.readyNotReadyStatus -ne 'ready') {
            Add-PlanCommentOnce ($plan + "`n`n" + (New-Escalation (Text $result.unresolvedQuestions) 'Planning pass completed; blocking questions remain.' '(see plan above)' 'Issue lacks information required by the Definition of Ready.' 'Answer the questions above, then relabel factory:needs-plan.'))
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'not ready'
        }
        if ($labels -contains 'risk:high') {
            Add-PlanCommentOnce ($plan + "`n`n**risk:high: human plan approval required.** Review the plan; if approved, relabel factory:ready.")
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'risk:high plan approval'
        }
        Add-PlanCommentOnce $plan; Set-State 'factory:ready'; Done 'factory:ready'
    }
    'implement-result' {
        $targetState = if ($result.status -eq 'success') { 'factory:review' } else { 'factory:investigate' }
        $implementationBody = Get-ImplementationCommentBody $result
        $receiptMarker = Get-RouteReceiptMarker $implementationBody
        if ($current -notcontains 'factory:working') {
            $matchingReceipt = @($comments | Where-Object { $_ -match [regex]::Escape($receiptMarker) }).Count -gt 0
            if ($current.Count -eq 1 -and $current[0] -eq $targetState -and $matchingReceipt) {
                Write-ExecutionRecord $(if ($result.status -eq 'success') { 'complete' } else { 'failed' }) $result
                Done $targetState 'implementation routing receipt already applied'
            }
            if ($current -contains $targetState) { Fail "implementation routing state '$targetState' exists without this result's receipt; reconcile before retrying" }
        }
        Assert-Source 'factory:working'
        if ($result.status -ne 'success') {
            Write-ExecutionRecord 'failed' $result
            Add-Comment $implementationBody
            Set-State 'factory:investigate'; Done 'factory:investigate' 'implementation failed'
        }
        Write-ExecutionRecord 'complete' $result
        Add-Comment $implementationBody
        Set-State 'factory:review'; Done 'factory:review'
    }
    'review-result' {
        Assert-Source 'factory:review'
        $body = "## Factory review`n`n**Verdict:** $($result.approvalChangeRequestStatus)`n`n**Blocking findings**`n$(Text $result.blockingFindings)`n`n**Non-blocking findings**`n$(Text $result.nonBlockingFindings)`n`n**Acceptance criteria**`n$(Text $result.acceptanceCriteriaVerification)`n`n**Test adequacy**`n$(Text $result.testAdequacy)`n`n**Risk observations**`n$(Text $result.riskObservations)"
        if ($result.approvalChangeRequestStatus -eq 'approval') {
            $autoMerge = [string]$result.pr
            if ($autoMerge) {
                if (-not $GatePath -or -not (Test-Path -LiteralPath $GatePath)) {
                    Add-Comment ($body + "`n`nMerge was not requested: the workflow did not produce a merge-eligibility receipt. The issue remains in review.")
                    Done 'factory:review' 'missing merge-eligibility receipt'
                }
                try { $gate = Get-Content -Raw -LiteralPath $GatePath | ConvertFrom-Json } catch { Fail "invalid merge-eligibility receipt: $($_.Exception.Message)" }
                if ($gate.decision -ne 'allowed' -or [string]$gate.pr -ne $autoMerge -or [string]$gate.headSha -ne [string]$result.reviewedHeadSha) {
                    $blockers = @($gate.blockers | ForEach-Object { "- $_" }) -join "`n"
                    Add-Comment ($body + "`n`nMerge was not requested. The live eligibility gate denied this PR at the reviewed head. The issue remains in review.`n`n$blockers")
                    Done 'factory:review' 'merge eligibility denied; no GitHub write made'
                }
                Invoke-Gh pr merge ([string]$result.pr) --auto --squash --delete-branch --match-head-commit ([string]$gate.headSha) | Out-Null
                $mergeState = Invoke-Gh pr view ([string]$result.pr) --json 'state,headRefOid' | ConvertFrom-Json
                if ([string]$mergeState.headRefOid -ne [string]$gate.headSha) { Fail 'PR head changed while requesting merge; issue remains open for fresh review' }
                if ([string]$mergeState.state -eq 'MERGED') {
                    Add-Comment ($body + "`n`nValidated approval: auto-merge was requested for the reviewed dev head and GitHub reports the PR merged.")
                    Set-State 'factory:done'; Done 'factory:done' 'approved, validated PR observed merged'
                }
                Add-Comment ($body + "`n`nValidated approval: auto-merge was requested for the reviewed dev head. GitHub has not reported the PR merged yet; the issue remains in review for a later completion check.")
                Done 'factory:review' 'auto-merge requested; completion not yet observed'
            }
            Add-Comment ($body + "`n`nNo PR URL was supplied. Return this issue to implementation to provide the PR link; do not wait for user review.")
            Set-State 'factory:changes-requested'; Done 'factory:changes-requested' 'approved result is missing its PR URL'
        }
        $rounds = @($comments | Where-Object { $_ -match '<!-- factory:review-round -->' }).Count
        if ($rounds -ge $maxRounds) {
            Add-Comment ($body + "`n`nIndependent review still requests changes after $rounds fix round(s). Automatically investigating the disagreement and continuing the work; this limit is not a user-approval gate.")
            Set-State 'factory:investigate'; Done 'factory:investigate' 'review fix limit reached; automatic investigation'
        }
        Add-Comment ($body + "`n`n<!-- factory:review-round -->"); Set-State 'factory:changes-requested'; Done 'factory:changes-requested'
    }
    'investigate-result' {
        Assert-Source 'factory:investigate', 'factory:working'
        $retries = @($comments | Where-Object { $_ -match '<!-- factory:investigate-retry -->' }).Count
        $summary = "**Classification:** $($result.failureClassification) (confidence: $($result.confidence))"
        if ($result.automaticRetryAppropriate -eq $true -and $result.confidence -ne 'low' -and $retries -lt $maxInvestigateRetries) {
            Add-Comment "## Factory investigation`n`n$summary`n`n**Root cause:** $(Text $result.rootCauseHypothesis)`n`n**Recommended action:** $(Text $result.recommendedAction)`n`nRetrying implementation.`n`n<!-- factory:investigate-retry -->"
            Set-State 'factory:ready'; Done 'factory:ready' 'retry'
        }
        Add-Comment ("## Factory investigation`n`n$summary`n`n**Root cause:** $(Text $result.rootCauseHypothesis)`n`n**Recommended action:** $(Text $result.recommendedAction)")
        if ($result.failureClassification -eq 'architecture') {
            Add-Comment 'This issue requires a major architectural decision. User input is needed before planning can continue.'
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'major architectural decision required'
        }
        if ($result.failureClassification -in @('environment', 'dependency', 'merge-conflict')) {
            Set-State 'factory:blocked'; Done 'factory:blocked' 'external dependency or environment blocker'
        }
        Add-Comment 'No major architectural decision or external blocker prevents progress. Returning the issue to planning with the investigation evidence so the next implementation attempt can use a revised approach.'
        Set-State 'factory:needs-plan'; Done 'factory:needs-plan' 'automatic re-plan after investigation'
    }
}
