#!/usr/bin/env pwsh
<##
.SYNOPSIS
Runs the Factory test suite with bounded recovery for transient PowerShell
child-process startup failures.

.DESCRIPTION
The test suite remains authoritative in run-tests.ps1. This wrapper exists for
operator and CI environments where launching a child pwsh can fail transiently.
It retries only launch exceptions; a test-suite exit code is returned
immediately so real assertion failures are not hidden by reruns.
##>
[CmdletBinding()]
param(
    [ValidateRange(1, 5)][int]$Attempts = 3,
    [ValidateRange(0, 60)][int]$DelaySeconds = 3,
    [string]$TestScript = (Join-Path $PSScriptRoot 'run-tests.ps1'),
    [string]$LogDirectory = ''
)

$ErrorActionPreference = 'Stop'
$testPath = (Resolve-Path -LiteralPath $TestScript -ErrorAction Stop).Path
if (-not $LogDirectory) {
    $LogDirectory = Join-Path ([IO.Path]::GetTempPath()) "cezar-factory-tests-$PID"
}
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $stdoutPath = Join-Path $LogDirectory "attempt-$attempt.stdout.log"
    $stderrPath = Join-Path $LogDirectory "attempt-$attempt.stderr.log"
    Write-Host "Factory tests: attempt $attempt/$Attempts"

    try {
        $process = Start-Process -FilePath 'pwsh' `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $testPath) `
            -WorkingDirectory (Split-Path -Parent $testPath) `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -NoNewWindow -Wait -PassThru -ErrorAction Stop
    }
    catch {
        "[$(Get-Date -Format o)] Child PowerShell launch failed: $($_.Exception.Message)" |
            Set-Content -LiteralPath $stderrPath -Encoding utf8
        $process = $null
    }

    if (Test-Path $stdoutPath) { Get-Content -LiteralPath $stdoutPath }
    if (Test-Path $stderrPath) {
        Get-Content -LiteralPath $stderrPath | ForEach-Object {
            Write-Host $_ -ForegroundColor Red
        }
    }

    if ($process -and $process.ExitCode -eq 0) {
        Write-Host "Factory tests passed. Logs: $LogDirectory"
        exit 0
    }

    if ($process) {
        Write-Host "Factory tests exited with code $($process.ExitCode). Logs: $LogDirectory" -ForegroundColor Yellow
        # Assertion and validation failures are deterministic; do not mask them
        # with a rerun. The wrapper's retry scope is launch instability only.
        exit $process.ExitCode
    }

    if ($attempt -lt $Attempts) {
        Start-Sleep -Seconds $DelaySeconds
    }
}

Write-Error "Unable to launch the Factory test suite after $Attempts attempts. Logs: $LogDirectory"
exit 125
