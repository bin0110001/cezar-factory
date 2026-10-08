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

function Done {
    $status = if ($errors.Count) { 'invalid' } else { 'valid' }
    ([ordered]@{ status = $status; kind = $Kind; errors = @($errors) } | ConvertTo-Json -Compress -Depth 4) | Write-Output
    exit $(if ($errors.Count) { 1 } else { 0 })
}

if (-not (Test-Path $Path)) { $errors.Add("result file not found: $Path"); Done }
try { $result = Get-Content -Raw $Path | ConvertFrom-Json -AsHashtable } catch { $errors.Add("not valid JSON: $($_.Exception.Message)"); Done }
if ($result -isnot [hashtable]) { $errors.Add('result must be a JSON object'); Done }
$schema = Get-Content -Raw (Join-Path $SchemaDir $schemaFile) | ConvertFrom-Json -AsHashtable

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

if (-not $errors.Count) {
    switch ($Kind) {
        'intake' {
            # A genuine unanswered question is a valid intake outcome; the router
            # sends it to factory:needs-help instead of silently planning it.
        }
        'plan' {
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
                if (Blank $result.testResult) { $errors.Add('status is success but testResult is empty') }
                if (-not $result.ContainsKey('pr') -or (Blank $result.pr)) { $errors.Add('status is success but pr (PR URL) is missing') }
                if (@($result.filesChanged).Count -eq 0) { $errors.Add('status is success but filesChanged is empty') }
                if (Blank $result.acceptanceCriteriaStatus) { $errors.Add('status is success but acceptanceCriteriaStatus is empty') }
            }
        }
        'review' {
            if ($result.approvalChangeRequestStatus -eq 'change-request' -and (Blank $result.blockingFindings)) { $errors.Add('change-request requires blockingFindings') }
            if ($result.approvalChangeRequestStatus -eq 'approval' -and -not (Blank $result.blockingFindings)) { $errors.Add('approval must not carry blockingFindings') }
        }
        'investigation' {
            $allowed = 'implementation', 'test', 'flaky-test', 'environment', 'dependency', 'merge-conflict', 'requirements', 'architecture', 'unknown'
            if ($allowed -notcontains $result.failureClassification) { $errors.Add("failureClassification must be one of: $($allowed -join ', ')") }
        }
    }
}
Done
