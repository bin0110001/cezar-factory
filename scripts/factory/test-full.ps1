#!/usr/bin/env pwsh
[CmdletBinding()]
param([switch]$Verbose, [switch]$Quiet)

# Backward-compatible workflow entrypoint. Full suite execution must be
# declared by the project; this script does not discover test files.
$runner = Join-Path $PSScriptRoot 'run-verification.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    Write-Output (@{ status = 'unavailable'; level = 'full'; reason = 'verification_runner_missing' } | ConvertTo-Json -Compress)
    exit 4
}
& $runner -Level full -Quiet:$Quiet
exit $LASTEXITCODE
