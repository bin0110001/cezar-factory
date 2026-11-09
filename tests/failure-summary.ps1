#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/failure-summary-lib.ps1')
$failures = 0
function Check([string]$name, [bool]$c) { if ($c) { Write-Host "  ok   $name" } else { Write-Host "  FAIL $name"; $script:failures++ } }
$recs = 1..5 | ForEach-Object { [pscustomobject]@{ findingId = 'F-a'; identifier = "t$_"; message = 'boom token=ghp_abcdefghijklmnopqrstuvwxyz123456'; detailPath = "d/$_.log"; occurrence = 1 } }
$s = New-FailureSummary -Records $recs
Check 'dedup yields one entry with count N' ($s.entries.Count -eq 1 -and $s.entries[0].occurrenceCount -eq 5)
Check 'identifiers and paths kept' ($s.entries[0].identifiers.Count -eq 5 -and $s.entries[0].detailPaths.Count -eq 3)
$j = $s | ConvertTo-Json -Depth 6
Check 'secrets redacted' ($j -notmatch 'ghp_abcdef' -and $j -match 'REDACTED')
$many = 1..50 | ForEach-Object { [pscustomobject]@{ findingId = ('F-{0:D3}' -f $_); identifier = 'x'; message = 'm' * 150; detailPath = 'p'; occurrence = $_ } }
$c = New-FailureSummary -Records $many -MaxChars 1500
Check 'size cap honoured' (($c | ConvertTo-Json -Depth 6 -Compress).Length -le 1500)
Check 'omitted counts keep repeats visible' ($c.truncated -and $c.omittedEntries -eq (50 - $c.entries.Count) -and ($c.omittedOccurrences + (@($c.entries | ForEach-Object { $_.occurrenceCount }) | Measure-Object -Sum).Sum) -eq 1275)
Check 'ordered by count desc' ($c.entries[0].findingId -eq 'F-050')
$tie = New-FailureSummary -Records @([pscustomobject]@{findingId='b'},[pscustomobject]@{findingId='a'})
Check 'ties ordered by findingId' ($tie.entries[0].findingId -eq 'a')
Check 'stable output' (($many | ForEach-Object { $_ } | ForEach-Object { $_ }) -and ((New-FailureSummary -Records $many | ConvertTo-Json -Depth 6) -eq (New-FailureSummary -Records $many | ConvertTo-Json -Depth 6)))
$e = New-FailureSummary -Records @()
Check 'empty input' ($e.entries.Count -eq 0 -and $e.totalOccurrences -eq 0 -and -not $e.truncated)
# Runtime packaging: every script a runtime script dot-sources must itself be installed.
. (Join-Path $PSScriptRoot '../scripts/lib.ps1')
$missing = @()
foreach ($rs in $script:RuntimeScripts) {
    $f = Join-Path $PSScriptRoot "../scripts/$rs"
    if (-not (Test-Path $f) -or $rs -notmatch '\.ps1$') { continue }
    foreach ($m in [regex]::Matches((Get-Content -Raw $f), '(?m)^\s*\.\s+\(Join-Path \$PSScriptRoot \x27([^\x27]+\.ps1)\x27\)')) {
        $dep = $m.Groups[1].Value
        if ($dep -ne 'lib.ps1' -and $script:RuntimeScripts -notcontains $dep) { $missing += "$rs -> $dep" }
    }
}
Check 'dot-sourced deps of runtime scripts are runtime scripts' ($missing.Count -eq 0)
if ($missing) { Write-Host "    $($missing -join '; ')" }
Check 'summarizer is a runtime script' ($script:RuntimeScripts -contains 'summarize-failures.ps1')
# CLI wrapper: array, {records}, and single-object inputs.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("fsum-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $tmp | Out-Null
$cli = Join-Path $PSScriptRoot '../scripts/summarize-failures.ps1'
$rec = @{ findingId = 'F-x'; identifier = 'i'; message = 'm'; detailPath = 'p'; occurrence = 1 }
$shapes = @{ array = @($rec, $rec) | ConvertTo-Json -AsArray; wrapped = @{ records = @($rec, $rec) } | ConvertTo-Json -Depth 4; single = $rec | ConvertTo-Json }
$want = @{ array = 2; wrapped = 2; single = 1 }
foreach ($k in $shapes.Keys) {
    $in = Join-Path $tmp "$k.json"; $out = Join-Path $tmp "$k.out.json"
    Set-Content $in $shapes[$k]
    & pwsh -NoProfile -File $cli -InputPath $in -OutputPath $out | Out-Null
    $r = Get-Content -Raw $out | ConvertFrom-Json
    Check "cli $k input" ($LASTEXITCODE -eq 0 -and $r.totalOccurrences -eq $want[$k] -and @($r.entries).Count -eq 1)
}
Remove-Item -Recurse -Force $tmp
if ($failures) { exit 1 }
