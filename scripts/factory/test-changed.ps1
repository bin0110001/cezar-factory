#!/usr/bin/env pwsh
[CmdletBinding()]
param([switch]$Verbose, [switch]$Quiet)

# Backward-compatible workflow entrypoint. Selection and execution are fully
# owned by the project's declared validation.targeted command.
$runner = Join-Path $PSScriptRoot 'run-verification.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    Write-Output (@{ status = 'unavailable'; level = 'targeted'; reason = 'verification_runner_missing' } | ConvertTo-Json -Compress)
    exit 4
}
& $runner -Level targeted -Quiet:$Quiet
exit $LASTEXITCODE
