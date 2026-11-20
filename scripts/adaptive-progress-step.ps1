#!/usr/bin/env pwsh
# Run the pure progress evaluator for one adaptive-repair observation history.
[CmdletBinding()]
param(
    [string]$InputPath = '.factory/verification-checks.json',
    [string]$OutputPath = '.factory/progress-evaluation.json',
    [string]$EvaluatorPath = (Join-Path $PSScriptRoot 'release/progress_evaluator.py')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { throw "Adaptive repair input not found: $InputPath" }
$data = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json -Depth 20
$history = @($data.history)
if (-not $history.Count) { throw 'Adaptive repair history must contain the current observation.' }
$payload = [ordered]@{ history = $history; accepted_fingerprints = @() } | ConvertTo-Json -Depth 20 -Compress
$temp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($temp, $payload, [Text.UTF8Encoding]::new($false))
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command python3 -ErrorAction Stop }
    $code = "import json,sys; from pathlib import Path; sys.path.insert(0, str(Path(r'$((Resolve-Path $EvaluatorPath).Path)').parent)); import progress_evaluator; d=json.load(open(r'$temp', encoding='utf-8')); print(json.dumps(progress_evaluator.evaluate(d['history'], d.get('accepted_fingerprints', []))))"
    $output = & $python.Source -c $code 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Progress evaluator failed ($LASTEXITCODE): $($output -join "`n")" }
    $null = $output -join "`n" | ConvertFrom-Json -Depth 20
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))) -Force | Out-Null
    Set-Content -LiteralPath $OutputPath -Value ($output -join "`n") -Encoding utf8
    Write-Output "adaptive-progress: classification=$((($output -join "`n") | ConvertFrom-Json).classification)"
} finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
