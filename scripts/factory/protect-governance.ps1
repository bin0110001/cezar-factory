#!/usr/bin/env pwsh
# Fails when an implementation/repair diff changes verification governance (policy, baselines, check selection,
# historical ledger evidence, the guard itself) without an authorized review. Runs from a workflow command: step.
# The only bypass is -AuthorizationPath: a marker naming a GitHub APPROVED review by someone other than the PR
# author and the acting identity, bound to the head commit and the exact protected paths. Every accepted waiver
# is appended to the waiver ledger and printed.
param(
    [string]$Task = '',
    [string]$Root = '.',
    [string]$Base = '',
    [string]$ManifestPath = '',
    [string]$AuthorizationPath = '.factory/governance-authorization.json',
    [string]$Gh = 'gh',
    [string]$ActorLogin = '',
    [string]$Repo = '',
    [string]$ReportPath = '.factory/governance-guard.json'
)
$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
$Root = (Resolve-Path -LiteralPath $Root).Path
if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot '../../policies/protected-assets.json' }
$manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json -AsHashtable
if ($manifest.schemaVersion -ne 1 -or -not ($manifest.assets -is [array])) { throw "Invalid protected-assets manifest: $ManifestPath" }

function Invoke-Git { $o = & git -C $Root @args 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed: $o" }; $o }
function ConvertTo-Regex([string]$Glob) {
    $r = [regex]::Escape($Glob).Replace('\*\*/', "`0").Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '[^/]').Replace("`0", '(?:.*/)?')
    '^' + $r + '$'
}

# Base: the prepared handoff's base commit, else the merge base with origin/dev or origin/stable. Never the working tree.
if (-not $Base) {
    $ctx = Join-Path $Root '.factory/implementation-context.json'
    if (Test-Path -LiteralPath $ctx) { try { $Base = [string](Get-Content -Raw -LiteralPath $ctx | ConvertFrom-Json).environment.baseCommit } catch { } }
}
if ($Base -notmatch '^[0-9a-fA-F]{40,64}$') {
    foreach ($c in @('origin/dev', 'origin/stable')) {
        & git -C $Root rev-parse --verify "$c^{commit}" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $Base = ((& git -C $Root merge-base HEAD $c) -join '').Trim(); if ($Base) { break } }
    }
}
if ($Base -notmatch '^[0-9a-fA-F]{40,64}$') { Write-Error 'protect-governance: cannot establish a trusted base commit; refusing to pass.'; exit 1 }
$head = ((Invoke-Git rev-parse HEAD) -join '').Trim()

# Changes: committed + staged + unstaged (diff against the base commit) plus untracked files (as additions).
$changes = @{}
foreach ($line in @(Invoke-Git diff --name-status -M $Base)) {
    $f = ([string]$line) -split "`t"
    if ($f.Count -lt 2) { continue }
    $s = $f[0].Substring(0, 1)
    if ($s -eq 'R' -or $s -eq 'C') {
        # A rename touches both paths: the old one is removed, the new one added.
        $changes[$f[1]] = 'D'; $changes[$f[2]] = 'A'
    } else { $changes[$f[1]] = $s }
}
foreach ($p in @(Invoke-Git ls-files --others --exclude-standard)) { if (-not $changes.ContainsKey([string]$p)) { $changes[[string]$p] = 'A' } }

$violations = [System.Collections.Generic.List[object]]::new()
foreach ($path in ($changes.Keys | Sort-Object)) {
    $status = $changes[$path]
    foreach ($asset in $manifest.assets) {
        if (-not ($asset.globs | Where-Object { $path -match (ConvertTo-Regex $_) })) { continue }
        if ($asset.appendOnly -and $status -eq 'A') { break }   # new ledger records are allowed; edits/deletes/renames of history are not
        if ($asset.semantic -eq 'mandatory-checks' -and $status -eq 'M') {
            # Additive edits (new checks, extra patterns) are allowed; removing or altering an existing check is not.
            $problems = @()
            try {
                $old = (Invoke-Git show "${Base}:$path") -join "`n" | ConvertFrom-Json -AsHashtable
                $new = Get-Content -Raw -LiteralPath (Join-Path $Root $path) | ConvertFrom-Json -AsHashtable
                if ($old.unmapped -ne $new.unmapped) { $problems += "unmapped policy changed from '$($old.unmapped)' to '$($new.unmapped)'" }
                foreach ($oc in $old.checks) {
                    $nc = @($new.checks | Where-Object { $_.id -eq $oc.id }) | Select-Object -First 1
                    if (-not $nc) { $problems += "mandatory check '$($oc.id)' was removed"; continue }
                    if ($nc.command -ne $oc.command) { $problems += "command of check '$($oc.id)' was changed" }
                    $dropped = @($oc.patterns | Where-Object { $_ -notin @($nc.patterns) })
                    if ($dropped.Count) { $problems += "check '$($oc.id)' no longer covers: $($dropped -join ', ')" }
                }
            } catch { $problems += "selection config could not be compared safely ($($_.Exception.Message))" }
            if (-not $problems.Count) { break }
            $violations.Add([pscustomobject]@{ path = $path; category = $asset.category; change = $status; reason = ($problems -join '; ') }); break
        }
        if ($asset.semantic -eq 'mandatory-checks' -and $status -eq 'A') { break }
        $violations.Add([pscustomobject]@{ path = $path; category = $asset.category; change = $status; reason = "protected $($asset.category) asset changed ($status)" })
        break
    }
}

