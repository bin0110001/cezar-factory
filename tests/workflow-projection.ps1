#!/usr/bin/env pwsh
# Deterministic, negative and E2E fixture tests for the GitHub workflow projection (issue #767). Local only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/workflow-projection-lib.ps1')
$failures = 0
function Check([string]$name, [bool]$c) { if ($c) { Write-Host "  ok   $name" } else { Write-Host "  FAIL $name"; $script:failures++ } }
$policy = Get-WorkflowProjectionPolicy
$schema = Get-Content -Raw (Join-Path $PSScriptRoot '../schemas/workflow-projection.schema.json') | ConvertFrom-Json
$wm = '2026-01-01T00:00:00Z'
function Ev($id, $t, $label, $actor = 'person', $issue = 1, $type = 'label-added') { [pscustomobject]@{ eventId = $id; timestamp = $t; issue = $issue; type = $type; label = $label; actor = $actor } }
function Issue($n, $state, $rev, $labels) { [pscustomobject]@{ issue = $n; state = $state; revision = $rev; labels = $labels } }

Write-Host '-- schema and policy'
Check 'schema and policy share the version' ($schema.properties.schemaVersion.const -eq $policy.schemaVersion)
Check 'every mapped state has a unique label' (@($policy.labelToState.Values | Select-Object -Unique).Count -eq $policy.labelToState.Count)

Write-Host '-- missed, duplicated and out-of-order events converge'
$events = @((Ev 'e3' '2026-02-01T10:03:00Z' 'factory:review'), (Ev 'e1' '2026-02-01T10:01:00Z' 'factory:ready'), (Ev 'e2' '2026-02-01T10:02:00Z' 'factory:working'), (Ev 'e2' '2026-02-01T10:02:00Z' 'factory:working'))
$ledger = New-ProjectionLedger $wm
$a = ConvertTo-WorkflowSignals $events $policy $ledger
$b = ConvertTo-WorkflowSignals ($events | Sort-Object eventId -Descending) $policy $ledger
Check 'duplicates dropped, ordered by time' (($a.eventId -join ',') -eq 'e1,e2,e3')
Check 'reordered input yields the identical signal list' (($b.eventId -join ',') -eq ($a.eventId -join ','))
$issues = @((Issue 1 'reviewing' 3 @('factory:working')))
$r1 = Invoke-ProjectionReconcile $events $issues 'ok' $policy $ledger
Check 'first pass publishes once' ($r1.plans[0].status -eq 'published' -and $r1.plans[0].addLabel -eq 'factory:review' -and $r1.plans[0].removeLabels -contains 'factory:working')
$r2 = Invoke-ProjectionReconcile $events @((Issue 1 'reviewing' 3 @('factory:review'))) 'ok' $policy $r1.ledger
Check 'replay of the same events admits no signals and no write (no ping-pong)' ($r2.signals.Count -eq 0 -and $r2.plans[0].status -eq 'noop')
$r3 = Invoke-ProjectionReconcile $events @((Issue 1 'reviewing' 3 @('factory:review'))) 'ok' $policy $r2.ledger
Check 'repeat is stable' ($r3.plans[0].status -eq 'noop' -and $r3.plans[0].idempotencyKey -eq $r1.plans[0].idempotencyKey)

Write-Host '-- loop guard and no-replay watermark'
$own = @((Ev 'f1' '2026-02-02T00:00:00Z' 'factory:review' 'factory-investigator'), [pscustomobject]@{ eventId = 'f2'; timestamp = '2026-02-02T00:01:00Z'; issue = 1; type = 'label-added'; label = 'factory:review'; actor = 'x'; body = $r1.plans[0].marker })
Check 'Factory-authored label events are not inbound signals' ((ConvertTo-WorkflowSignals $own $policy $ledger).Count -eq 0)
Check 'events at or before the watermark never admit work' ((ConvertTo-WorkflowSignals @((Ev 'h1' '2025-12-31T00:00:00Z' 'factory:ready')) $policy $ledger).Count -eq 0)

Write-Host '-- GitHub API outage and restricted write'
$o = Invoke-ProjectionReconcile @() @((Issue 2 'implementing' 1 @('factory:ready'))) 'outage' $policy $ledger
Check 'outage queues projection with actionable evidence; no write claimed' ($o.plans[0].status -eq 'queued' -and $o.plans[0].reason -eq 'api_outage' -and $o.plans[0].evidence -match 'queued' -and -not $o.ledger.published.ContainsKey('2'))
$rec = Invoke-ProjectionReconcile @() @((Issue 2 'implementing' 1 @('factory:ready'))) 'ok' $policy $o.ledger
Check 'recovery publishes idempotently and clears the queue' ($rec.plans[0].status -eq 'published' -and -not $rec.ledger.queued.ContainsKey('2'))
$rw = Invoke-ProjectionReconcile @() @((Issue 2 'implementing' 1 @('factory:ready'))) 'restricted' $policy $ledger
Check 'restricted write is waiting, not failed' ($rw.plans[0].status -eq 'waiting' -and $rw.plans[0].reason -eq 'restricted_write')
Check 'webhook loss becomes UNKNOWN evidence' ((Get-WebhookLossRecord 1 ([datetime]'2026-02-01T00:00:00Z') ([datetime]'2026-02-01T05:00:00Z') $policy).reason -eq 'webhook_loss')
Check 'fresh events are not webhook loss' ($null -eq (Get-WebhookLossRecord 1 ([datetime]'2026-02-01T00:00:00Z') ([datetime]'2026-02-01T00:10:00Z') $policy))

