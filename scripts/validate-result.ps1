#!/usr/bin/env pwsh
<#
.SYNOPSIS
Validate an agent result file against its factory schema plus the policy rules the schema cannot express.
.DESCRIPTION
Kinds: plan, implementation, review, investigation. Prints one compact JSON line and exits 1 on failure,
so workflow check steps can feed the short error list back to the retried agent.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('intake', 'plan', 'implementation', 'review', 'investigation')][string]$Kind,
    [Parameter(Mandatory)][string]$Path,
    [string]$SchemaDir = (Join-Path $PSScriptRoot '../schemas')
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$schemaFile = @{ intake = 'intake-result.schema.json'; plan = 'plan.schema.json'; implementation = 'implementation-result.schema.json'; review = 'review-result.schema.json'; investigation = 'investigation-result.schema.json' }[$Kind]
$errors = [System.Collections.Generic.List[string]]::new()
$findings = [System.Collections.Generic.List[object]]::new()
$schema = $null
$result = $null
$script:ValidationOutcome = $null

function Add-Finding {
    param(
        [Parameter(Mandatory)][string]$RuleId,
        [Parameter(Mandatory)][string]$FieldPath,
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][ValidateSet('structural', 'semantic', 'unsupported_claim', 'validator')][string]$Category,
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('repairable', 'not-repairable', 'unknown')][string]$Repairability = 'repairable'
    )
    # Fingerprints use stable contract coordinates only. Human text, timestamps,
    # line numbers and current artifact hashes are deliberately excluded.
    $canonical = @($Kind, $RuleId, $FieldPath, $Scope, $Category) -join "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
    $fingerprint = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $findings.Add([ordered]@{
        code = 'result-contract'
        ruleId = $RuleId
        fieldPath = $FieldPath
        occurrenceScope = $Scope
        category = $Category
        severity = 'error'
        repairability = $Repairability
        artifactRevision = ''
        evidenceRef = ''
        fingerprint = $fingerprint
        findingFingerprint = $fingerprint
        findingStrategyId = 'implementation-result-v1'
        findingStrategyVersion = 1
        message = $Message
    })
    $errors.Add($Message)
}

