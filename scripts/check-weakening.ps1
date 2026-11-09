#!/usr/bin/env pwsh
# Anti-weakening guard. Compares BASE and HEAD and fails when a change lowers a threshold, removes or
# downgrades a mandatory check, adds a suppression/skip/allowlist entry, rewrites the audit log, or edits a
# protected path. The policy is always read from BASE so a change cannot weaken the rules it is judged by.
# Modes: -BaseRef <git ref> (HEAD = working tree) or -BaseDir/-HeadDir (directories; used by tests).
# Exit: 0 ok (or no policy at base: guard not enabled), 1 violations, 2 error (fails closed).
param(
    [string]$BaseRef,
    [string]$BaseDir,
    [string]$HeadDir,
    [string]$Repo = '.',
    [string]$Policy = 'policies/baseline-promotion.json'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Fail([string]$Message) { [Console]::Error.WriteLine("ERROR (fail closed): $Message"); exit 2 }
if (-not $BaseRef -and -not ($BaseDir -and $HeadDir)) { Fail 'give -BaseRef or both -BaseDir and -HeadDir' }
$dirMode = [bool]($BaseDir -and $HeadDir)
if (-not $dirMode) { $Repo = (Resolve-Path -LiteralPath $Repo).Path; $HeadDir = $Repo }

function Get-BaseText([string]$Rel) {
    if ($dirMode) { $p = Join-Path $BaseDir $Rel; if (Test-Path -LiteralPath $p -PathType Leaf) { return Get-Content -Raw -LiteralPath $p } else { return $null } }
    $out = & git -C $Repo show "${BaseRef}:$Rel" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    ($out -join "`n") + "`n"
}
function Get-HeadText([string]$Rel) {
    $p = Join-Path $HeadDir $Rel
    if (Test-Path -LiteralPath $p -PathType Leaf) { Get-Content -Raw -LiteralPath $p } else { $null }
}
function Get-ChangedFiles {
    if ($dirMode) {
        $all = foreach ($d in $BaseDir, $HeadDir) {
            $root = (Resolve-Path -LiteralPath $d).Path
            Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object { [IO.Path]::GetRelativePath($root, $_.FullName) -replace '\\', '/' }
        }
        $all | Sort-Object -Unique | Where-Object { (Get-BaseText $_) -ne (Get-HeadText $_) }
    }
    else {
        $tracked = & git -C $Repo diff --name-only --no-renames $BaseRef
        if ($LASTEXITCODE -ne 0) { Fail "git diff against '$BaseRef' failed" }
        $new = & git -C $Repo ls-files --others --exclude-standard
        @($tracked) + @($new) | Where-Object { $_ } | Sort-Object -Unique
    }
}
function ConvertTo-GlobRegex([string]$Glob) {
    $r = [regex]::Escape($Glob) -replace '\\\*\\\*', '.*' -replace '\\\*', '[^/]*'
    "^$r$"
}
function Test-Glob([string]$Rel, $Globs) { foreach ($g in @($Globs)) { if ($Rel -match (ConvertTo-GlobRegex ([string]$g))) { return $true } }; $false }
function Get-Digest([string]$Text) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { -join ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function ConvertFrom-JsonStrict([string]$Text, [string]$What) {
    try { $Text | ConvertFrom-Json -AsHashtable -NoEnumerate } catch { Fail "$What is not parseable JSON: $($_.Exception.Message)" }
}

$levelRank = @{ off = 0; none = 0; info = 1; warn = 2; warning = 2; error = 3; fail = 3; block = 3 }
$suppressionKeys = 'suppressions', 'skip', 'skips', 'allowlist', 'ignore', 'exclude', 'excludes'
$violations = [System.Collections.Generic.List[string]]::new()
function Add-Violation([string]$Message) { $violations.Add($Message) }

function Compare-Weakening($Old, $New, [string]$Where) {
    if ($Old -isnot [System.Collections.IDictionary]) { return }
    $newMap = if ($New -is [System.Collections.IDictionary]) { $New } else { @{} }
    foreach ($key in @($Old.Keys)) {
        $o = $Old[$key]; $has = $newMap.Contains($key); $n = if ($has) { $newMap[$key] } else { $null }
        $at = "$Where/$key"
        if ($key -in 'thresholds', 'thresholdFloors' -and $o -is [System.Collections.IDictionary]) {
            foreach ($t in @($o.Keys)) {
                $nt = if ($n -is [System.Collections.IDictionary] -and $n.Contains($t)) { $n[$t] } else { $null }
                if ($null -eq $nt) { Add-Violation "$at/${t}: threshold removed (was $($o[$t]))" }
                elseif ([double]$nt -lt [double]$o[$t]) { Add-Violation "$at/${t}: threshold lowered from $($o[$t]) to $nt" }
            }
        }
        elseif ($key -eq 'mandatoryChecks' -and $o -is [System.Collections.IList]) {
            $nl = if ($n -is [System.Collections.IList]) { @($n) } else { @() }
            foreach ($c in $o) { if ($nl -notcontains $c) { Add-Violation "$at/${c}: mandatory check removed" } }
        }
        elseif ($key -eq 'checks' -and $o -is [System.Collections.IDictionary]) {
            foreach ($c in @($o.Keys)) {
                $oc = $o[$c]
                $nc = if ($n -is [System.Collections.IDictionary] -and $n.Contains($c)) { $n[$c] } else { $null }
                $oldMand = ($oc -is [System.Collections.IDictionary] -and $oc.Contains('mandatory') -and $oc['mandatory'] -eq $true)
                if ($null -eq $nc) { if ($oldMand) { Add-Violation "$at/${c}: mandatory check removed" } else { Add-Violation "$at/${c}: check removed" }; continue }
                if ($oldMand -and -not ($nc -is [System.Collections.IDictionary] -and $nc.Contains('mandatory') -and $nc['mandatory'] -eq $true)) { Add-Violation "$at/${c}: mandatory check made optional" }
                $ol = if ($oc -is [System.Collections.IDictionary] -and $oc.Contains('level')) { [string]$oc['level'] } else { '' }
                $nl2 = if ($nc -is [System.Collections.IDictionary] -and $nc.Contains('level')) { [string]$nc['level'] } else { '' }
                if ($ol -and $levelRank.ContainsKey($ol.ToLowerInvariant()) -and (-not $nl2 -or -not $levelRank.ContainsKey($nl2.ToLowerInvariant()) -or $levelRank[$nl2.ToLowerInvariant()] -lt $levelRank[$ol.ToLowerInvariant()])) {
                    Add-Violation "$at/${c}: check level downgraded from '$ol' to '$nl2'"
                }
            }
        }
        elseif ($key -in $suppressionKeys) { }   # additions are checked from the new side below
        elseif ($o -is [System.Collections.IDictionary]) { Compare-Weakening $o $n $at }
    }
    foreach ($key in @($newMap.Keys)) {
        if ($key -in $suppressionKeys) {
            $oldItems = if ($Old.Contains($key) -and $Old[$key] -is [System.Collections.IList]) { @($Old[$key] | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 20 }) } else { @() }
            $nv = $newMap[$key]
            $items = if ($nv -is [System.Collections.IList]) { @($nv) } elseif ($nv -is [System.Collections.IDictionary]) { @($nv.Keys) } else { @() }
            foreach ($i in $items) { if ($oldItems -notcontains ($i | ConvertTo-Json -Compress -Depth 20)) { Add-Violation "$Where/${key}: suppression added ($($i | ConvertTo-Json -Compress -Depth 20))" } }
        }
    }
}

$policyText = Get-BaseText $Policy
if ($null -eq $policyText) { Write-Host "no guard policy '$Policy' at base; weakening guard not enabled"; exit 0 }
$pol = ConvertFrom-JsonStrict $policyText "policy '$Policy' at base"
foreach ($k in 'protectedPaths', 'auditLog') { if (-not $pol.Contains($k)) { Fail "policy lacks '$k'" } }
$protected = @($pol['protectedPaths']); $baselinePaths = if ($pol.Contains('baselinePaths')) { @($pol['baselinePaths']) } else { @() }
$auditRel = [string]$pol['auditLog']

$changed = @(Get-ChangedFiles)

# Audit log: append-only with an intact digest chain.
$auditBase = Get-BaseText $auditRel; $auditHead = Get-HeadText $auditRel
$baseLines = @(if ($auditBase) { $auditBase -split "`r?`n" | Where-Object { $_.Trim() } })
$headLines = @(if ($auditHead) { $auditHead -split "`r?`n" | Where-Object { $_.Trim() } })
$newEntries = @()
if ($auditRel -in $changed) {
    $prefixOk = $headLines.Count -ge $baseLines.Count
    for ($i = 0; $prefixOk -and $i -lt $baseLines.Count; $i++) { if ($headLines[$i] -ne $baseLines[$i]) { $prefixOk = $false } }
    if (-not $prefixOk) { Add-Violation "${auditRel}: audit entries removed or rewritten (log must be append-only)" }
    else {
        $newEntries = @($headLines | Select-Object -Skip $baseLines.Count)
        for ($i = $baseLines.Count; $i -lt $headLines.Count; $i++) {
            $e = ConvertFrom-JsonStrict $headLines[$i] "audit entry $($i + 1)"
            $want = if ($i -eq 0) { '' } else { Get-Digest $headLines[$i - 1] }
            if (-not $e.Contains('prevEntryDigest') -or [string]$e['prevEntryDigest'] -ne $want) { Add-Violation "${auditRel}: audit entry $($i + 1) breaks the digest chain" }
        }
    }
}

foreach ($rel in $changed) {
    $isBaseline = Test-Glob $rel $baselinePaths
    $isProtected = Test-Glob $rel $protected
    if ($isBaseline -and -not $isProtected) {
        # A baseline may change only with a new audit entry recording exactly this content.
        $headText = Get-HeadText $rel
        $digestOk = $false
        if ($null -ne $headText) {
            $d = Get-Digest $headText
            foreach ($n in $newEntries) { $e = ConvertFrom-JsonStrict $n 'new audit entry'; if ($e.Contains('baselineAfterDigest') -and $e['baselineAfterDigest'] -eq $d -and $e.Contains('approver')) { $digestOk = $true } }
            if ($digestOk -and $rel -like '*.json') {
                $hp = ConvertFrom-JsonStrict $headText "baseline '$rel'"
                $floors = if ($pol.Contains('thresholdFloors')) { $pol['thresholdFloors'] } else { @{} }
                foreach ($t in @($floors.Keys)) { $v = if ($hp.Contains('thresholds') -and $hp['thresholds'].Contains($t)) { $hp['thresholds'][$t] } else { $null }; if ($null -eq $v -or [double]$v -lt [double]$floors[$t]) { Add-Violation "${rel}: threshold '$t' is below the policy floor $($floors[$t])" } }
                $mand = if ($pol.Contains('mandatoryChecks')) { @($pol['mandatoryChecks']) } else { @() }
                foreach ($c in $mand) { $present = $hp.Contains('checks') -and $hp['checks'].Contains($c) -and $hp['checks'][$c].Contains('mandatory') -and $hp['checks'][$c]['mandatory'] -eq $true; if ($hp.Contains('checks') -and -not $present) { Add-Violation "${rel}: mandatory check '$c' missing or not mandatory" } }
            }
        }
        if (-not $digestOk) { Add-Violation "${rel}: baseline edited without an authorized promotion (no matching audit entry)" }
    }
    elseif ($isProtected -and $rel -ne $auditRel) { Add-Violation "${rel}: protected path edited" }
    elseif ($rel -eq $auditRel -and -not $isBaseline -and $newEntries.Count -gt 0 -and -not (@($changed | Where-Object { Test-Glob $_ $baselinePaths }).Count)) {
        Add-Violation "${rel}: audit entry appended without a matching baseline promotion"
    }
    # Weakening inside any other changed JSON that the base also had (policy-like files).
    if (-not $isProtected -and -not $isBaseline -and $rel -like '*.json') {
        $b = Get-BaseText $rel
        if ($null -ne $b) {
            $h = Get-HeadText $rel
            if ($null -eq $h) { continue }
            Compare-Weakening (ConvertFrom-JsonStrict $b "base '$rel'") (ConvertFrom-JsonStrict $h "head '$rel'") $rel
        }
    }
}

if ($violations.Count) {
    [Console]::Error.WriteLine('WEAKENING GUARD FAILED:')
    $violations | Sort-Object -Unique | ForEach-Object { [Console]::Error.WriteLine("  - $_") }
    exit 1
}
Write-Host "weakening guard passed ($($changed.Count) changed file(s) checked)"
exit 0