function Write-Report($Obj) {
    $dir = Split-Path -Parent $ReportPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $Obj | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}
if (-not $violations.Count) {
    Write-Report @{ status = 'pass'; base = $Base; head = $head; protectedViolations = @() }
    Write-Host "protect-governance: PASS (no protected governance assets changed against $($Base.Substring(0, 12)))"
    exit 0
}

$paths = @($violations | ForEach-Object { $_.path } | Sort-Object -Unique)
$pathsHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($paths -join "`n")))).Replace('-', '').ToLower()
$reviewTag = "factory-governance-waiver:$pathsHash"

function Fail-Guard([string]$Why) {
    Write-Host 'protect-governance: FAIL - this diff changes protected verification governance:' -ForegroundColor Red
    foreach ($v in $violations) { Write-Host "  [$($v.category)] $($v.path): $($v.reason)" }
    Write-Host "Authorization: a reviewer other than the PR author must submit an APPROVED GitHub review on the head commit whose body contains '$reviewTag', and the marker $AuthorizationPath must reference it (schemas/governance-authorization.schema.json). $Why"
    Write-Report @{ status = 'fail'; base = $Base; head = $head; reason = $Why; requiredReviewTag = $reviewTag; protectedViolations = @($violations) }
    exit 1
}

if (-not (Test-Path -LiteralPath $AuthorizationPath -PathType Leaf)) { Fail-Guard 'No authorization marker present.' }
try { $m = Get-Content -Raw -LiteralPath $AuthorizationPath | ConvertFrom-Json -AsHashtable } catch { Fail-Guard 'Authorization marker is not valid JSON.' }
$markerKeys = @($m.Keys | Sort-Object)
if (($markerKeys -join ',') -ne 'headCommit,paths,pr,reviewer,schemaVersion' -or $m.schemaVersion -ne 1) { Fail-Guard 'Authorization marker does not match the schema.' }
if ([string]$m.headCommit -ne $head) { Fail-Guard "Marker is bound to $($m.headCommit), not the head commit $head." }
if ((@($m.paths | Sort-Object) -join "`n") -ne ($paths -join "`n")) { Fail-Guard 'Marker paths do not exactly match the protected paths changed.' }

# Verify on GitHub; the marker alone proves nothing.
if (-not $Repo) {
    $url = ((& git -C $Root remote get-url origin 2>$null) -join '')
    if ($url -match 'github\.com[:/]([^/]+/[^/.]+)') { $Repo = $Matches[1] }
}
if (-not $Repo) { Fail-Guard 'Cannot determine the repository to verify the review against.' }
try {
    $prInfo = (& $Gh api "repos/$Repo/pulls/$($m.pr)" 2>&1 | Out-String) | ConvertFrom-Json
    $reviews = @((& $Gh api "repos/$Repo/pulls/$($m.pr)/reviews" 2>&1 | Out-String) | ConvertFrom-Json)
    if (-not $ActorLogin) { $ActorLogin = ((& $Gh api user --jq .login 2>$null) -join '').Trim() }
} catch { Fail-Guard "GitHub could not be queried to verify the review ($($_.Exception.Message))." }
if ($prInfo.head.sha -ne $head) { Fail-Guard "PR #$($m.pr) head is $($prInfo.head.sha), not $head." }
if ($m.reviewer -eq $prInfo.user.login -or ($ActorLogin -and $m.reviewer -eq $ActorLogin)) { Fail-Guard 'The reviewer must not be the PR author or the acting agent identity.' }
$review = @($reviews | Where-Object {
    $_.user.login -eq $m.reviewer -and $_.state -eq 'APPROVED' -and $_.commit_id -eq $head -and
    $_.author_association -in @('OWNER', 'MEMBER', 'COLLABORATOR') -and ([string]$_.body).Contains($reviewTag)
}) | Select-Object -First 1
if (-not $review) { Fail-Guard "No APPROVED review by '$($m.reviewer)' on $head containing '$reviewTag' was found on PR #$($m.pr)." }

$record = [ordered]@{
    type = 'governance-waiver'; recordedAt = [DateTime]::UtcNow.ToString('o'); pr = [int]$m.pr; reviewer = $m.reviewer
    headCommit = $head; baseCommit = $Base; reviewUrl = [string]$review.html_url; task = $Task
    waived = @($violations | ForEach-Object { [ordered]@{ path = $_.path; category = $_.category; change = $_.change } })
}
$ledger = if ([IO.Path]::IsPathRooted($manifest.waiverLedger)) { $manifest.waiverLedger } else { Join-Path $Root $manifest.waiverLedger }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ledger) | Out-Null
Add-Content -LiteralPath $ledger -Value ($record | ConvertTo-Json -Depth 6 -Compress) -Encoding utf8
Write-Host "protect-governance: WAIVED by $($m.reviewer) (PR #$($m.pr), $($review.html_url)); recorded in $($manifest.waiverLedger):"
foreach ($v in $violations) { Write-Host "  [$($v.category)] $($v.path) ($($v.change))" }
Write-Report @{ status = 'waived'; base = $Base; head = $head; waiver = $record; protectedViolations = @($violations) }
exit 0
