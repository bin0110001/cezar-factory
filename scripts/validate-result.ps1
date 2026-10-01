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
    [Parameter(Mandatory)][ValidateSet('plan', 'implementation', 'review', 'investigation')][string]$Kind,
    [Parameter(Mandatory)][string]$Path,
    [string]$SchemaDir = (Join-Path $PSScriptRoot '../schemas')
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$schemaFile = @{ plan = 'plan.schema.json'; implementation = 'implementation-result.schema.json'; review = 'review-result.schema.json'; investigation = 'investigation-result.schema.json' }[$Kind]
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
        'plan' {
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
