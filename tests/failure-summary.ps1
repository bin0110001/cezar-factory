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
if ($failures) { exit 1 }