function Done {
    # Legacy validators still accumulate human-readable errors. Project each one
    # into the versioned diagnostic contract before serializing the receipt.
    foreach ($message in @($errors)) {
        if (@($findings | Where-Object { $_.message -eq $message }).Count) { continue }
        $fieldPath = '$'
        if ($message -match "'([A-Za-z][A-Za-z0-9]*(?:\[[0-9]+\])?(?:\.[A-Za-z][A-Za-z0-9]*)*)'") { $fieldPath = '$.' + $Matches[1] }
        elseif ($message -match '(decisions|subIssues)\[([0-9]+)\](?:\.([A-Za-z]+))?') {
            $fieldPath = '$.' + $Matches[1] + '[' + $Matches[2] + ']' + $(if ($Matches[3]) { '.' + $Matches[3] } else { '' })
        }
        if ($fieldPath -eq '$' -and $message -match '(?:but|for|field)\s+([A-Za-z][A-Za-z0-9]+)') { $fieldPath = '$.' + $Matches[1] }
        if ($fieldPath -eq '$' -and $schema -and $schema.properties) {
            foreach ($propertyName in $schema.properties.Keys) {
                if ($message -match [regex]::Escape([string]$propertyName)) { $fieldPath = '$.' + $propertyName; break }
            }
        }
        $scope = 'result'
        if ($fieldPath -match '\[([0-9]+)\]') { $scope = 'result:' + $Matches[1] }
        $category = if ($message -match '(?i)status is success|must be passed|acceptanceCriteriaStatus') { 'unsupported_claim' }
            elseif ($message -match '(?i)missing required field|must be a |must be one of|must not be empty|items must be|is not valid JSON|must be an object') { 'structural' }
            else { 'semantic' }
        $ruleSlug = ($fieldPath -replace '[^A-Za-z0-9]+', '.').Trim('.').ToLowerInvariant()
        $canonical = @($Kind, 'result.' + $ruleSlug, $fieldPath, $scope, $category) -join "`n"
        $fingerprint = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()
        $findings.Add([ordered]@{ code='result-contract'; ruleId=('result.' + $ruleSlug); fieldPath=$fieldPath; occurrenceScope=$scope; category=$category; severity='error'; repairability='repairable'; artifactRevision=''; evidenceRef=''; fingerprint=$fingerprint; findingFingerprint=$fingerprint; findingStrategyId='implementation-result-v1'; findingStrategyVersion=1; message=$message })
    }
    $status = if ($errors.Count) { 'invalid' } else { 'valid' }
    $outcome = $script:ValidationOutcome
    if (-not $outcome) {
        if ($errors.Count) { $outcome = 'failed' }
        elseif ($Kind -eq 'implementation' -and $result.status -eq 'incomplete') { $outcome = 'inconclusive' }
        elseif ($Kind -eq 'implementation' -and $result.status -eq 'failure') { $outcome = 'failed' }
        else { $outcome = 'passed' }
    }
    $artifactRevision = ''
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        try { $artifactRevision = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
        catch { $artifactRevision = '' }
    }
    $evidenceRef = if ($artifactRevision) { "result:${Kind}:sha256:${artifactRevision}" } else { "result:${Kind}:unavailable" }
    foreach ($finding in $findings) {
        $finding.artifactRevision = $artifactRevision
        $finding.evidenceRef = $evidenceRef
    }

    $required = if ($schema -and $schema.required) { @($schema.required) } else { @() }
    if ($Kind -eq 'implementation' -and $result -is [hashtable] -and $result.status -eq 'incomplete') { $required += 'incompleteReason' }
    $actual = if ($result -is [hashtable]) { @($required | Where-Object { $result.ContainsKey($_) }) } else { @() }
    $missing = @($required | Where-Object { $actual -notcontains $_ })
    $successFields = if ($Kind -eq 'implementation' -and $result.status -eq 'success') {
        @('testResult', 'testsRun', 'filesChanged', 'acceptanceCriteriaStatus', 'pr')
    } else { @() }
    $successFieldsPresent = if ($result -is [hashtable]) { @($successFields | Where-Object { $result.ContainsKey($_) }) } else { @() }
    $successFieldsMissing = @($successFields | Where-Object { $successFieldsPresent -notcontains $_ })
    $coverage = [ordered]@{
        requiredFields = [ordered]@{
            expected = $required
            actual = $actual
            missing = $missing
            complete = ($missing.Count -eq 0)
        }
        successGates = [ordered]@{
            expected = $successFields
            actual = $successFieldsPresent
            missing = $successFieldsMissing
            complete = ($successFieldsMissing.Count -eq 0)
        }
    }
    ([ordered]@{
        diagnosticVersion = 1
        status = $status
        outcome = $outcome
        kind = $Kind
        resultStatus = if ($result -is [hashtable] -and $result.ContainsKey('status')) { $result.status } else { '' }
        artifactRevision = $artifactRevision
        evidenceRef = $evidenceRef
        coverage = $coverage
        findings = @($findings)
        errors = @($errors)
    } | ConvertTo-Json -Compress -Depth 8) | Write-Output
    exit $(if ($errors.Count -or $outcome -eq 'validator_error') { 1 } else { 0 })
}

trap {
    $script:ValidationOutcome = 'validator_error'
    $errors.Clear()
    $findings.Clear()
    Add-Finding -RuleId 'validator.internal-error' -FieldPath '$' -Scope 'validator' -Category 'validator' -Message 'The result validator could not complete.' -Repairability 'not-repairable'
    Done
}

try { $schema = Get-Content -Raw (Join-Path $SchemaDir $schemaFile) | ConvertFrom-Json -AsHashtable }
catch {
    $script:ValidationOutcome = 'validator_error'
    Add-Finding -RuleId 'validator.schema-unavailable' -FieldPath '$schema' -Scope 'validator' -Category 'validator' -Message 'The result schema could not be loaded.' -Repairability 'not-repairable'
    Done
}

