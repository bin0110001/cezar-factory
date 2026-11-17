#!/usr/bin/env pwsh
# Acceptance-criteria verification ledger (#132). Dot-source; functions only, no side effects.
#
# Maps each issue acceptance criterion to deterministic evidence with explicit
# verified/unverified/failed state. Evidence is bound to a commit and policy revision; evidence
# recorded for another commit/policy is stale and counts for nothing. Missing checks are
# unverified, and agent self-assessment is recorded but never verifies. Baseline comparison and
# concise findings (#99-#101, #103) are consumed as evidence sources, not reimplemented.
# See docs/acceptance-ledger.md and schemas/acceptance-ledger.schema.json.

$script:AlMarkerBegin = '<!-- factory-acceptance-ledger:begin -->'
$script:AlMarkerEnd = '<!-- factory-acceptance-ledger:end -->'
# Kinds that can verify a criterion. self-assessment is deliberately absent.
$script:AlDeterministicKinds = @('test', 'file', 'commit', 'artifact', 'human-review', 'baseline', 'finding')

function Get-AlCriterionId([string]$Text) {
    $norm = (($Text -replace '\s+', ' ').Trim()).ToLowerInvariant()
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($norm))
    'AC-' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()).Substring(0, 8)
}

function ConvertFrom-AcceptanceCriteria {
    # Heuristic parse of acceptance criteria from issue/plan text. Returns [{id,text}] in order.
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $items = [System.Collections.Generic.List[string]]::new()
    $lines = $Text -split "\r?\n"
    $inSection = $false; $sawSection = $false
    foreach ($line in $lines) {
        if ($line -match '^\s{0,3}(#{1,6}\s*|\*\*)\s*acceptance') { $inSection = $true; $sawSection = $true; continue }
        if ($line -match '^\s{0,3}#{1,6}\s' -or $line -match '^\s*\*\*[^*]+\*\*\s*$') { if ($inSection) { $inSection = $false }; continue }
        if (-not $inSection) { continue }
        if ($line -match '^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$') { $items.Add($Matches[1]) }
        elseif ($line.Trim() -and $items.Count -gt 0 -and $line -match '^\s{2,}\S') { $items[$items.Count - 1] += ' ' + $line.Trim() }
        elseif ($line.Trim() -and $items.Count -eq 0) {
            # Single-paragraph form: "1) ... 2) ..."
            $parts = [regex]::Split($line.Trim(), '(?:^|\s)\d+\)\s+') | Where-Object { $_.Trim() }
            foreach ($p in $parts) { $items.Add($p.Trim()) }
        }
    }
    if (-not $sawSection -or $items.Count -eq 0) { return @() }
    # Single-paragraph form "1) a. 2) b." arrives as one item: split it.
    if ($items.Count -eq 1 -and $items[0] -match '\s\d+\)\s') {
        $first = $items[0]; $items.Clear()
        foreach ($p in ([regex]::Split($first, '\s*\b\d+\)\s+') | Where-Object { $_.Trim() })) { $items.Add($p.Trim()) }
    }
    $seen = @{}
    foreach ($t in $items) {
        $id = Get-AlCriterionId $t
        if (-not $seen.ContainsKey($id)) { $seen[$id] = $true; [pscustomobject][ordered]@{ id = $id; text = $t } }
    }
}

function New-AcceptanceEvidence {
    param(
        [Parameter(Mandatory)][ValidateSet('test', 'file', 'commit', 'artifact', 'human-review', 'baseline', 'finding', 'self-assessment')][string]$Kind,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'inconclusive', 'skipped')][string]$Result,
        [Parameter(Mandatory)][string]$CommitSha,
        [Parameter(Mandatory)][string]$PolicyRevision,
        [string]$Reviewer = '', [string]$Sha256 = '', [string]$RecordedAt = ''
    )
    if ($Kind -eq 'human-review' -and -not $Reviewer) { throw 'human-review evidence requires a reviewer' }
    if (-not $RecordedAt) { $RecordedAt = [datetime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) }
    $e = [ordered]@{ kind = $Kind; ref = $Ref; result = $Result; commitSha = $CommitSha; policyRevision = $PolicyRevision; recordedAt = $RecordedAt; stale = $false }
    if ($Reviewer) { $e.reviewer = $Reviewer }
    if ($Sha256) { $e.sha256 = $Sha256 }
    [pscustomobject]$e
}

function ConvertFrom-BaselineComparison {
    # Adapt a baseline comparison (the `baseline` page item of Invoke-VerificationQuery, #99-#101):
    # a regression named by a criterion's test IDs is failing evidence, otherwise passing.
    param([Parameter(Mandatory)]$Baseline, [Parameter(Mandatory)][string[]]$TestIds, [Parameter(Mandatory)][string]$CommitSha, [Parameter(Mandatory)][string]$PolicyRevision)
    $regressions = @($Baseline.regressions)
    # Optional per-run dispositions (#664): { testId = <disposition class> }. Blocking classes fail,
    # unknown / infra-failure / untested are inconclusive and never pass.
    $dispositions = $Baseline.dispositions
    foreach ($t in $TestIds) {
        $d = if ($dispositions) { $dispositions.$t } else { $null }
        $res = if ($d -in @('new', 'worsened', 'reopened')) { 'fail' }
               elseif ($d -in @('unknown', 'infra-failure', 'untested')) { 'inconclusive' }
               elseif ($regressions -contains $t) { 'fail' } else { 'pass' }
        New-AcceptanceEvidence -Kind baseline -Ref "$($Baseline.baselineRunId):$t" -Result $res -CommitSha $CommitSha -PolicyRevision $PolicyRevision
    }
}

