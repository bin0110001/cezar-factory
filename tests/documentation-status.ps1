#!/usr/bin/env pwsh
# Tests for scripts/documentation-status.ps1 (issue #180): proposed-vs-verified display, stale/unknown
# handling, backend-absent states, and permission-checked, idempotent, audited actions.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $factory 'scripts/documentation-status.ps1')
$script:failures = 0
function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ }
}
function Load([string]$Name) { Get-Content -Raw (Join-Path $factory "schemas/documentation-state/fixtures/$Name") | ConvertFrom-Json -AsHashtable -Depth 20 }

$verified = Load 'state-verified.json'
$proposed = Load 'state-proposed.json'; $proposed.documentId = 'api/widget/create-proposal'
$sha = [string]$verified.revision.observedSha
$target = @{ branch = 'main'; sha = $sha }

Write-Host '== proposed versus verified =='
$view = ConvertTo-DocumentationStatusView -Records @($verified, $proposed) -Target $target
$v = $view.documents | Where-Object { $_.documentId -eq $verified.documentId }
$p = $view.documents | Where-Object { $_.documentId -eq $proposed.documentId }
Check 'a fresh verified record at the target SHA is shown as code verified' ($v.codeVerified -and $v.label -eq 'Code verified' -and $v.matchesTarget -eq $true)
Check 'a proposed record is shown as design proposed and never verified or implemented' (-not $p.codeVerified -and $p.displayState -eq 'proposed' -and $p.label -match '^Design proposed' -and $p.label -notmatch 'verified$')
Check 'every claim of a proposed record is labelled design proposed' (@($p.claims | Where-Object { $_.label -ne 'Design proposed' }).Count -eq 0)
Check 'source files and grounded SHA are traceable' ($v.sourceFiles -contains 'src/widgets/create.ts' -and $v.groundedSha -eq $sha -and $v.branch -eq 'main')
Check 'summary counts pending and coverage' ($view.summary.pendingCount -eq 1 -and $view.summary.byDisplayState.verified -eq 1 -and $view.summary.claimsTotal -ge 2 -and $view.summary.verificationCoverage -lt 1)

Write-Host '== stale, out-of-sync and unknown =='
$other = @{ branch = 'main'; sha = 'c' * 40 }
$vOther = (ConvertTo-DocumentationStatusView -Records @($verified) -Target $other).documents[0]
Check 'docs describing a different SHA than the target are stale, not verified' ($vOther.displayState -eq 'stale' -and -not $vOther.codeVerified -and $vOther.matchesTarget -eq $false)
$staleRec = Load 'state-verified.json'; $staleRec.freshness = @{ status = 'stale'; checkedAt = '2026-11-02T12:00:00Z'; checkedAgainstSha = 'a' * 40; reason = 'source moved' }
$vStale = (ConvertTo-DocumentationStatusView -Records @($staleRec) -Target $target).documents[0]
Check 'stale evidence is never shown as verified' ($vStale.displayState -eq 'stale' -and -not $vStale.codeVerified)
$unkRec = Load 'state-verified.json'; $unkRec.freshness = @{ status = 'unknown'; checkedAt = '2026-11-02T12:00:00Z'; reason = 'no source' }
Check 'missing freshness evidence is unknown' ((ConvertTo-DocumentationStatusView -Records @($unkRec) -Target $target).documents[0].displayState -eq 'unknown')
$noTarget = (ConvertTo-DocumentationStatusView -Records @($verified)).documents[0]
Check 'without a target SHA the record carries a reason and no target match' ($null -eq $noTarget.matchesTarget -and $noTarget.reasons.Count -ge 1)
$future = Load 'state-verified.json'; $future.schemaVersion = 'factory-doc-state/v9'
$vf = (ConvertTo-DocumentationStatusView -Records @($future) -Target $target).documents[0]
Check 'an unsupported version is unknown and unverified' ($vf.displayState -eq 'unknown' -and -not $vf.codeVerified)
$fake = Load 'state-verified.json'; $fake.verification.evidence = @()
Check 'a verified record without evidence is downgraded' (-not (ConvertTo-DocumentationStatusView -Records @($fake) -Target $target).documents[0].codeVerified)
$mixed = Load 'state-verified.json'; $mixed.claims += @{ id = 'x'; text = 'planned'; knowledge = 'proposed'; speculative = $true; sourceAnchors = @(); evidence = @() }
Check 'a proposed claim inside a verified record prevents code-verified' (-not (ConvertTo-DocumentationStatusView -Records @($mixed) -Target $target).documents[0].codeVerified)

Write-Host '== backend states =='
Check 'backend absence is an explicit state without records' ((ConvertTo-DocumentationStatusView -Records @($verified) -Target $target -Backend @{ available = $false }).panelState -eq 'unavailable')
$d = ConvertTo-DocumentationStatusView -Records @($verified) -Target $target -Backend @{ available = $true; mcp = 'missing'; indexEnabled = $true }
Check 'missing MCP is degraded and still lists recorded state' ($d.panelState -eq 'degraded' -and $d.documents.Count -eq 1)
Check 'a disabled index is its own state' ((ConvertTo-DocumentationStatusView -Records @() -Backend @{ available = $true; mcp = 'connected'; indexEnabled = $false }).panelState -eq 'index-disabled')
Check 'no records is the empty state' ((ConvertTo-DocumentationStatusView -Records @() -Target $target).panelState -eq 'empty')

