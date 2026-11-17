#!/usr/bin/env pwsh
# Tests for scripts/acceptance-ledger.ps1 (#132).
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $factory 'scripts/acceptance-ledger.ps1')
$schema = Join-Path $factory 'schemas/acceptance-ledger.schema.json'
$script:failures = 0
function Check([string]$Name, [bool]$Condition) { if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ } }
function Validates($Ledger) { try { [bool](Test-Json -Json ($Ledger | ConvertTo-Json -Depth 8) -SchemaFile $schema -ErrorAction Stop) } catch { $false } }

$A = 'a' * 40; $B = 'b' * 40
$text = "## Objective`nx`n## Acceptance`n- Verified criterion`n- [ ] Failed criterion`n- Untested criterion`n- Self only criterion`n- Verified criterion`n## Non-goals`n- not a criterion`n"
$crit = @(ConvertFrom-AcceptanceCriteria -Text $text)
Check 'parses 4 unique criteria, stops at next heading' ($crit.Count -eq 4)
Check 'ids are stable' ($crit[0].id -eq (Get-AlCriterionId 'verified   criterion'))
$inline = @(ConvertFrom-AcceptanceCriteria -Text "**Acceptance criteria**`n1) one thing. 2) two thing.`n**Non-goals**`nnone")
Check 'parses inline numbered form' ($inline.Count -eq 2 -and $inline[1].text -eq 'two thing.')
Check 'no acceptance section yields none' (@(ConvertFrom-AcceptanceCriteria -Text 'just text').Count -eq 0)

$l = New-AcceptanceLedger -Issue 132 -Criteria $crit -CommitSha $A -PolicyRevision 'p1'
Add-AcceptanceEvidence $l $crit[0].id (New-AcceptanceEvidence -Kind test -Ref 't-1' -Result pass -CommitSha $A -PolicyRevision 'p1') | Out-Null
Add-AcceptanceEvidence $l $crit[1].id (New-AcceptanceEvidence -Kind test -Ref 't-2' -Result fail -CommitSha $A -PolicyRevision 'p1') | Out-Null
Add-AcceptanceEvidence $l $crit[3].id (New-AcceptanceEvidence -Kind self-assessment -Ref 'agent says done' -Result pass -CommitSha $A -PolicyRevision 'p1') | Out-Null
Update-AcceptanceLedger $l -HeadSha $A -PolicyRevision 'p1' | Out-Null
Check 'verified' ($l.criteria[0].state -eq 'verified')
Check 'failed' ($l.criteria[1].state -eq 'failed')
Check 'missing evidence is unverified' ($l.criteria[2].state -eq 'unverified')
Check 'self-assessment alone is unverified' ($l.criteria[3].state -eq 'unverified')
Check 'inconclusive/skipped do not verify' ($(
    $x = New-AcceptanceLedger -Issue 1 -Criteria $crit[2] -CommitSha $A -PolicyRevision 'p1'
    Add-AcceptanceEvidence $x $crit[2].id (New-AcceptanceEvidence -Kind test -Ref 't' -Result skipped -CommitSha $A -PolicyRevision 'p1') | Out-Null
    (Update-AcceptanceLedger $x -HeadSha $A -PolicyRevision 'p1').criteria[0].state -eq 'unverified'))
Check 'human review needs reviewer' ($(try { New-AcceptanceEvidence -Kind human-review -Ref 'pr#1' -Result pass -CommitSha $A -PolicyRevision 'p1'; $false } catch { $true }))
Check 'ledger validates against schema' (Validates $l)

$md1 = ConvertTo-AcceptanceMarkdown $l
Check 'markdown shows state and untested' ($md1 -match 'no evidence \(untested\)' -and $md1 -match 'IGNORED self-assessment')
$body = Update-AcceptancePrBody -Body 'Closes #132' -Section $md1
$body2 = Update-AcceptancePrBody -Body $body -Section $md1
Check 'PR body update is idempotent' ($body -eq ($body2.TrimEnd() + "`n") -or $body -eq $body2)
Check 'single section' (([regex]::Matches($body2, 'factory-acceptance-ledger:begin')).Count -eq 1 -and $body2 -match 'Closes #132')

# New commit: evidence is stale and criteria revert to unverified.
Update-AcceptanceLedger $l -HeadSha $B -PolicyRevision 'p1' | Out-Null
Check 'new commit marks evidence stale' ($l.criteria[0].evidence[0].stale -eq $true)
Check 'stale verified reverts to unverified' ($l.criteria[0].state -eq 'unverified' -and $l.criteria[1].state -eq 'unverified')
Check 'stale shown in markdown' ((ConvertTo-AcceptanceMarkdown $l) -match 'STALE test')
# Re-record on the new commit, then change the policy.
Add-AcceptanceEvidence $l $crit[0].id (New-AcceptanceEvidence -Kind human-review -Ref 'pr#1' -Reviewer 'maint' -Result pass -CommitSha $B -PolicyRevision 'p1') | Out-Null
Update-AcceptanceLedger $l -HeadSha $B -PolicyRevision 'p1' | Out-Null
Check 'fresh evidence verifies again' ($l.criteria[0].state -eq 'verified')
Update-AcceptanceLedger $l -HeadSha $B -PolicyRevision 'p2' | Out-Null
Check 'policy change stales evidence' ($l.criteria[0].state -eq 'unverified')

# Reuse of baseline comparison and findings outputs.
$bl = ConvertFrom-BaselineComparison -Baseline ([pscustomobject]@{ baselineRunId = 'run-a'; regressions = @('t-2') }) -TestIds @('t-1', 't-2') -CommitSha $A -PolicyRevision 'p1'
Check 'baseline regression becomes failing evidence' (($bl | Where-Object ref -eq 'run-a:t-2').result -eq 'fail' -and ($bl | Where-Object ref -eq 'run-a:t-1').result -eq 'pass')
$dl = ConvertFrom-BaselineComparison -Baseline ([pscustomobject]@{ baselineRunId = 'run-b'; regressions = @(); dispositions = [pscustomobject]@{ 't-1' = 'known'; 't-2' = 'unknown'; 't-3' = 'infra-failure'; 't-4' = 'new'; 't-5' = 'resolved' } }) -TestIds @('t-1', 't-2', 't-3', 't-4', 't-5') -CommitSha $A -PolicyRevision 'p1'
Check 'dispositions: known/resolved pass, unknown/infra never pass, new fails' ((($dl | Where-Object ref -eq 'run-b:t-1').result -eq 'pass') -and (($dl | Where-Object ref -eq 'run-b:t-5').result -eq 'pass') -and (($dl | Where-Object ref -eq 'run-b:t-2').result -eq 'inconclusive') -and (($dl | Where-Object ref -eq 'run-b:t-3').result -eq 'inconclusive') -and (($dl | Where-Object ref -eq 'run-b:t-4').result -eq 'fail'))
Check 'blocking finding fails' ((ConvertFrom-FindingsSummary -Findings @([pscustomobject]@{ blocking = $true }) -Ref 'f' -CommitSha $A -PolicyRevision 'p1').result -eq 'fail')

if ($script:failures) { Write-Host "$script:failures failed"; exit 1 }
Write-Host 'acceptance ledger tests passed'