function ConvertFrom-FindingsSummary {
    # Adapt a concise-findings summary (#103): any blocking finding fails the criterion.
    param([Parameter(Mandatory)]$Findings, [Parameter(Mandatory)][string]$Ref, [Parameter(Mandatory)][string]$CommitSha, [Parameter(Mandatory)][string]$PolicyRevision)
    $blocking = @($Findings | Where-Object { $_.blocking -eq $true })
    New-AcceptanceEvidence -Kind finding -Ref $Ref -Result $(if ($blocking.Count) { 'fail' } else { 'pass' }) -CommitSha $CommitSha -PolicyRevision $PolicyRevision
}

function New-AcceptanceLedger {
    param([Parameter(Mandatory)][int]$Issue, [Parameter(Mandatory)]$Criteria, [Parameter(Mandatory)][string]$CommitSha, [Parameter(Mandatory)][string]$PolicyRevision, [string]$ReviewDecision = '')
    $l = [ordered]@{
        schemaVersion = 1; issue = $Issue; commitSha = $CommitSha; policyRevision = $PolicyRevision
        criteria = @($Criteria | ForEach-Object { [pscustomobject][ordered]@{ id = $_.id; text = $_.text; state = 'unverified'; evidence = @() } })
    }
    if ($ReviewDecision) { $l.reviewDecision = $ReviewDecision }
    [pscustomobject]$l
}

function Add-AcceptanceEvidence {
    param([Parameter(Mandatory)]$Ledger, [Parameter(Mandatory)][string]$CriterionId, [Parameter(Mandatory)]$Evidence)
    $c = $Ledger.criteria | Where-Object { $_.id -eq $CriterionId }
    if (-not $c) { throw "unknown criterion $CriterionId" }
    $c.evidence = @($c.evidence) + @($Evidence)
    $Ledger
}

function Update-AcceptanceLedger {
    # Recompute stale flags and states against the current head and policy revision.
    param([Parameter(Mandatory)]$Ledger, [Parameter(Mandatory)][string]$HeadSha, [Parameter(Mandatory)][string]$PolicyRevision)
    $Ledger.commitSha = $HeadSha
    $Ledger.policyRevision = $PolicyRevision
    foreach ($c in $Ledger.criteria) {
        foreach ($e in @($c.evidence)) { $e.stale = ($e.commitSha -ne $HeadSha) -or ($e.policyRevision -ne $PolicyRevision) }
        $live = @($c.evidence | Where-Object { -not $_.stale -and $script:AlDeterministicKinds -contains $_.kind })
        if ($live | Where-Object { $_.result -eq 'fail' }) { $c.state = 'failed' }
        elseif ($live | Where-Object { $_.result -eq 'pass' }) { $c.state = 'verified' }
        else { $c.state = 'unverified' }
    }
    $Ledger
}

function ConvertTo-AlCell([string]$Text) { ($Text -replace '\|', '\|' -replace '\r?\n', ' ').Trim() }

function ConvertTo-AcceptanceMarkdown {
    param([Parameter(Mandatory)]$Ledger)
    $short = if ($Ledger.commitSha.Length -gt 12) { $Ledger.commitSha.Substring(0, 12) } else { $Ledger.commitSha }
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine($script:AlMarkerBegin)
    [void]$sb.AppendLine('### Acceptance criteria verification')
    $rd = if ($Ledger.PSObject.Properties['reviewDecision'] -and $Ledger.reviewDecision) { $Ledger.reviewDecision } else { 'none' }
    [void]$sb.AppendLine("Head ``$short`` | policy ``$($Ledger.policyRevision)`` | GitHub review: $rd")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| ID | Criterion | State | Evidence |')
    [void]$sb.AppendLine('| --- | --- | --- | --- |')
    foreach ($c in $Ledger.criteria) {
        $ev = @($c.evidence | ForEach-Object {
            $tag = if ($_.stale) { 'STALE ' } elseif ($_.kind -eq 'self-assessment') { 'IGNORED ' } else { '' }
            $who = if ($_.PSObject.Properties['reviewer'] -and $_.reviewer) { " by $($_.reviewer)" } else { '' }
            "$tag$($_.kind) ``$($_.ref)`` $($_.result)$who @$($_.commitSha.Substring(0, [Math]::Min(7, $_.commitSha.Length)))"
        })
        $evText = if ($ev.Count) { ($ev -join '<br>') } else { 'no evidence (untested)' }
        [void]$sb.AppendLine("| $($c.id) | $(ConvertTo-AlCell $c.text) | $($c.state) | $(ConvertTo-AlCell $evText) |")
    }
    [void]$sb.Append($script:AlMarkerEnd)
    $sb.ToString()
}

function Update-AcceptancePrBody {
    # Idempotent: replaces the delimited section, or appends it once.
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Body, [Parameter(Mandatory)][string]$Section)
    $pattern = '(?s)' + [regex]::Escape($script:AlMarkerBegin) + '.*?' + [regex]::Escape($script:AlMarkerEnd)
    if ($Body -match $pattern) { return [regex]::Replace($Body, $pattern, { param($m) $Section }) }
    if (-not $Body.Trim()) { return $Section }
    $Body.TrimEnd() + "`n`n" + $Section + "`n"
}
