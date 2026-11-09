#!/usr/bin/env pwsh
# Concise, deduplicated, redacted failure summary for agents (issue #103). Run from a workflow command: step.
# Input: JSON array (or {records:[...]}) of {findingId, identifier, message, detailPath, occurrence}.
param([Parameter(Mandatory)][string]$InputPath, [string]$OutputPath, [int]$MaxChars = 4000)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'failure-summary-lib.ps1')
$data = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
$records = if ($data -is [array]) { $data } elseif ($null -ne $data.records) { $data.records } else { @($data) }
$summary = New-FailureSummary -Records @($records) -MaxChars $MaxChars
$json = $summary | ConvertTo-Json -Depth 6
if ($OutputPath) { New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null; Set-Content -LiteralPath $OutputPath -Value $json } else { $json }