# Already-resolved issue (see check-already-resolved.ps1): the result check was not run.
if (Test-Path '.factory/already-resolved.json') {
    $script:ValidationOutcome = 'not_run'
    Done
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-Finding -RuleId 'schema.result-file-required' -FieldPath '$' -Scope 'result' -Category 'structural' -Message 'The result file is missing.'
    Done
}
try { $result = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable }
catch { Add-Finding -RuleId 'schema.json-invalid' -FieldPath '$' -Scope 'result' -Category 'structural' -Message 'The result file is not valid JSON.'; Done }
if ($result -isnot [hashtable]) {
    Add-Finding -RuleId 'schema.object-required' -FieldPath '$' -Scope 'result' -Category 'structural' -Message 'The result must be a JSON object.'
    Done
}

# Minimal draft-07 subset: required, type, enum, minimum, minLength, array item type.
foreach ($req in $schema.required) { if (-not $result.ContainsKey($req)) { $errors.Add("missing required field '$req'") } }
foreach ($name in $schema.properties.Keys) {
    if (-not $result.ContainsKey($name)) { continue }
    $p = $schema.properties[$name]; $v = $result[$name]
    switch ($p.type) {
        'string' { if ($v -isnot [string]) { $errors.Add("'$name' must be a string"); continue }
            if ($p.ContainsKey('minLength') -and $v.Trim().Length -lt $p.minLength) { $errors.Add("'$name' must not be empty") } }
        'integer' { if ($v -isnot [int] -and $v -isnot [long]) { $errors.Add("'$name' must be an integer"); continue }
            if ($p.ContainsKey('minimum') -and $v -lt $p.minimum) { $errors.Add("'$name' must be >= $($p.minimum)") } }
        'boolean' { if ($v -isnot [bool]) { $errors.Add("'$name' must be a boolean") } }
        'array' { if ($v -isnot [array]) { $errors.Add("'$name' must be an array") }
            elseif ($p.items.type -eq 'string' -and ($v | Where-Object { $_ -isnot [string] })) { $errors.Add("'$name' items must be strings") } }
    }
    if ($p.ContainsKey('enum') -and $v -isnot [array] -and $p.enum -notcontains $v) { $errors.Add("'$name' must be one of: $($p.enum -join ', ')") }
}

function Blank($v) { $null -eq $v -or ($v -is [string] -and ($v.Trim() -eq '' -or $v.Trim() -match '^(none|n/a|-)\.?$')) }

# Version 1 of the agent-result vocabulary. Unknown descriptive values remain
# readable in failure results, but never qualify a success result.
function Normalized-Outcome($value) {
    $text = ([string]$value).Trim().ToLowerInvariant()
    switch -Regex ($text) {
        '^(pass|passed|success|succeeded)$' { return 'passed' }
        '^(fail|failed|failure|error)$' { return 'failed' }
        '^(skip|skipped|not-run|not run)$' { return 'skipped' }
        default { return 'unknown' }
    }
}

function Acceptance-Met($value) {
    ([string]$value).Trim() -match '^(?i:met|all criteria met|all acceptance criteria met)$'
}

function Qualified-PrUrl($value) {
    ([string]$value).Trim() -match '^https://github\.com/[^/\s?#]+/[^/\s?#]+/pull/[1-9][0-9]*(?:/)?$'
}

function Substantive-List($values) {
    $items = @($values)
    if ($items.Count -eq 0) { return $false }
    foreach ($item in $items) {
        if ((Blank $item) -or ([string]$item).Trim() -match '^(?i:placeholder|todo|tbd|test name or identifier|path/to/.*)$') {
            return $false
        }
    }
    return $true
}