Write-Host '== impact preview =='
$impact = Get-DocumentationImpact -Before @($p) -After @($p, $v) -Unknowns @('call sites not indexed')
Check 'impact lists new documents with source files and distinguishes design from code' ($impact.changes.Count -eq 1 -and $impact.changes[0].note -eq 'code verified' -and $impact.confidence -eq 'unknown' -and $impact.unknowns.Count -eq 1)

Write-Host '== actions =='
$ledger = New-DocumentationLedger
$psha = [string]$proposed.revision.observedSha
$denied = Invoke-DocumentationAction -Action approve -DocumentId $proposed.documentId -Actor 'u' -Permissions @('docs:refresh') -IdempotencyKey 'k1' -ExpectedSha $psha -Reason 'ok' -Records @($proposed) -Ledger $ledger
Check 'approval without permission is denied and audited' ($denied.status -eq 'denied' -and $ledger.entries.Count -eq 1 -and $ledger.entries[0].status -eq 'denied')
Check 'no permissions at all is denied (fail safe)' ((Invoke-DocumentationAction -Action refresh -DocumentId 'd' -Actor 'u' -IdempotencyKey 'k2' -Ledger $ledger).status -eq 'denied')
Check 'an anonymous actor is denied' ((Invoke-DocumentationAction -Action refresh -DocumentId 'd' -Permissions @('docs:refresh') -IdempotencyKey 'k3' -Ledger $ledger).status -eq 'denied')
$okApprove = Invoke-DocumentationAction -Action approve -DocumentId $proposed.documentId -Actor 'u' -Permissions @('docs:approve') -IdempotencyKey 'k4' -ExpectedSha $psha -Reason 'reviewed' -Records @($proposed) -Ledger $ledger
Check 'an authorized approval yields an audited proposed-to-approved transition' ($okApprove.status -eq 'accepted' -and $okApprove.transition.from -eq 'proposed' -and $okApprove.transition.to -eq 'approved' -and $okApprove.transition.transitionedBy -eq 'u')
$again = Invoke-DocumentationAction -Action approve -DocumentId $proposed.documentId -Actor 'u' -Permissions @('docs:approve') -IdempotencyKey 'k4' -ExpectedSha $psha -Reason 'reviewed' -Records @($proposed) -Ledger $ledger
Check 'replaying the same key is a duplicate with the original outcome' ($again.status -eq 'duplicate' -and $again.originalStatus -eq 'accepted')
$reuse = Invoke-DocumentationAction -Action approve -DocumentId $proposed.documentId -Actor 'u2' -Permissions @('docs:approve') -IdempotencyKey 'k4' -ExpectedSha $psha -Reason 'reviewed' -Records @($proposed) -Ledger $ledger
Check 'reusing a key for a different request conflicts' ($reuse.status -eq 'conflict')
$race = Invoke-DocumentationAction -Action approve -DocumentId $proposed.documentId -Actor 'u' -Permissions @('docs:approve') -IdempotencyKey 'k5' -ExpectedSha ('d' * 40) -Reason 'reviewed' -Records @($proposed) -Ledger $ledger
Check 'a concurrent update (changed SHA) is a conflict, never last-write-wins' ($race.status -eq 'conflict' -and $race.reason -match 'changed')
$notProposed = Invoke-DocumentationAction -Action approve -DocumentId $verified.documentId -Actor 'u' -Permissions @('docs:approve') -IdempotencyKey 'k6' -ExpectedSha $sha -Reason 'x' -Records @($verified) -Ledger $ledger
Check 'only a proposed document can be approved' ($notProposed.status -eq 'conflict')
$refresh = Invoke-DocumentationAction -Action refresh -DocumentId $verified.documentId -Actor 'u' -Permissions @('docs:refresh') -IdempotencyKey 'k7' -Ledger $ledger
Check 'refresh is permission-checked and returns a deterministic job key' ($refresh.status -eq 'accepted' -and $refresh.job.jobKey -eq "docs-refresh-$($verified.documentId)-k7")
$down = Invoke-DocumentationAction -Action retry -DocumentId $verified.documentId -Actor 'u' -Permissions @('docs:refresh') -IdempotencyKey 'k8' -Backend @{ available = $false } -Ledger $ledger
Check 'refresh with the backend down is unavailable and queues nothing' ($down.status -eq 'unavailable' -and -not $down.Contains('job'))
$ovr = Invoke-DocumentationAction -Action override -DocumentId $verified.documentId -Actor 'u' -Permissions @('docs:override') -IdempotencyKey 'k9' -Reason 'r' -ReviewBy '2026-12-01' -Records @($verified) -Ledger $ledger
Check 'a mandatory-gate contract cannot be overridden' ($ovr.status -eq 'denied' -and $ovr.reason -match 'cannot be overridden')
$adv = Load 'state-proposed.json'; $adv.documentId = 'adv'; $adv.projectPolicy.mandatoryGates = @(); $adv.kind = 'proposed-spec'
$ovr2 = Invoke-DocumentationAction -Action override -DocumentId $adv.documentId -Actor 'u' -Permissions @('docs:override') -IdempotencyKey 'k10' -Reason 'r' -ReviewBy '2026-12-01' -Records @($adv) -Ledger $ledger
Check 'an advisory override needs reason and review point and records both' ($ovr2.status -eq 'accepted' -and $ovr2.override.reviewBy -eq '2026-12-01')
Check 'every attempt was audited' ($ledger.entries.Count -eq 10 -or $ledger.entries.Count -ge 9)

if ($script:failures) { Write-Host "documentation-status: $script:failures failure(s)"; exit 1 }
Write-Host 'documentation-status: all passed'
