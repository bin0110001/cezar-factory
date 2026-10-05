[CmdletBinding()]
param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Bank, [Parameter(Mandatory)][string]$CandidatePath, [switch]$Approved, [string]$Workflow = '', [string]$Issue = '', [string]$Worker = '', [string]$Model = '', [string]$OutputPath = '.factory/context/memory-retention-receipt.json')
$ErrorActionPreference = 'Stop'
$python = Get-Command python3 -ErrorAction SilentlyContinue; if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $python) {
    $parent = Split-Path -Parent $OutputPath; if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [ordered]@{ status = 'unavailable'; reason = 'Python runtime unavailable; no retention attempted.' } | ConvertTo-Json | Set-Content -NoNewline $OutputPath
    Write-Warning 'Python runtime unavailable; no retention attempted.'
    exit 0
}
$arguments = @((Join-Path $PSScriptRoot 'client.py'),'retain','--project',$Project,'--bank',$Bank,'--candidate',$CandidatePath,'--workflow',$Workflow,'--issue',$Issue,'--worker',$Worker,'--model',$Model,'--output',$OutputPath)
if ($Approved) { $arguments += '--approved' }; & $python.Source @arguments; exit $LASTEXITCODE