# Optional structured decision requests (schemas/decision.schema.json). Absent is fine; present
# must be well-formed so the Cezarium decisions screen can show every path and post an answer.
function Test-Decisions($decisions) {
    $idPattern = '^[a-z0-9][a-z0-9-]{0,39}$'
    $items = @($decisions)
    $seen = @()
    for ($i = 0; $i -lt $items.Count; $i++) {
        $d = $items[$i]
        if ($d -isnot [hashtable]) { $errors.Add("decisions[$i] must be an object"); continue }
        if ([string]$d.id -notmatch $idPattern) { $errors.Add("decisions[$i].id must be a lowercase slug such as 'storage-owner'") }
        elseif ($seen -contains $d.id) { $errors.Add("decisions[$i].id duplicates an earlier decision") }
        else { $seen += $d.id }
        if (Blank $d.question) { $errors.Add("decisions[$i].question is required") }
        if (Blank $d.context) { $errors.Add("decisions[$i].context must explain the relevant facts and why a decision is needed") }
        $options = @($d.options)
        if ($d.options -isnot [array] -or $options.Count -lt 2) { $errors.Add("decisions[$i].options needs at least two suggested paths"); continue }
        $optionIds = @()
        for ($j = 0; $j -lt $options.Count; $j++) {
            $o = $options[$j]
            if ($o -isnot [hashtable]) { $errors.Add("decisions[$i].options[$j] must be an object"); continue }
            if ([string]$o.id -notmatch $idPattern) { $errors.Add("decisions[$i].options[$j].id must be a lowercase slug such as 'keep-local'") }
            elseif ($optionIds -contains $o.id) { $errors.Add("decisions[$i].options[$j].id duplicates an earlier option") }
            else { $optionIds += $o.id }
            if (Blank $o.label) { $errors.Add("decisions[$i].options[$j].label is required") }
            if (Blank $o.summary) { $errors.Add("decisions[$i].options[$j].summary must explain what choosing this path means") }
        }
        if (-not $d.ContainsKey('recommendedOptionId') -or $optionIds -notcontains $d.recommendedOptionId) { $errors.Add("decisions[$i].recommendedOptionId must match an option id") }
    }
}
if (-not $errors.Count -and $result.ContainsKey('decisions') -and $Kind -in 'intake', 'plan', 'investigation') { Test-Decisions $result.decisions }

if ($Kind -eq 'implementation' -and $result.status -eq 'incomplete' -and (Blank $result.incompleteReason)) {
    $errors.Add('incomplete result requires incompleteReason')
}

