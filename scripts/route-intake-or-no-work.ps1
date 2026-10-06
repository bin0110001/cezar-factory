#!/usr/bin/env pwsh
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
$result = Get-Content -Raw $Path | ConvertFrom-Json
if ($result.noWork -eq $true) { '{"status":"no-work"}' ; exit 0 }
& "$PSScriptRoot/route-state.ps1" -Event intake-result -Path $Path
exit $LASTEXITCODE
