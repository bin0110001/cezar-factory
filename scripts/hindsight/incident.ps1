[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('enqueue', 'flush', 'recall')][string]$Action, [string]$Project = $env:FACTORY_PROJECT_ID, [string]$Bank = $env:HINDSIGHT_PROJECT_BANK, [string]$EventPath = '', [string]$Query = '', [string]$OutputPath = '.factory/context/incident-memory.json')
$ErrorActionPreference = 'Stop'
# Optional advisory memory: never fails a run, never gates anything.
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
if (-not $Project) { $Project = (Split-Path -Leaf (Get-Location)) }
$python = Get-Command python3 -ErrorAction SilentlyContinue; if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $python) { Write-Warning 'Python runtime unavailable; incident memory skipped.'; exit 0 }
$arguments = @((Join-Path $PSScriptRoot 'incident.py'), $Action, '--project', $Project, '--output', $OutputPath)
if ($Bank) { $arguments += @('--bank', $Bank) }
if ($Action -eq 'enqueue') { $arguments += @('--event', $EventPath) }
if ($Action -eq 'recall') { $arguments += @('--query', $Query) }
& $python.Source @arguments
exit 0
