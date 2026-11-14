<#
.SYNOPSIS
  Builds the versioned, redacted historical coding-run dataset (#137). Read-only analysis.
.DESCRIPTION
  Reads run records (JSON array or JSONL) and optional routing events (JSONL, schemas/routing-event.schema.json),
  keeps allow-listed fields only (never prompts, source, logs or credentials), joins events to runs by runId,
  and writes a dataset with deterministic ordering. Missing telemetry is the string 'unknown', never estimated.
  The same input always produces byte-identical output (no timestamps are written).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RunsPath,
    [string]$EventsPath,
    [Parameter(Mandatory)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
$unknown = 'unknown'
$secret = '(?i)(bearer\s+\S+|basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|(key|token|secret|password)\s*[=:]\s*\S+)'

function Read-Records([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Input not found: $Path" }
    $raw = [IO.File]::ReadAllText($Path).Trim()
    if (-not $raw) { return @() }
    if ($raw.StartsWith('[')) { return @($raw | ConvertFrom-Json) }
    @($raw -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $null -ne $_ })
}
function Get-Prop($Obj, [string]$Name) { if ($null -ne $Obj -and $Obj.PSObject.Properties.Name -contains $Name) { $Obj.$Name } else { $null } }
function Safe-Text($Value, [int]$Max = 64) {
    if ($null -eq $Value -or "$Value" -eq '') { return $unknown }
    $s = [string]$Value
    if ($s -match $secret) { return '[redacted]' }
    if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max) }
    $s
}
function Safe-Number($Value, [bool]$Int = $false) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [bool] -or $Value -lt 0) { return $unknown }
    if ($Int) { [int64]$Value } else { [double]$Value }
}
function Safe-Bool($Value) { if ($Value -is [bool]) { $Value } else { $unknown } }

$events = @{}
if ($EventsPath) {
    foreach ($e in (Read-Records $EventsPath)) {
        $id = Get-Prop $e 'runId'
        if (-not $id) { continue }
        if (-not $events.ContainsKey($id)) { $events[$id] = New-Object System.Collections.ArrayList }
        [void]$events[$id].Add($e)
    }
}

$records = foreach ($run in (Read-Records $RunsPath)) {
    $runId = Get-Prop $run 'runId'
    if (-not $runId) { continue }
    $evs = if ($events.ContainsKey($runId)) { @($events[$runId] | Sort-Object { [int](Get-Prop $_ 'sequence') }) } else { @() }
    $routed = @($evs | Where-Object { Get-Prop $_ 'selected' } | Select-Object -Last 1)
    $sel = if ($routed.Count) { $routed[0].selected } else { $null }
    $model = Get-Prop $run 'model'; if (-not $model) { $model = Get-Prop $sel 'model' }
    $tier = Get-Prop $run 'tier'; if (-not $tier) { $tier = Get-Prop $sel 'tier' }
    $alias = Get-Prop $run 'subscriptionAlias'; if (-not $alias) { $alias = Get-Prop $sel 'subscriptionAlias' }
    $attempts = Get-Prop $run 'attempts'
    if ($null -eq $attempts -and $evs.Count) { $attempts = ($evs | ForEach-Object { [int](Get-Prop $_ 'attempt') } | Measure-Object -Maximum).Maximum }
    $family = Get-Prop $run 'modelFamily'
    [ordered]@{
        runId             = Safe-Text $runId 128
        category          = Safe-Text (Get-Prop $run 'category')
        modelFamily       = Safe-Text $family
        model             = Safe-Text $model 128
        tier              = Safe-Text $tier
        subscriptionAlias = Safe-Text $alias 128
        attempts          = Safe-Number $attempts $true
        durationSeconds   = Safe-Number (Get-Prop $run 'durationSeconds')
        validationPassed  = Safe-Bool (Get-Prop $run 'validationPassed')
        accepted          = Safe-Bool (Get-Prop $run 'accepted')
        merged            = Safe-Bool (Get-Prop $run 'merged')
        inputTokens       = Safe-Number (Get-Prop $run 'inputTokens') $true
        outputTokens      = Safe-Number (Get-Prop $run 'outputTokens') $true
        costUsd           = Safe-Number (Get-Prop $run 'costUsd')
        routingEvents     = $evs.Count
        fallbackUsed      = if ($evs.Count) { [bool](@($evs | Where-Object { (Get-Prop $_ 'fallback') -eq $true }).Count) } else { $unknown }
    }
}
$sorted = @($records | Sort-Object { $_.runId } -CaseSensitive)
$dataset = [ordered]@{
    schemaVersion = 1
    unknownMarker = $unknown
    recordCount   = $sorted.Count
    records       = $sorted
}
$json = ($dataset | ConvertTo-Json -Depth 6) -replace "`r`n", "`n"
$parent = Split-Path -Parent $OutPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[IO.File]::WriteAllText($OutPath, $json + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Wrote $($sorted.Count) record(s) to $OutPath"
