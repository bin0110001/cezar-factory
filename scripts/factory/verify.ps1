#!/usr/bin/env pwsh
param([switch]$Verbose, [switch]$Quiet, [string]$Task = '')
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
. (Join-Path $PSScriptRoot '../lib.ps1')
exit (Invoke-FactoryValidation -Stage verify -WrapperPath $PSCommandPath -Task $Task -Quiet:$Quiet)
