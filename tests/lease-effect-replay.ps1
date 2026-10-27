#!/usr/bin/env pwsh
param()
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$leaseScript = Join-Path $factory 'scripts/lease.ps1'
$fakeGh = Join-Path $PSScriptRoot 'fake-gh.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("factory-lease-replay-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $temp | Out-Null
$env:FAKE_GH_STATE = Join-Path $temp 'state.json'
$script:failures = 0

function Assert([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" }
    else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:failures++ }
}
function Set-State($State) { $State | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $env:FAKE_GH_STATE }
function Get-State { Get-Content -LiteralPath $env:FAKE_GH_STATE -Raw | ConvertFrom-Json -DateKind String }
function Invoke-Lease([string]$Action, [string]$Owner = '') {
    $argv = @('-NoProfile', '-File', $leaseScript, '-Action', $Action, '-Issue', '7', '-GhCommand', $fakeGh)
    if ($Owner) { $argv += @('-Owner', $Owner) }
    $output = & pwsh @argv *>&1 | Out-String
    [pscustomobject]@{ code = $LASTEXITCODE; output = $output }
}
function Read-Action([string]$Body) {
    $match = [regex]::Match($Body, '<!-- factory:effect-action:v1:([A-Za-z0-9+/=]+) -->')
    if (-not $match.Success) { return $null }
    try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Groups[1].Value)) | ConvertFrom-Json -DateKind String }
    catch { return $null }
}

try {
    Set-State @{ labels=@('factory:ready'); comments=@(); updatedAt='2026-10-25T00:00:00.0000000Z'; prMerged=$false; prs=@(); failNextCommentAfterWrite=$true }
    $create = Invoke-Lease 'create' 'worker-a'
    $afterCreate = Get-State
    $createComment = [string]@($afterCreate.comments | Where-Object { $_ -match 'factory-lease:7' })[0]
    $createAction = Read-Action $createComment
    Assert 'lost create response reconciles from a schema-valid durable action receipt' ($create.code -eq 0 -and @($afterCreate.comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 1 -and $createAction.operation -eq 'github.issue.add_comment' -and $createAction.operationKey -match '^factory:lease:create:7:' -and $createAction.arguments.bodySha256 -match '^[a-f0-9]{64}$' -and (Test-Json -Json ($createAction | ConvertTo-Json -Compress -Depth 6) -SchemaFile (Join-Path $factory 'schemas/workflow-effect-action.schema.json')))

    $sameOwner = Invoke-Lease 'create' 'worker-a'
    Assert 'same-owner create replay does not add a comment' ($sameOwner.code -eq 0 -and @( (Get-State).comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 1)
    $collision = Invoke-Lease 'create' 'worker-b'
    Assert 'active lease collision is refused' ($collision.code -ne 0 -and @( (Get-State).comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 1)

    $release = Invoke-Lease 'release'
    $afterRelease = Get-State
    $releaseComment = [string]@($afterRelease.comments | Where-Object { $_ -match 'factory-lease:7' })[-1]
    $releaseAction = Read-Action $releaseComment
    Assert 'release receipt carries the current ISO revision and satisfies the shared schema' ($release.code -eq 0 -and $releaseAction.rationale -eq 'lease release' -and $releaseAction.expectedRevision -match '^2026-' -and (Test-Json -Json ($releaseAction | ConvertTo-Json -Compress -Depth 6) -SchemaFile (Join-Path $factory 'schemas/workflow-effect-action.schema.json')))
    $releaseReplay = Invoke-Lease 'release'
    Assert 'release replay does not add another comment' ($releaseReplay.code -eq 0 -and @( (Get-State).comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 2)

    Set-State @{ labels=@('factory:ready'); comments=@(); updatedAt='2026-10-25T00:00:00.0000000Z'; prMerged=$false; prs=@(); changeIssueAfterView=2; issueViewCount=0 }
    $revisionRace = Invoke-Lease 'create' 'worker-race'
    Assert 'lease write fails closed when issue revision changes before commit' ($revisionRace.code -ne 0 -and @( (Get-State).comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 0)
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures) { Write-Host "FAILED: $script:failures lease assertion(s)" -ForegroundColor Red; exit 1 }
Write-Host 'Lease effect replay tests passed.'