Write-Host '-- manual label edits and precedence'
$m = Invoke-ProjectionReconcile @() @((Issue 3 'implementing' 1 @('factory:review'))) 'ok' $policy $ledger
Check 'manual edit on an automated state is reprojected' ($m.plans[0].status -eq 'published' -and $m.plans[0].drift[0].reason -eq 'manual_label_edit' -and $m.plans[0].drift[0].resolution -eq 'reprojected')
$h = Invoke-ProjectionReconcile @() @((Issue 3 'implementing' 1 @('factory:needs-help'))) 'ok' $policy $ledger
Check 'human-owned state edit is accepted, not overwritten' ($h.plans[0].status -eq 'waiting' -and $h.plans[0].drift[0].resolution -eq 'accepted')
$d = Invoke-ProjectionReconcile @() @((Issue 3 'ready' 1 @('factory:ready', 'factory:working'))) 'ok' $policy $ledger
Check 'duplicate state labels are repaired' ($d.plans[0].removeLabels -contains 'factory:working' -and $d.plans[0].drift[0].reason -eq 'duplicate_label')

Write-Host '-- approval independence (negative)'
$spoof = [pscustomobject]@{ labels = @('approved', 'factory:review', 'ocr:clean'); headSha = 'a'; mergeable = 'MERGEABLE'; reviews = @([pscustomobject]@{ author = 'ocr'; state = 'APPROVED'; authorAssociation = 'NONE'; isBot = $true; submittedAt = '2026-02-01T00:00:00Z'; commit = 'a' }) }
Check 'approval-looking label and OCR clean review are not approval' (-not (Test-ApprovalCondition $spoof).satisfied)
$real = [pscustomobject]@{ headSha = 'a'; mergeable = 'MERGEABLE'; reviews = @([pscustomobject]@{ author = 'maint'; state = 'APPROVED'; authorAssociation = 'OWNER'; isBot = $false; submittedAt = '2026-02-01T00:00:00Z'; commit = 'a' }) }
Check 'real maintainer approval on head satisfies' ((Test-ApprovalCondition $real).satisfied)
$stale = [pscustomobject]@{ headSha = 'b'; mergeable = 'MERGEABLE'; reviews = $real.reviews }
Check 'approval of an older commit does not satisfy' (-not (Test-ApprovalCondition $stale).satisfied)
$cr = [pscustomobject]@{ headSha = 'a'; mergeable = 'MERGEABLE'; reviews = @($real.reviews[0], [pscustomobject]@{ author = 'maint'; state = 'CHANGES_REQUESTED'; authorAssociation = 'OWNER'; isBot = $false; submittedAt = '2026-02-02T00:00:00Z'; commit = 'a' }) }
Check 'later changes-requested revokes approval' (-not (Test-ApprovalCondition $cr).satisfied)
$prot = [pscustomobject]@{ headSha = 'a'; mergeable = 'MERGEABLE'; protectionsSatisfied = $false; reviews = $real.reviews }
Check 'unsatisfied protections block approval' (-not (Test-ApprovalCondition $prot).satisfied)
$unk = Test-ApprovalCondition $null
Check 'unreadable review state is UNKNOWN' ($unk.status -eq 'unknown' -and $unk.reason -eq 'approval_unverified')

Write-Host '-- migration receipts'
$mig = @(New-MigrationReceipts @((Issue 9 '' 0 @('factory:ready', 'bug')), (Issue 10 '' 0 @('factory:ready', 'factory:working')), (Issue 11 '' 0 @('factory:done'))) $policy $wm)
Check 'existing labels map per versioned table' ($mig[0].state -eq 'ready' -and $mig[2].state -eq 'done' -and $mig[0].mappingVersion -eq 1)
Check 'ambiguous labels map to unknown' ($mig[1].state -eq 'unknown')
Check 'migration never admits historical work' (@($mig | Where-Object admission -ne 'none').Count -eq 0)

Write-Host '-- redaction'
$all = ($r1.plans | ConvertTo-Json -Depth 6) + ($mig | ConvertTo-Json)
Check 'records carry no secrets' ($all -notmatch '(?i)ghp_|token|password|secret')
if ($failures) { Write-Host "$failures failure(s)"; exit 1 }
Write-Host 'workflow projection tests passed'
