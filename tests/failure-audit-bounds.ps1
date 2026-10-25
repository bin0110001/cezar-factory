#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$project = Join-Path ([IO.Path]::GetTempPath()) "registered-project-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$worktree = Join-Path $project '.ai/cezar/worktrees/test-run'
$runs = Join-Path $project '.ai/cezar/runs'
$output = Join-Path $project '.factory/failure-audit-input.json'
$failures = 0
function Check([string]$name, [bool]$condition) {
    if ($condition) { Write-Host "  ok   $name" }
    else { Write-Host "  FAIL $name"; $script:failures++ }
}
function Collect($extra = @()) {
    $arguments = @('-NoProfile', '-File', (Join-Path $factory 'scripts/audit-factory-failures.ps1'), '-ProjectPath', $project, '-OutputPath', $output) + @($extra)
    $old = $ErrorActionPreference
    Push-Location $worktree
    try { $ErrorActionPreference = 'Continue'; $text = & pwsh @arguments 2>&1 | Out-String }
    finally { $code = $LASTEXITCODE; Pop-Location; $ErrorActionPreference = $old }
    $record = if (Test-Path $output) { Get-Content -Raw $output | ConvertFrom-Json } else { $null }
    [pscustomobject]@{ code = $code; text = $text; record = $record }
}
try {
    New-Item -ItemType Directory -Path $runs -Force | Out-Null
    New-Item -ItemType Directory -Path $worktree -Force | Out-Null
    $token = 'ghp_abcdefghijklmnopqrstuvwxyz123456'
    Set-Content (Join-Path $runs 'run-one.handoff.md') "error Authorization: Bearer $token`nstep=collect command=test"
    Set-Content (Join-Path $runs 'run-one.ndjson') ('{"stepId":"collect","command":"echo token=' + $token + '","message":"error ' + ('x' * 130000) + '"}')
    $oldFile = Join-Path $runs 'old-run.handoff.md'
    Set-Content $oldFile 'error old run'
    (Get-Item $oldFile).LastWriteTimeUtc = [datetime]::UtcNow.AddDays(-3)
    $run = Collect
    if ($run.code -ne 0) { Write-Host $run.text }
    Check 'registered project identity derives from the Cezar worktree root' ($run.code -eq 0 -and $run.record.projectId -eq (Split-Path $project -Leaf))
    Check '24-hour window excludes old handoff' ($run.record.runsInspected -eq 1)
    Check 'oversized source limits coverage explicitly' ($run.record.status -eq 'limited' -and (@($run.record.limitations) -join ' ') -match 'truncated')
    Check 'collector never publishes or restarts' (-not $run.record.issueCreated -and -not $run.record.restarted)
    $serialized = $run.record | ConvertTo-Json -Depth 12
    Check 'secrets are redacted from the artifact' ($serialized -notmatch [regex]::Escape($token))
    $evidenceChars = @($run.record.failures | ForEach-Object { @($_.evidence) -join '' }) -join ''
    Check 'failure summaries and evidence obey budgets' (@($run.record.failures).Count -le 8 -and $evidenceChars.Length -le 12000)
    Check 'versioned artifact satisfies schema' (Test-Json -Json $serialized -SchemaFile (Join-Path $factory 'schemas/failure-audit-result.schema.json'))

    Set-Content (Join-Path $runs 'run-two.handoff.md') 'error second run'
    Set-Content (Join-Path $runs 'run-two.ndjson') '{"stepId":"install","command":"pwsh test.ps1 token=secretvalue123","message":"error second event"}'
    $run = Collect
    $structured = @($run.record.failures | Where-Object runId -eq 'run-two' | Select-Object -First 1)
    Check 'known run, step, and command survive redaction' ($structured.Count -eq 1 -and $structured[0].step -eq 'install' -and $structured[0].command -match 'pwsh test.ps1' -and $structured[0].command -notmatch 'secretvalue123')
    Set-Content (Join-Path $runs 'run-alpha.handoff.md') 'error workflow=factory-intake runId=abc123 at 2026-10-16T12:00:00Z'
    Set-Content (Join-Path $runs 'run-beta.handoff.md') 'error workflow=factory-intake runId=def456 at 2026-10-17T13:00:00Z'
    Set-Content (Join-Path $runs 'run-alpha.ndjson') ''
    Set-Content (Join-Path $runs 'run-beta.ndjson') ''
    $run = Collect
    $firstSignature = @($run.record.failures | Where-Object runId -eq 'run-alpha' | Select-Object -First 1)
    $secondSignature = @($run.record.failures | Where-Object runId -eq 'run-beta' | Select-Object -First 1)
    Check 'fingerprint ignores volatile run IDs and timestamps' ($firstSignature.Count -eq 1 -and $secondSignature.Count -eq 1 -and $firstSignature[0].fingerprint -eq $secondSignature[0].fingerprint)
    $run = Collect @('-MaxCandidates', '1')
    Check 'candidate discovery exhaustion is disclosed' ($run.record.status -eq 'limited' -and (@($run.record.limitations) -join ' ') -match 'discovery budget')
    Check 'scan and run counts are bounded' ($run.record.candidatesScanned -le 2 -and $run.record.runsInspected -le 1)

    Remove-Item $output
    $oldPreference = $ErrorActionPreference
    Push-Location $project
    try {
        $ErrorActionPreference = 'Continue'
        $text = & pwsh -NoProfile -File (Join-Path $factory 'scripts/audit-factory-failures.ps1') -ProjectPath $project -OutputPath $output 2>&1 | Out-String
        $missingIdentityCode = $LASTEXITCODE
    } finally { Pop-Location; $ErrorActionPreference = $oldPreference }
    Check 'project identity is not guessed outside a Cezar worktree' ($missingIdentityCode -ne 0 -and -not (Test-Path $output))
    $run = Collect @('-CreateIssue')
    Check 'collector rejects legacy mutation flags' ($run.code -ne 0 -and -not (Test-Path $output))

    Remove-Item -LiteralPath $runs -Recurse -Force
    $run = Collect
    Check 'missing run directory is limited, not complete' ($run.code -eq 0 -and $run.record.status -eq 'limited')
} finally {
    $resolvedProject = [IO.Path]::GetFullPath($project)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedProject.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedProject -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if ($failures) { exit 1 }
