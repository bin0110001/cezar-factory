#!/usr/bin/env pwsh
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InputPath, [Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$selected = Get-Content -Raw $InputPath | ConvertFrom-Json
$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
if ($null -eq $selected.issue) {
    [ordered]@{ noWork = $true; issue = $null; type = 'type:maintenance'; risk = 'risk:low'; summary = 'No eligible Factory issue was available for intake.'; unresolvedQuestions = '' } |
        ConvertTo-Json -Depth 5 | Set-Content -NoNewline $OutputPath
    exit 0
}
$title = [string]$selected.title
$body = [string]$selected.body
$labels = @($selected.labels)
$type = @('type:bug','type:feature','type:refactor','type:test','type:docs','type:maintenance') | Where-Object { $labels -contains $_ } | Select-Object -First 1
if (-not $type) { $type = if (($title + ' ' + $body) -match '(?i)failure|validation|workflow|automation|skill') { 'type:maintenance' } else { 'type:feature' } }
$risk = @('risk:high','risk:medium','risk:low') | Where-Object { $labels -contains $_ } | Select-Object -First 1
if (-not $risk) { $risk = if (($title + ' ' + $body) -match '(?i)security|credential|data loss|production') { 'risk:high' } elseif (($title + ' ' + $body) -match '(?i)failure|validation|workflow|automation') { 'risk:medium' } else { 'risk:low' } }
$summary = (($title -replace '\s+', ' ').Trim())
[ordered]@{ noWork = $false; issue = [int]$selected.issue; type = $type; risk = $risk; summary = $summary; unresolvedQuestions = '' } |
    ConvertTo-Json -Depth 5 | Set-Content -NoNewline $OutputPath
