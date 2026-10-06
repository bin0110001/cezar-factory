#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('classify-issue','summarize-issue','recommend-work-type','recommend-risk','extract-acceptance-criteria','normalize-test-result','summarize-logs','summarize-diff','draft-pr-summary','extract-memory-candidates')][string]$Job,
    [Parameter(Mandatory)][string]$InputPath,
    [string]$OutputPath,
    [string]$ApiUrl = $(if ($env:LITELLM_URL) { "$($env:LITELLM_URL.TrimEnd('/'))/v1/chat/completions" } else { 'http://127.0.0.1:4000/v1/chat/completions' }),
    [string]$ApiKey = $env:LITELLM_MASTER_KEY,
    [string]$Model = $(if ($env:FACTORY_LOCAL_MODEL) { $env:FACTORY_LOCAL_MODEL } else { 'factory-small' }),
    [int]$MaxChars = 12000
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $InputPath)) { throw "input not found: $InputPath" }
if ($MaxChars -lt 100 -or $MaxChars -gt 50000) { throw 'MaxChars must be between 100 and 50000' }

$prompts = @{
    'classify-issue' = 'Return JSON with type and risk labels for this issue.'
    'summarize-issue' = 'Return JSON with a concise summary, objective, dependencies, and risks.'
    'recommend-work-type' = 'Return JSON with the recommended type label and rationale.'
    'recommend-risk' = 'Return JSON with the recommended risk label and rationale.'
    'extract-acceptance-criteria' = 'Return JSON with an array of concrete, testable acceptance criteria.'
    'normalize-test-result' = 'Return compact JSON with status, passed, failed, and exact failure sections.'
    'summarize-logs' = 'Return JSON with a concise failure summary, evidence, and artifact references.'
    'summarize-diff' = 'Return JSON with changed areas, risk observations, and a concise diff summary.'
    'draft-pr-summary' = 'Return JSON with a concise pull-request summary and validation summary.'
    'extract-memory-candidates' = 'Return JSON with durable knowledge candidates only; exclude transcripts, source files, raw logs, and temporary state.'
}
$raw = Get-Content -Raw $InputPath
$context = if ($raw.Length -gt $MaxChars) { $raw.Substring(0, $MaxChars) + "`n[context truncated]" } else { $raw }
$body = @{
    model = $Model
    temperature = 0
    response_format = @{ type = 'json_object' }
    messages = @(
        @{ role = 'system'; content = "You are the Factory bounded local utility worker. $($prompts[$Job]) Do not edit files or invent evidence." },
        @{ role = 'user'; content = $context }
    )
} | ConvertTo-Json -Depth 10
$headers = @{ 'Content-Type' = 'application/json' }
if ($ApiKey) { $headers.Authorization = "Bearer $ApiKey" }
$response = Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers $headers -Body $body
$content = $response.choices[0].message.content
$result = [ordered]@{
    status = 'success'
    job = $Job
    model = $Model
    endpoint = ($ApiUrl -replace '/v1/chat/completions$','')
    result = ($content | ConvertFrom-Json)
    usage = $response.usage
}
if ($OutputPath) {
    $result | ConvertTo-Json -Depth 12 | Set-Content -Path $OutputPath -Encoding utf8
} else {
    $result | ConvertTo-Json -Depth 12
}
