#!/usr/bin/env pwsh
# Bounded, read-only collection. Publication and recovery are separate work.
[CmdletBinding()]
param(
    [string]$ProjectPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [int]$MaxRuns = 20,
    [int]$WindowHours = 24,
    [int]$MaxCandidates = 200,
    [string]$ProjectId = $env:CEZAR_PROJECT_ID,
    [string]$ApiUrl = $env:CEZAR_API_URL,
    [switch]$CreateIssue,
    [switch]$RestartFailedIntake
)
$ErrorActionPreference = 'Stop'
if ($MaxRuns -lt 1 -or $MaxRuns -gt 20) { throw 'MaxRuns must be between 1 and 20.' }
if ($WindowHours -lt 1 -or $WindowHours -gt 168) { throw 'WindowHours must be between 1 and 168.' }
if ($MaxCandidates -lt 1 -or $MaxCandidates -gt 200) { throw 'MaxCandidates must be between 1 and 200.' }
if ($CreateIssue -or $RestartFailedIntake) { throw 'Failure collection is read-only; publication and recovery require separate workflow commands.' }
if (-not $ProjectId -or -not $ApiUrl) { throw 'Registered ProjectId and ApiUrl are required; folder names are not project identity.' }
if ($ApiUrl -notmatch '^https?://') { throw 'ApiUrl must be an http(s) URL.' }
if (-not $ProjectPath) {
    $cwd = (Get-Location).Path
    if ($cwd -match '^(?<root>.+)[\/].ai[\/]cezar[\/]worktrees[\/][^\/]+$') { $ProjectPath = $Matches.root }
    else { throw 'ProjectPath is required outside a Cezar isolated worktree.' }
}
$project = [IO.Path]::GetFullPath($ProjectPath)
$runDir = Join-Path $project '.ai/cezar/runs'
$output = if ([IO.Path]::IsPathRooted($OutputPath)) { [IO.Path]::GetFullPath($OutputPath) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutputPath)) }
$outputDir = Split-Path $output -Parent
$since = [datetime]::UtcNow.AddHours(-$WindowHours)
$readLimit = 65536
$evidenceBudget = 12000
$evidenceUsed = 0
$failurePattern = '(?i)(failed|failure|error|cancelled|canceled|unknown workflow|timed out|timeout)'
$result = [ordered]@{
    schemaVersion = 1; status = 'ready'; projectId = $ProjectId
    windowStartUtc = $since.ToString('o'); windowHours = $WindowHours
    runsInspected = 0; candidatesScanned = 0; failures = @(); limitations = @()
    budgets = @{ maxRuns = $MaxRuns; maxCandidates = $MaxCandidates; maxReadBytesPerSource = $readLimit; maxEventLines = 200; maxFailureSummaries = 8; maxEvidenceChars = $evidenceBudget }
    issueCreated = $false; issueNumber = $null; restarted = $false; restartRunId = $null
}
function Limit([string]$reason) {
    if ($result.limitations -notcontains $reason) { $result.limitations += $reason }
    $result.status = 'limited'
}
function Bounded-Text([string]$path, [bool]$tail) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @{ text = ''; truncated = $false; missing = $true } }
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $truncated = $stream.Length -gt $readLimit
        if ($tail -and $truncated) { [void]$stream.Seek(-$readLimit, [IO.SeekOrigin]::End) }
        $count = [int][Math]::Min($stream.Length, $readLimit)
        $bytes = [byte[]]::new($count)
        $read = 0
        while ($read -lt $count) {
            $n = $stream.Read($bytes, $read, $count - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        $value = [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
        return @{ text = $value; truncated = $truncated; missing = $false }
    } finally { $stream.Dispose() }
}
function Redact([string]$value) {
    $clean = $value -replace '(?i)\b(?:gh[psu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b', '[REDACTED]'
    $clean = $clean -replace '(?i)(Bearer\s+)\S+', '$1[REDACTED]'
    $clean = $clean -replace '(?i)\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,]+', '$1=[REDACTED]'
    $clean = ($clean -replace '\s+', ' ').Trim()
    if ($clean.Length -gt 400) { return $clean.Substring(0, 400) + '…' }
    return $clean
}
function Fingerprint([string[]]$lines) {
    $normalized = ((@($lines) -join '|').ToLowerInvariant() -replace '\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', '<id>' -replace '\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}[^\s|]*', '<time>' -replace '\b(run(?:id)?\s*[:=]\s*)[a-z0-9_-]+\b', '$1<run>')
    $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([Convert]::ToHexString($sha.ComputeHash($bytes))).ToLowerInvariant() }
    finally { $sha.Dispose() }
}
try {
    if (-not (Test-Path -LiteralPath $runDir -PathType Container)) {
        Limit 'runtime run directory is unavailable'
    } else {
        $candidates = [System.Collections.Generic.List[object]]::new()
        foreach ($path in [IO.Directory]::EnumerateFiles($runDir, '*.handoff.md', [IO.SearchOption]::TopDirectoryOnly)) {
            $result.candidatesScanned++
            if ($result.candidatesScanned -gt $MaxCandidates) { Limit 'candidate discovery budget exhausted; recency coverage is incomplete'; break }
            $info = [IO.FileInfo]::new($path)
            if ($info.LastWriteTimeUtc -ge $since) { $candidates.Add($info) }
        }
        $selected = @($candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First $MaxRuns)
        $result.runsInspected = $selected.Count
        $failures = [System.Collections.Generic.List[object]]::new()
        foreach ($handoff in $selected) {
            $runId = $handoff.Name -replace '\.handoff\.md$', ''
            $eventPath = Join-Path $runDir "$runId.ndjson"
            $handoffData = Bounded-Text $handoff.FullName $false
            $eventData = Bounded-Text $eventPath $true
            if ($handoffData.truncated) { Limit "handoff read truncated for run $runId" }
            if ($eventData.truncated) { Limit "event read truncated for run $runId" }
            if ($eventData.missing) { Limit "event evidence missing for run $runId" }
            $lines = @([regex]::Split($handoffData.text, '\r?\n') | Where-Object { $_ -match $failurePattern } | Select-Object -First 4)
            $eventLines = @([regex]::Split($eventData.text, '\r?\n') | Select-Object -Last 200)
            $lines += @($eventLines | Where-Object { $_ -match $failurePattern } | Select-Object -Last 6)
            if ($lines.Count -eq 0) { continue }
            $evidence = [System.Collections.Generic.List[string]]::new()
            $step = ''; $command = ''
            foreach ($line in $lines) {
                $clean = Redact $line
                if (-not $clean -or $evidence.Contains($clean)) { continue }
                if ($evidenceUsed + $clean.Length -gt $evidenceBudget) { Limit 'evidence character budget exhausted'; break }
                $evidence.Add($clean); $evidenceUsed += $clean.Length
                if ($line.TrimStart().StartsWith('{')) {
                    try {
                        $event = $line | ConvertFrom-Json
                        if ($event.stepId) { $step = [string]$event.stepId }
                        if ($event.command) { $command = Redact ([string]$event.command) }
                    } catch { }
                }
            }
            if ($evidence.Count -gt 0) {
                $failures.Add([ordered]@{
                    runId = $runId; step = $step; command = $command
                    lastWriteUtc = $handoff.LastWriteTimeUtc.ToString('o')
                    fingerprint = (Fingerprint @($evidence))
                    evidence = @($evidence)
                    sources = @{ handoff = $handoff.Name; events = if ($eventData.missing) { $null } else { "$runId.ndjson" } }
                })
            }
            if ($failures.Count -ge 8) { break }
        }
        $result.failures = @($failures)
    }
} catch {
    Limit ('local collection error: ' + (Redact $_.Exception.Message))
} finally {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding utf8
    $result | ConvertTo-Json -Compress -Depth 10 | Write-Output
}
