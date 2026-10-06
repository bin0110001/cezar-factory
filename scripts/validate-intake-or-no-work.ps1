#!/usr/bin/env pwsh
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
$result = Get-Content -Raw $Path | ConvertFrom-Json
if ($result.noWork -eq $true) { '{"status":"valid","kind":"intake","errors":[]}' ; exit 0 }
& "$PSScriptRoot/validate-result.ps1" -Kind intake -Path $Path
exit $LASTEXITCODE
