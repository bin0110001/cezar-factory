#!/usr/bin/env pwsh
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
# Already-resolved issue (see check-already-resolved.ps1): nothing to do.
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
$result = Get-Content -Raw $Path | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$result.complexity) -or @('complexity:small','complexity:medium','complexity:large') -notcontains [string]$result.complexity) {
    $result | Add-Member -NotePropertyName complexity -NotePropertyValue 'complexity:medium' -Force
    $result | ConvertTo-Json -Depth 12 | Set-Content -NoNewline $Path
}
& "$PSScriptRoot/route-state.ps1" -Event plan-result -Path $Path
exit $LASTEXITCODE