if (-not $errors.Count) {
    switch ($Kind) {
        'intake' {
            # A genuine unanswered question is a valid intake outcome; the router
            # sends it to factory:needs-help instead of silently planning it.
            if (-not (Blank $result.unresolvedQuestions) -and -not @($result.decisions | Where-Object { $_ }).Count) { $errors.Add('unresolvedQuestions requires structured decisions with context, options, and a recommendation') }
        }
        'plan' {
            if ($result.readyNotReadyStatus -eq 'not-ready' -and -not @($result.decisions | Where-Object { $_ }).Count) { $errors.Add('not-ready plans require structured decisions with context, options, and a recommendation') }
            if ($result.readyNotReadyStatus -eq 'decomposed') {
                $policies = Join-Path $SchemaDir '../policies'
                $labelText = Get-Content -Raw (Join-Path $policies 'labels.yaml')
                $maxSub = if ((Get-Content -Raw (Join-Path $policies 'retry.yaml')) -match 'max_sub_issues:\s*(\d+)') { [int]$Matches[1] } else { 40 }
                $subs = @($result.subIssues)
                if (-not $result.ContainsKey('subIssues') -or $subs.Count -eq 0) { $errors.Add('status is decomposed but subIssues is empty') }
                elseif ($subs.Count -gt $maxSub) { $errors.Add("subIssues has $($subs.Count) entries; the limit is $maxSub (group related work or split across passes)") }
                else {
                    if (-not (Blank $result.unresolvedQuestions)) { $errors.Add('status is decomposed but unresolvedQuestions is not empty') }
                    $titles = @()
                    for ($i = 0; $i -lt $subs.Count; $i++) {
                        $sub = $subs[$i]
                        if ($sub -isnot [hashtable]) { $errors.Add("subIssues[$i] must be an object"); continue }
                        foreach ($k in 'title', 'body', 'type', 'risk', 'complexity') { if (-not $sub.ContainsKey($k) -or (Blank $sub[$k])) { $errors.Add("subIssues[$i].$k is required") } }
                        if ($sub.type -and $labelText -notmatch "(?m)^\s+-\s+$([regex]::Escape([string]$sub.type))\s*$") { $errors.Add("subIssues[$i].type is not a known type label") }
                        if ($sub.risk -and $labelText -notmatch "(?m)^\s+-\s+$([regex]::Escape([string]$sub.risk))\s*$") { $errors.Add("subIssues[$i].risk is not a known risk label") }
                        if ($sub.complexity -and $labelText -notmatch "(?m)^\s+-\s+$([regex]::Escape([string]$sub.complexity))\s*$") { $errors.Add("subIssues[$i].complexity is not a known complexity label") }
                        if ($sub.title) { if ($titles -contains $sub.title) { $errors.Add("subIssues[$i].title duplicates an earlier title") }; $titles += $sub.title }
                        if ($sub.ContainsKey('dependsOn')) { foreach ($d in @($sub.dependsOn)) { if ($d -isnot [int] -and $d -isnot [long] -or $d -lt 0 -or $d -ge $subs.Count -or $d -eq $i) { $errors.Add("subIssues[$i].dependsOn has invalid index '$d'") } } }
                    }
                }
            }
            if ($result.readyNotReadyStatus -notin 'ready', 'decomposed' -and (Blank $result.unresolvedQuestions) -and -not @($result.decisions | Where-Object { $_ }).Count) {
                $errors.Add('status is not ready but neither unresolvedQuestions nor decisions says what must be answered')
            }
            if ($result.readyNotReadyStatus -eq 'ready') {
                # Definition of Ready: no unresolved blocking questions, criteria and breakdown present.
                if (-not (Blank $result.unresolvedQuestions)) { $errors.Add('status is ready but unresolvedQuestions is not empty') }
                if (Blank $result.suggestedWorkBreakdown) { $errors.Add('status is ready but suggestedWorkBreakdown is empty') }
                if (Blank $result.risks) { $errors.Add('status is ready but risks is empty (write "none identified" explicitly if true)') }
            }
        }
        'implementation' {
            if ($result.status -eq 'success') {
                if ((Normalized-Outcome $result.testResult) -ne 'passed') { $errors.Add('status is success but testResult is not passed') }
                if (-not (Substantive-List $result.testsRun)) { $errors.Add('status is success but testsRun has no substantive test names') }
                if (-not (Substantive-List $result.filesChanged)) { $errors.Add('status is success but filesChanged has no substantive paths') }
                if (-not (Acceptance-Met $result.acceptanceCriteriaStatus)) { $errors.Add('status is success but acceptanceCriteriaStatus is not met') }
                if (-not $result.ContainsKey('pr') -or -not (Qualified-PrUrl $result.pr)) { $errors.Add('status is success but pr is not a qualified GitHub pull URL') }
            }
        }
        'review' {
            if ($result.approvalChangeRequestStatus -eq 'change-request' -and (Blank $result.blockingFindings)) { $errors.Add('change-request requires blockingFindings') }
            if ($result.approvalChangeRequestStatus -eq 'approval' -and -not (Blank $result.blockingFindings)) { $errors.Add('approval must not carry blockingFindings') }
            if (-not (Qualified-PrUrl $result.pr)) { $errors.Add('review result requires a qualified GitHub PR URL') }
            if ([string]$result.reviewedHeadSha -notmatch '^[0-9a-fA-F]{40}$') { $errors.Add('reviewedHeadSha must be the 40-character PR head SHA') }
            if (Blank $result.reviewerIdentity) { $errors.Add('reviewerIdentity must identify the independent reviewer') }
        }
        'investigation' {
            $allowed = 'implementation', 'test', 'flaky-test', 'environment', 'dependency', 'merge-conflict', 'requirements', 'architecture', 'unknown'
            if ($allowed -notcontains $result.failureClassification) { $errors.Add("failureClassification must be one of: $($allowed -join ', ')") }
        }
    }
}
Done
