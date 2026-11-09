#!/usr/bin/env pwsh
<##
.SYNOPSIS
Prunes events older than the retention window from a JSONL event file.

.DESCRIPTION
Reads event_retention_days from policies/retention.yaml (positive integer, else rejected before
any event is touched). Each line is one JSON object with an ISO-8601 timestamp field. Lines older
than the cutoff are removed; every other line (newer, blank, unparseable, or without a parseable
timestamp) is kept byte-for-byte. The file is rewritten atomically (temp file, then rename).
Exactly one single-line JSON log record is written to the success stream per run.
##>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EventsPath,
    [string]$PolicyPath,
    [string]$TimestampField = 'timestamp',
    [datetime]$Now = ([datetime]::UtcNow)
)
$ErrorActionPreference = 'Stop'

if (-not $PolicyPath) { $PolicyPath = Join-Path $PSScriptRoot '../policies/retention.yaml' }
if (-not (Test-Path -LiteralPath $PolicyPath)) { throw "Retention policy not found: $PolicyPath" }
$policyText = Get-Content -Raw -LiteralPath $PolicyPath
$m = [regex]::Match($policyText, '(?m)^event_retention_days:[ \t]*(\S*)[ \t]*(?:#.*)?$')
if (-not $m.Success -or $m.Groups[1].Value -notmatch '^[1-9][0-9]*$' -or $m.Groups[1].Value.Length -gt 6) {
    throw "Invalid event_retention_days in ${PolicyPath}: expected a positive integer, got '$($m.Groups[1].Value)'."
}
$retention = [int]$m.Groups[1].Value

if (-not (Test-Path -LiteralPath $EventsPath)) { throw "Events file not found: $EventsPath" }
$full = (Resolve-Path -LiteralPath $EventsPath).Path
$utf8 = [Text.UTF8Encoding]::new($false)
$text = [IO.File]::ReadAllText($full, $utf8)
$cutoff = $Now.ToUniversalTime().AddDays(-$retention)

# Split keeping line terminators so kept lines are preserved byte-for-byte.
$lines = [regex]::Matches($text, '[^\n]*\n|[^\n]+') | ForEach-Object { $_.Value }
$kept = [System.Collections.Generic.List[string]]::new()
$removed = 0
foreach ($line in $lines) {
    $drop = $false
    try {
        $obj = $line | ConvertFrom-Json -ErrorAction Stop
        $raw = if ($obj -and $obj.PSObject.Properties[$TimestampField]) { $obj.$TimestampField } else { $null }
        if ($raw -is [datetime]) { $ts = $raw.ToUniversalTime() }
        elseif ($raw) {
            $ts = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$ts)) { $ts = $null }
        }
        else { $ts = $null }
        if ($null -ne $ts -and $ts -lt $cutoff) { $drop = $true }
    }
    catch { $drop = $false }
    if ($drop) { $removed++ } else { $kept.Add($line) }
}

if ($removed -gt 0) {
    $tmp = "$full.prune.tmp"
    try {
        [IO.File]::WriteAllText($tmp, ($kept -join ''), $utf8)
        Move-Item -LiteralPath $tmp -Destination $full -Force
    }
    finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
}

[ordered]@{
    event       = 'events.pruned'
    path        = $full
    retention_days = $retention
    cutoff      = $cutoff.ToString('o')
    removed     = $removed
    kept        = $kept.Count
} | ConvertTo-Json -Compress
