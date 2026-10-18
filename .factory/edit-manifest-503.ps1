param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$ProposedPath
)
$ErrorActionPreference = 'Stop'
$original = Get-Content -LiteralPath $ManifestPath -Raw
$current = $original | ConvertFrom-Json -AsHashtable
$proposed = Get-Content -LiteralPath $ProposedPath -Raw | ConvertFrom-Json -AsHashtable
$stale = @(
    'res://test/scripts/gdscript/NpcAssetMetadataThreeWayConvergenceTest.gd',
    'res://test/scripts/gdscript/Plugins/Rules/ConflictResolverRegistryTest.gd',
    'res://test/scripts/gdscript/Plugins/Rules/D20ConflictResolverTest.gd',
    'res://test/scripts/gdscript/Plugins/Rules/SWADEConflictResolverTest.gd'
)
$added = @($proposed.suites.Keys | Where-Object { -not $current.suites.Contains($_) } | Sort-Object)
if ($added.Count -ne 21) { throw "Expected 21 new suites, found $($added.Count)." }
$text = $original
foreach ($key in $stale) {
    if (-not $current.suites.Contains($key)) { throw "Expected stale entry missing: $key" }
    $pattern = '(?ms)^    "' + [regex]::Escape($key) + '": \{\r?\n.*?^    \},\r?\n'
    if ([regex]::Matches($text, $pattern).Count -ne 1) { throw "Could not isolate exactly one stale block: $key" }
    $text = [regex]::Replace($text, $pattern, '')
}
$nl = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$blocks = foreach ($key in $added) {
    $entry = $proposed.suites[$key]
    if ($entry.origin -ne 'scanner' -or -not $entry.scanHash) { throw "Unreviewed generated entry: $key" }
    @(
        ('    "' + $key + '": {'),
        ('      "traits": ' + (ConvertTo-Json -InputObject @($entry.traits) -Compress) + ','),
        ('      "resources": ' + (ConvertTo-Json -InputObject @($entry.resources) -Compress) + ','),
        ('      "tags": ' + (ConvertTo-Json -InputObject @($entry.tags) -Compress) + ','),
        '      "origin": "scanner",',
        ('      "scanHash": "' + $entry.scanHash + '"'),
        '    }'
    ) -join $nl
}
$insertAt = $text.LastIndexOf($nl + '  }')
if ($insertAt -lt 0) { throw 'Could not locate suites object end.' }
$head = $text.Substring(0, $insertAt).TrimEnd([char[]]@("`r", "`n"))
$tail = $text.Substring($insertAt)
$text = $head + ',' + $nl + ($blocks -join (',' + $nl)) + $tail
$final = $text | ConvertFrom-Json -AsHashtable
if ($final.suites.Count -ne ($current.suites.Count - $stale.Count + $added.Count)) { throw 'Suite count changed unexpectedly.' }
foreach ($key in $stale) { if ($final.suites.Contains($key)) { throw "Stale suite remains: $key" } }
foreach ($key in $added) { if (-not $final.suites.Contains($key)) { throw "New suite missing: $key" } }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ManifestPath), $text, [Text.UTF8Encoding]::new($false))
Write-Host "Added $($added.Count) scanned suites and removed $($stale.Count) confirmed stale entries."
