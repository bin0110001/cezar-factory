#!/usr/bin/env pwsh
<#
.SYNOPSIS
Deterministic GitHub state routing for factory workflows. Applies the lifecycle in policies/labels.yaml.
.DESCRIPTION
Events: start, plan-result, implement-result, review-result, investigate-result.
Guarantees a single factory:* state label, refuses transitions from the wrong source state, caps
review/fix rounds and investigation retries per policies/retry.yaml, and posts escalation summaries.
-GhCommand lets tests substitute a fake gh.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('start', 'plan-result', 'implement-result', 'review-result', 'investigate-result')][string]$Event,
    [string]$Path,
    [int]$Issue,
    [string]$GhCommand = 'gh',
    [string]$PoliciesDir = (Join-Path $PSScriptRoot '../policies'),
    [string]$ProjectPath = (Get-Location).Path
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

function Fail([string]$Msg) { Write-Output (@{ status = 'refused'; event = $Event; reason = $Msg } | ConvertTo-Json -Compress); exit 1 }
function Invoke-Gh { & $GhCommand @args; if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') failed ($LASTEXITCODE)" } }

# --- policy ---------------------------------------------------------------
$stateLabels = @()
$inState = $false
foreach ($l in Get-Content (Join-Path $PoliciesDir 'labels.yaml')) {
    if ($l -match '^factory-state:') { $inState = $true; continue }
    if ($inState -and $l -match '^\s+-\s+(\S+)') { $stateLabels += $Matches[1]; continue }
    if ($inState -and $l -match '^\S') { break }
}
if (-not $stateLabels) { Fail 'could not read factory-state labels from policies/labels.yaml' }
$retryText = Get-Content -Raw (Join-Path $PoliciesDir 'retry.yaml')
$maxRounds = if ($retryText -match 'max_review_fix_rounds:\s*(\d+)') { [int]$Matches[1] } else { 2 }
$maxInvestigateRetries = 1

# --- input ----------------------------------------------------------------
$result = $null
if ($Event -ne 'start') {
    if (-not $Path -or -not (Test-Path $Path)) { Fail "result file not found: $Path" }
    $result = Get-Content -Raw $Path | ConvertFrom-Json
    $Issue = [int]$result.issue
}
if ($Issue -lt 1) { Fail 'issue number required' }

# --- GitHub helpers ---------------------------------------------------------
$view = Invoke-Gh issue view $Issue --json 'labels,comments' | ConvertFrom-Json
$labels = @($view.labels | ForEach-Object { $_.name })
$comments = @($view.comments | ForEach-Object { $_.body })
$current = @($labels | Where-Object { $stateLabels -contains $_ })

function Assert-Source([string[]]$Allowed) {
    if ($current.Count -eq 0 -or -not ($current | Where-Object { $Allowed -contains $_ })) {
        Fail "illegal transition: issue #$Issue is in [$($current -join ', ')], expected one of [$($Allowed -join ', ')]"
    }
}
function Set-State([string]$Target) {
    $remove = @($current | Where-Object { $_ -ne $Target })
    $ghArgs = @('issue', 'edit', $Issue)
    if ($current -notcontains $Target) { $ghArgs += '--add-label', $Target }
    if ($remove.Count) { $ghArgs += '--remove-label', ($remove -join ',') }
    if ($ghArgs.Count -gt 3) { Invoke-Gh @ghArgs | Out-Null }
}
function Add-Comment([string]$Body) {
    $f = [IO.Path]::GetTempFileName()
    try { [IO.File]::WriteAllText($f, $Body); Invoke-Gh issue comment $Issue --body-file $f | Out-Null } finally { Remove-Item $f -ErrorAction SilentlyContinue }
}
function Get-SelectedWorker([string[]]$IssueLabels) {
    if ($IssueLabels -contains 'agent:codex') { return 'codex' }
    if ($IssueLabels -contains 'agent:claude') { return 'claude' }
    if ($IssueLabels -contains 'agent:local') { return 'local' }
    if ($IssueLabels -contains 'type:docs' -or $IssueLabels -contains 'type:maintenance') { return 'local' }
    if ($IssueLabels -contains 'agent:auto' -or $IssueLabels -contains 'agent:either') { return 'codex' }
    'codex'
}
function Write-ExecutionRecord([string]$Status, $Result = $null) {
    # Keep only workflow-decision data in the project artifact; OpenHands owns
    # the session transcript, command history, and worktree internals.
    $path = Join-Path $ProjectPath '.factory/execution.json'
    $worker = Get-SelectedWorker $labels
    $record = [ordered]@{
        execution = [ordered]@{
            provider = if ($worker -eq 'local') { 'local' } else { 'openhands' }
            agent = $worker
            status = $Status
            issue = $Issue
            metadata = [ordered]@{
                project = if ($env:CEZ_PROJECT_ID) { $env:CEZ_PROJECT_ID } else { Split-Path $ProjectPath -Leaf }
                workflow = if ($env:CEZ_WORKFLOW_NAME) { $env:CEZ_WORKFLOW_NAME } else { "factory-$Event" }
                github_issue = $Issue
                worker = $worker
                provider = if ($worker -eq 'local') { 'local' } else { 'openhands' }
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
function New-Escalation([string]$Observed, [string]$Attempts, [string]$Evidence, [string]$Hypothesis, [string]$Decision) {
    "## Factory escalation`n`n**Observed problem**`n$Observed`n`n**Attempts made**`n$Attempts`n`n**Relevant logs/artifacts**`n$Evidence`n`n**Current hypothesis**`n$Hypothesis`n`n**Recommended human decision**`n$Decision"
}
function Done([string]$To, [string]$Note = '') {
    Write-Output (@{ status = 'ok'; event = $Event; issue = $Issue; state = $To; note = $Note } | ConvertTo-Json -Compress)
    exit 0
}

switch ($Event) {
    'start' {
        if ($current -contains 'factory:working') { Done 'factory:working' 'already working' }
        Assert-Source 'factory:ready', 'factory:changes-requested', 'factory:blocked'
        Write-ExecutionRecord 'selected'
        Set-State 'factory:working'; Done 'factory:working'
    }
    'plan-result' {
        Assert-Source 'factory:needs-plan', 'factory:new'
        $plan = "## Factory plan`n`n**Objective**`n$(Text $result.objective)`n`n**Acceptance criteria**`n$(Text $result.acceptanceCriteria)`n`n**Non-goals**`n$(Text $result.nonGoals)`n`n**Risks**`n$(Text $result.risks)`n`n**Dependencies**`n$(Text $result.dependencies)`n`n**Work breakdown**`n$(Text $result.suggestedWorkBreakdown)`n`n**Project skills**`n$(Text $result.requiredProjectSkills)"
        if ($result.readyNotReadyStatus -eq 'decomposed') {
            # Create each sub-issue as factory:new (humans choose which to plan next), skipping any that a
            # previous attempt already created (matched by the parent marker in the body and the title).
            $marker = "<!-- factory-parent:$Issue -->"
            $existing = @{}
            foreach ($e in @(Invoke-Gh issue list --state all --search "factory-parent:$Issue in:body" --json 'number,title,body' --limit 200 | ConvertFrom-Json)) {
                if ($e.body -like "*$marker*") { $existing[$e.title] = [int]$e.number }
            }
            $subs = @($result.subIssues)
            $numbers = @()
            foreach ($sub in $subs) {
                if ($existing.ContainsKey($sub.title)) { $numbers += $existing[$sub.title]; continue }
                $body = "$($sub.body)`n`n---`nParent: #$Issue (decomposed by the factory planner)`n$marker"
                $f = [IO.Path]::GetTempFileName()
                try {
                    [IO.File]::WriteAllText($f, $body)
                    $url = (Invoke-Gh issue create --title $sub.title --body-file $f --label "factory:new,$($sub.type),$($sub.risk)" | Out-String).Trim()
                } finally { Remove-Item $f -ErrorAction SilentlyContinue }
                if ($url -notmatch '/issues/(\d+)') { throw "could not read created issue number from: $url" }
                $numbers += [int]$Matches[1]
            }
            $rows = for ($i = 0; $i -lt $subs.Count; $i++) {
                $deps = if ($subs[$i].PSObject.Properties['dependsOn'] -and @($subs[$i].dependsOn).Count) { (@($subs[$i].dependsOn) | ForEach-Object { "#$($numbers[$_])" }) -join ', ' } else { '-' }
                "| #$($numbers[$i]) | $($subs[$i].title) | $($subs[$i].type) | $($subs[$i].risk) | $deps |"
            }
            $table = "## Factory decomposition`n`nCreated $($subs.Count) sub-issues, all labelled ``factory:new``. Review them, then add ``factory:needs-plan`` to the ones you want planned (planning runs one issue per poll).`n`n| Issue | Title | Type | Risk | Depends on |`n|---|---|---|---|---|`n$($rows -join "`n")"
            Add-Comment ($plan + "`n`n" + $table)
            Set-State 'factory:human-review'; Done 'factory:human-review' "decomposed into $($subs.Count) sub-issues"
        }
        if ($result.readyNotReadyStatus -ne 'ready') {
            Add-Comment ($plan + "`n`n" + (New-Escalation (Text $result.unresolvedQuestions) 'Planning pass completed; blocking questions remain.' '(see plan above)' 'Issue lacks information required by the Definition of Ready.' 'Answer the questions above, then relabel factory:needs-plan.'))
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'not ready'
        }
        if ($labels -contains 'risk:high') {
            Add-Comment ($plan + "`n`n**risk:high: human plan approval required.** Review the plan; if approved, relabel factory:ready.")
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'risk:high plan approval'
        }
        Add-Comment $plan; Set-State 'factory:ready'; Done 'factory:ready'
    }
    'implement-result' {
        Assert-Source 'factory:working'
        if ($result.status -ne 'success') {
            Write-ExecutionRecord 'failed' $result
            Add-Comment "## Factory implementation failed`n`n$(Text $result.summary)`n`nTests: $(Text $result.testResult)`nConcerns: $(Text $result.knownConcerns)"
            Set-State 'factory:investigate'; Done 'factory:investigate' 'implementation failed'
        }
        Write-ExecutionRecord 'complete' $result
        Add-Comment "## Factory implementation`n`nPR: $($result.pr)`n`n$(Text $result.summary)`n`n**Tests run**`n$(Text $result.testsRun)`n`n**Result:** $(Text $result.testResult)`n`n**Acceptance criteria**`n$(Text $result.acceptanceCriteriaStatus)`n`n**Known concerns**`n$(Text $result.knownConcerns)"
        Set-State 'factory:review'; Done 'factory:review'
    }
    'review-result' {
        Assert-Source 'factory:review'
        $body = "## Factory review`n`n**Verdict:** $($result.approvalChangeRequestStatus)`n`n**Blocking findings**`n$(Text $result.blockingFindings)`n`n**Non-blocking findings**`n$(Text $result.nonBlockingFindings)`n`n**Acceptance criteria**`n$(Text $result.acceptanceCriteriaVerification)`n`n**Test adequacy**`n$(Text $result.testAdequacy)`n`n**Risk observations**`n$(Text $result.riskObservations)"
        if ($result.approvalChangeRequestStatus -eq 'approval') {
            Add-Comment $body; Set-State 'factory:human-review'; Done 'factory:human-review'
        }
        $rounds = @($comments | Where-Object { $_ -match '<!-- factory:review-round -->' }).Count
        if ($rounds -ge $maxRounds) {
            Add-Comment ($body + "`n`n" + (New-Escalation "Review still requests changes after $rounds fix round(s) (limit $maxRounds)." "$rounds review/fix rounds completed." '(see review findings above and the PR)' 'Findings are not converging; the plan or acceptance criteria may be wrong.' 'Decide: adjust the requirements, take over manually, or allow more rounds.'))
            Set-State 'factory:needs-help'; Done 'factory:needs-help' 'review round limit'
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
        Add-Comment ("## Factory investigation`n`n$summary`n`n" + (New-Escalation "Repeated failure classified as $($result.failureClassification)." (Text $result.attemptsReviewed) (Text $result.evidence) (Text $result.rootCauseHypothesis) (Text $result.recommendedAction)))
        Set-State 'factory:needs-help'; Done 'factory:needs-help' 'escalated'
    }
}
