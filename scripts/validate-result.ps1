#!/usr/bin/env pwsh
<#
.SYNOPSIS
Validate an agent result file against its factory schema plus the policy rules the schema cannot express.
.DESCRIPTION
Kinds: plan, implementation, review, investigation. Prints one compact JSON line and exits 1 for an
invalid agent result or 10 for missing/unreadable validator policy or unreadable result files.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('intake', 'plan', 'implementation', 'review', 'investigation')][string]$Kind,
    [Parameter(Mandatory)][string]$Path,
    [string]$Task,
    [string]$SchemaDir = (Join-Path $PSScriptRoot '../schemas')
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
# Already-resolved issue (see check-already-resolved.ps1): nothing to do.
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }

$schemaFile = @{ intake = 'intake-result.schema.json'; plan = 'plan.schema.json'; implementation = 'implementation-result.schema.json'; review = 'review-result.schema.json'; investigation = 'investigation-result.schema.json' }[$Kind]
$errors = [System.Collections.Generic.List[string]]::new()

function Done {
    $status = if ($errors.Count) { 'invalid' } else { 'valid' }
    ([ordered]@{ status = $status; kind = $Kind; errors = @($errors) } | ConvertTo-Json -Compress -Depth 4) | Write-Output
    exit $(if ($errors.Count) { 1 } else { 0 })
}

function ConfigurationFailure([string]$Message) {
    ([ordered]@{ status = 'error'; reasonCode = 'configuration'; message = $Message } | ConvertTo-Json -Compress) | Write-Output
    exit 10
}

if (-not (Test-Path $Path)) { $errors.Add("result file not found: $Path"); Done }
try { $rawResult = Get-Content -Raw $Path } catch { ConfigurationFailure "could not read result file: $Path" }
try { $result = $rawResult | ConvertFrom-Json -AsHashtable } catch { $errors.Add("not valid JSON: $($_.Exception.Message)"); Done }
if ($result -isnot [hashtable]) { $errors.Add('result must be a JSON object'); Done }
if ($Kind -in @('plan', 'investigation')) {
    if ($Task -notmatch 'GitHub issue #(\d+)|/issues/(\d+)|#(\d+)') { ConfigurationFailure "$Kind validation requires the workflow-selected issue through -Task." }
    $result.issue = [int](($Matches[1], $Matches[2], $Matches[3]) | Where-Object { $_ } | Select-Object -First 1)
    $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
}
$resolvedSchemaPath = Join-Path $SchemaDir $schemaFile
if (-not (Test-Path $resolvedSchemaPath)) { ConfigurationFailure "result schema is missing: $resolvedSchemaPath" }
try { $schema = Get-Content -Raw $resolvedSchemaPath | ConvertFrom-Json -AsHashtable } catch { ConfigurationFailure "result schema is unreadable or invalid: $resolvedSchemaPath" }

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

if (-not $errors.Count) {
    switch ($Kind) {
        'intake' {
            # A genuine unanswered question is a valid intake outcome; the router
            # sends it to factory:needs-help instead of silently planning it.
        }
        'plan' {
            if ($result.readyNotReadyStatus -eq 'decomposed') {
                $policies = Join-Path $SchemaDir '../policies'
                $labelsPath = Join-Path $policies 'labels.yaml'
                $retryPolicyPath = Join-Path $policies 'retry.yaml'
                if (-not (Test-Path $labelsPath) -or -not (Test-Path $retryPolicyPath)) { ConfigurationFailure "plan validation policy files are missing under $policies" }
                try {
                    $labelText = Get-Content -Raw $labelsPath
                    $retryPolicy = Get-Content -Raw $retryPolicyPath
                } catch { ConfigurationFailure "plan validation policies are unreadable under $policies" }
                $maxSub = if ($retryPolicy -match 'max_sub_issues:\s*(\d+)') { [int]$Matches[1] } else { 40 }
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
                        if ($sub.type -and $labelText -notmatch "(?m)^\s+-\s+$([regex]::Escape([string]$sub.type))\s*$") { $errors.Add("subIssues[$i].type '$($sub.type)' is not a known label (e.g. type:feature)") }
                        if ($sub.risk -and $labelText -notmatch "(?m)^\s+-\s+$([regex]::Escape([string]$sub.risk))\s*$") { $errors.Add("subIssues[$i].risk '$($sub.risk)' is not a known label (e.g. risk:medium)") }
                        if ($sub.complexity -and $labelText -notmatch "(?m)^\s+-\s+$([regex]::Escape([string]$sub.complexity))\s*$") { $errors.Add("subIssues[$i].complexity '$($sub.complexity)' is not a known label (e.g. complexity:medium)") }
                        if ($sub.title) { if ($titles -contains $sub.title) { $errors.Add("subIssues[$i].title duplicates an earlier title") }; $titles += $sub.title }
                        if ($sub.ContainsKey('dependsOn')) { foreach ($d in @($sub.dependsOn)) { if ($d -isnot [int] -and $d -isnot [long] -or $d -lt 0 -or $d -ge $subs.Count -or $d -eq $i) { $errors.Add("subIssues[$i].dependsOn has invalid index '$d'") } } }
                    }
                }
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
