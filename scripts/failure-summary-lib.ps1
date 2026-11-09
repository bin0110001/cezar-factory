# Bounded evidence helpers shared by failure summaries and the #30 audit collector (single source of redaction rules).
function Protect-FailureText([string]$Value, [int]$MaxChars = 400) {
    $clean = $Value -replace '(?i)\b(?:gh[psu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b', '[REDACTED]'
    $clean = $clean -replace '(?i)(Bearer\s+)\S+', '$1[REDACTED]'
    $clean = $clean -replace '(?i)\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,]+', '$1=[REDACTED]'
    $clean = ($clean -replace '\s+', ' ').Trim()
    if ($clean.Length -gt $MaxChars) { return $clean.Substring(0, $MaxChars) + '…' }
    return $clean
}

# Group finding records {findingId, identifier, message, detailPath, occurrence} into one entry per findingId.
# Output is redacted, ordered (occurrences desc, findingId asc) and cut at entry boundaries to MaxChars.
function New-FailureSummary([object[]]$Records, [int]$MaxChars = 4000, [int]$MaxIdentifiers = 5, [int]$MaxPaths = 3) {
    $groups = @{}
    foreach ($r in @($Records)) {
        if ($null -eq $r) { continue }
        $id = Protect-FailureText ([string]$r.findingId) 120
        if (-not $id) { continue }
        if (-not $groups.ContainsKey($id)) { $groups[$id] = @{ findingId = $id; count = 0; ids = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal); paths = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal); message = $null } }
        $g = $groups[$id]
        $n = 1
        if ($null -ne $r.occurrence -and [int]::TryParse([string]$r.occurrence, [ref]$n) -and $n -gt 0) { } else { $n = 1 }
        $g.count += $n
        $ident = Protect-FailureText ([string]$r.identifier) 160
        if ($ident) { [void]$g.ids.Add($ident) }
        $p = Protect-FailureText ([string]$r.detailPath) 260
        if ($p) { [void]$g.paths.Add($p) }
        $m = Protect-FailureText ([string]$r.message) 200
        if ($m -and ($null -eq $g.message -or [string]::CompareOrdinal($m, $g.message) -lt 0)) { $g.message = $m }
    }
    $ordered = @($groups.Values | Sort-Object @{ Expression = { -$_.count } }, @{ Expression = { $_.findingId } })
    $entries = @(); $used = 0; $omittedEntries = 0; $omittedOcc = 0
    $reserve = 120
    foreach ($g in $ordered) {
        $ids = @($g.ids); $paths = @($g.paths)
        $entry = [ordered]@{
            findingId = $g.findingId; occurrenceCount = $g.count; message = [string]$g.message
            identifiers = @($ids | Select-Object -First $MaxIdentifiers); detailPaths = @($paths | Select-Object -First $MaxPaths)
        }
        $size = ($entry | ConvertTo-Json -Depth 5 -Compress).Length + 1
        if ($omittedEntries -eq 0 -and ($used + $size + $reserve) -le $MaxChars) { $entries += $entry; $used += $size }
        else { $omittedEntries++; $omittedOcc += $g.count }
    }
    return [ordered]@{
        schemaVersion = 1; totalFindings = $ordered.Count
        totalOccurrences = [int](($ordered | Measure-Object -Property count -Sum).Sum)
        truncated = ($omittedEntries -gt 0); omittedEntries = $omittedEntries; omittedOccurrences = $omittedOcc
        entries = $entries
    }
}
