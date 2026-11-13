#!/usr/bin/env pwsh
# Factory self-test: static checks plus install/update/diff/verify scenarios against fixture projects.
param([switch]$StaticOnly)
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scripts = Join-Path $factory 'scripts'
# Hermetic: the review workflow runs this suite inside a Factory-managed run (validate-head), whose environment carries the
# lifecycle identity. route-state then defers factory:done until workspace integration, which is correct in a managed run but
# fails the unmanaged-route assertions. The managed behaviour is tested explicitly by setting the token itself.
foreach ($identity in 'FACTORY_FENCING_TOKEN', 'FACTORY_MANAGED', 'FACTORY_OWNER_ID', 'FACTORY_RUN_ID', 'FACTORY_ISSUE', 'FACTORY_WORKSPACE') { Remove-Item "Env:$identity" -ErrorAction SilentlyContinue }
. (Join-Path $scripts 'lib.ps1')
# Hermetic: scripts cache read-only gh listings for a couple of minutes; scenarios that reuse one fake gh with changing
# state must see every change. The cache itself is exercised explicitly below by setting the TTL.
$env:FACTORY_GH_CACHE_TTL_SECONDS = '0'

$script:fail = 0
function Assert([string]$Name, [bool]$Cond) {
    if ($Cond) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:fail++ }
}
function With($Base, $Over) { $h = $Base.Clone(); foreach ($k in $Over.Keys) { $h[$k] = $Over[$k] }; $h }
function Run([string]$Script, [hashtable]$Args2) {
    # Real child process, as CI and users run it (catches missing exit codes and strict-mode leaks).
    $argv = @('-NoProfile', '-File', (Join-Path $scripts $Script))
    foreach ($k in $Args2.Keys) { if ($Args2[$k] -is [bool] -or $Args2[$k] -is [System.Management.Automation.SwitchParameter]) { if ($Args2[$k]) { $argv += "-$k" } } else { $argv += "-$k", [string]$Args2[$k] } }
    # Expected-negative scenarios deliberately emit diagnostics on stderr. Keep
    # those diagnostics in the captured output instead of letting the parent
    # runner's Stop policy turn them into a test-harness exception.
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $out = & pwsh @argv *>&1 | Out-String
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }
    [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

function Copy-Factory([string]$From, [string]$To) {
    $sourceRoot = (Resolve-Path -LiteralPath $From).Path
    New-Item -ItemType Directory -Force $To | Out-Null
    $excludedDirectories = @('.git', 'tests', 'cezar', 'node_modules', '.factory')
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($sourceRoot)
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            if ($entry.PSIsContainer) {
                if ($entry.Name -in $excludedDirectories) { continue }
                $relative = [IO.Path]::GetRelativePath($sourceRoot, $entry.FullName)
                $destination = Join-Path $To $relative
                New-Item -ItemType Directory -Force -Path $destination | Out-Null
                $pending.Push($entry.FullName)
                continue
            }
            if ($entry.Name -match '^\.env(?:\..+)?$') { continue }
            $relative = [IO.Path]::GetRelativePath($sourceRoot, $entry.FullName)
            $destination = Join-Path $To $relative
            $parent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
            Copy-Item -LiteralPath $entry.FullName -Destination $destination -Force
        }
    }
}

# ---- Static checks -------------------------------------------------------
Write-Host '== static =='
$curVer = Get-FactoryVersion $factory
$required = 'README.md', 'VERSION', 'CHANGELOG.md', 'AGENTS.md', '.yamllint.yaml', '.githooks/pre-commit', 'docs/local-validation.md', 'scripts/deploy/install-boot-order.sh', 'tests/test-install-boot-order.sh', 'policies/labels.yaml', 'policies/lifecycle.json', 'scripts/lifecycle-lib.ps1', 'scripts/sweep-lifecycle.ps1', 'scripts/assert-no-run-commits.ps1', 'policies/retry.yaml', 'policies/risk.yaml',
'policies/retention.yaml', 'scripts/prune-events.ps1', 'policies/definition-of-ready.md', 'policies/definition-of-done.md', 'policies/escalation.md',
'policies/performance.yaml', 'schemas/performance-policy.schema.json', 'docs/performance-regression.md',
'templates/factory.config.yaml', 'templates/gitignore.fragment', 'docs/lifecycle.md', 'docs/synchronization.md', 'docs/project-integration.md',
'routing/default.yaml', 'integrations/deployment/README.md', 'integrations/bazzite/compose.yaml',
'integrations/bazzite/vault-config/vault.hcl', 'docs/vault.md', 'scripts/deploy/deploy-vault-bazzite.sh', 'scripts/deploy/validate-vault-bazzite.sh',
'docs/vault-live-evidence.md',
'integrations/bazzite/litellm-config.yaml', 'integrations/bazzite/prometheus.yml',
'integrations/bazzite/prometheus-alerts.yml', 'integrations/bazzite/grafana/dashboards/factory-overview.json',
'integrations/bazzite/grafana/provisioning/datasources/prometheus.yaml',
'integrations/bazzite/grafana/provisioning/dashboards/factory.yaml',
'integrations/mac-mini/vllm/compose.yaml', 'integrations/bazzite/openhands-compose.yaml', 'docs/vllm-cluster-notes.md', 'scripts/deploy/deploy-bazzite.sh',
'scripts/release/validate-release.ps1', 'integrations/hindsight/banks.yaml',
'integrations/hindsight/mcp.json', 'integrations/langfuse/README.md', 'docs/context-optimization.md',
'routing/local-jobs.yaml', 'scripts/deploy/validate-remote.sh', 'scripts/deploy/validate-openhands-workspace.sh', 'scripts/deploy/validate-openhands-acp.sh', 'scripts/deploy/Get-LiteLLMMasterKey.ps1',
'scripts/local/run-local-job.ps1', 'docs/openhands-integration.md', 'docs/local-utility-jobs.md',
'docs/openhands-live-evidence.md',
'docs/vllm-live-evidence.md',
'docs/litellm-live-evidence.md',
'docs/hindsight-live-evidence.md',
'docs/observability-live-evidence.md',
'docs/local-utility-live-evidence.md',
'docs/langfuse-live-evidence.md', 'docs/langfuse-operations.md',
'integrations/openhands/job-request.schema.json', 'integrations/openhands/job-result.schema.json',
'scripts/openhands/validate-job.ps1', 'scripts/openhands/run-job.py', 'tests/fixtures/openhands-job-request.json', 'tests/fixtures/openhands-failure-request.json', 'docs/operations-readiness.md',
'docs/local-coding-tool-evaluation.md',
'docs/routing-evaluation.md',
'docs/pilot-loop-evidence.md',
'docs/gpu-exporter-evaluation.md',
'scripts/deploy/deploy-vllm-mac.sh', 'scripts/deploy/validate-deployment.sh',
'scripts/deploy/vllm-trusted-proxy.py', 'scripts/deploy/deploy-vllm-trusted-proxy-mac.sh', 'scripts/deploy/validate-vllm-trusted-proxy-mac.sh',
'scripts/deploy/rotate-cezar-github-token.bat', 'docs/credential-rotation.md',
'routing/automation-catalog.json', 'schemas/automation-catalog.schema.json', 'schemas/memory-recall.schema.json', 'schemas/memory-candidate.schema.json', 'schemas/memory-record.schema.json', 'schemas/memory-retrieval-capture.schema.json', 'schemas/hindsight-deterministic-index.schema.json', 'docs/hindsight-provenance.md', 'skills/factory-learn/SKILL.md', 'tests/test_hindsight_client.py',
'schemas/factory-release/README.md', 'schemas/factory-release/manifest.schema.json', 'schemas/factory-release/state.schema.json', 'schemas/factory-release/receipt.schema.json', 'schemas/factory-release/lease.schema.json',
'schemas/factory-release/fixtures/manifest-valid.json', 'schemas/factory-release/fixtures/manifest-unknown-schema.json', 'schemas/factory-release/fixtures/receipt-active.json', 'schemas/factory-release/fixtures/receipt-incompatible.json', 'schemas/factory-release/fixtures/receipt-staged.json', 'schemas/factory-release/fixtures/state-verified.json', 'schemas/factory-release/fixtures/lease-active.json', 'schemas/factory-release/fixtures/lease-expired.json', 'schemas/factory-release/fixtures/artifact-payload.json', 'schemas/factory-release/fixtures/verification-evidence.json',
'scripts/validate-automation-catalog.ps1', 'scripts/collect-backlog-snapshot.ps1', 'scripts/reconcile-backlog.ps1', 'scripts/lease.ps1', 'scripts/hindsight/client.py', 'scripts/hindsight/recall.ps1', 'scripts/hindsight/retain.ps1', 'scripts/hindsight/incident.py', 'scripts/hindsight/incident.ps1', 'tests/test_factory_hindsight_incident.py',
'scripts/record-local-evaluation.ps1', 'scripts/evaluate-local-promotion.ps1', 'scripts/audit-backlog-labels.ps1', 'scripts/audit-shadow-copies.ps1', 'schemas/shadow-audit-receipt.schema.json', 'scripts/push-factory-updates.ps1', 'scripts/onboard-project.ps1', 'scripts/force-update.ps1', 'scripts/update-github-lifecycle.ps1', 'scripts/sync-issue-delivery.ps1', 'scripts/gh-cache.ps1', 'tests/fake-delivery-gh.ps1', 'scripts/refresh-stale-workable.ps1', 'scripts/maintain-repository.ps1', 'config/factory-projects.json.example', 'skills/factory-release/SKILL.md', 'schemas/local-evaluation.schema.json', 'docs/local-model-evaluation.md',
'scripts/ensure-investigation-result.ps1', 'scripts/recover-audit-reservations.ps1', 'scripts/validate-backlog-label-audit-input.ps1', 'scripts/apply-backlog-label-audit.ps1',
'docs/execution-inventory.md', 'docs/backlog-reconciler.md', 'docs/factory-automation-status.md', 'docs/workflow-map.md', 'skills/factory-work-backlog/SKILL.md', 'skills/factory-backlog-label-audit/SKILL.md', 'workflows/maintenance.yaml', 'automations/maintenance.json', 'workflows/health.yaml', 'automations/health.json', 'tests/fake-backlog-gh.ps1', 'tests/fixtures/backlog-issues.json',
'workflows/godot-upgrade.yaml', 'automations/godot-upgrade.json', 'skills/factory-godot-upgrade/SKILL.md', 'scripts/godot-upgrade.ps1', 'cezar/godot-install.sh', 'cezar/godot-select.sh', 'skills/factory-workspace/SKILL.md', 'docs/workspace-lifecycle.md', 'integrations/agents/workspace-lifecycle/codex-hooks.json', 'integrations/agents/workspace-lifecycle/claude-settings.fragment.json',
'scripts/release/promote-stable.ps1', 'scripts/release/factory_release_controller.py', 'scripts/release/factory_incident_ledger.py', 'scripts/release/factory_drift_repair.py', 'scripts/release/factory_project_channels.py', 'tests/test_factory_project_channels.py', 'docs/project-channels.md', 'scripts/release/factory_self_healing.py', 'scripts/release/factory_activation.py', 'tests/test_factory_release_controller.py', 'tests/test_factory_incident_ledger.py', 'tests/test_factory_drift_repair.py', 'tests/test_factory_self_healing.py', 'tests/test_factory_activation.py', 'docs/factory-release-controller.md', 'workflows/release-self-healing.yaml', 'workflows/release-fix-pr.yaml', 'scripts/sync-all-automations.ps1', 'scripts/migrate-to-shared.ps1', 'scripts/deploy/factory-autodeploy.sh', 'scripts/deploy/deploy-cezar-runtime.sh', 'scripts/deploy/reconcile-container-git-metadata.sh', 'integrations/bazzite/factory-autodeploy.service', 'integrations/bazzite/factory-autodeploy.timer', 'integrations/bazzite/factory-release-controller.service', 'integrations/bazzite/factory-release-controller.timer', 'docs/shared-factory.md',
'scripts/check-release-locks.py', 'tests/test_factory_legacy_push_lock.py',
'tests/test-factory-autodeploy.sh', 'tests/test-deploy-cezar-runtime.sh', 'tests/test-reconcile-container-git-metadata.sh',
'integrations/bazzite/standalone/blackbox.yml', 'integrations/bazzite/standalone/factory-blackbox.container.template', 'scripts/deploy/deploy-prometheus-standalone.sh', 'integrations/bazzite/standalone/prometheus.yml', 'integrations/bazzite/standalone/factory-prometheus.container.template', 'scripts/probe-model-endpoint.ps1', 'scripts/factory/protect-governance.ps1', 'policies/protected-assets.json', 'schemas/governance-authorization.schema.json', 'tests/protect-governance.ps1', 'tests/fake-gh-governance.ps1', 'docs/governance-guard.md', 'tests/model-probe.ps1', 'tests/fake-model-server.ps1', 'scripts/publish-failure-audit.ps1', 'scripts/write-health-report.ps1', 'tests/health-report.ps1', 'schemas/failure-audit-publication.schema.json', 'tests/failure-audit-publisher.ps1', 'tests/fake-gh-publisher.ps1', 'schemas/backlog-label-audit-proposal.schema.json', 'workflows/repair-probe.yaml', 'automations/repair-probe.json', 'tests/test_factory_repair_replay.py', 'tests/replay/maintenance-considered-failure.json'
'integrations/bazzite/standalone/blackbox.yml', 'integrations/bazzite/standalone/factory-blackbox.container.template', 'scripts/deploy/deploy-prometheus-standalone.sh', 'integrations/bazzite/standalone/prometheus.yml', 'integrations/bazzite/standalone/factory-prometheus.container.template', 'scripts/probe-model-endpoint.ps1', 'tests/model-probe.ps1', 'tests/fake-model-server.ps1', 'scripts/publish-failure-audit.ps1', 'scripts/write-health-report.ps1', 'tests/health-report.ps1', 'schemas/failure-audit-publication.schema.json', 'tests/failure-audit-publisher.ps1', 'tests/fake-gh-publisher.ps1', 'scripts/verification-query.ps1', 'tests/verification-query.ps1', 'schemas/verification-query.schema.json', 'docs/verification-query.md'
'scripts/release/factory_local_scheduler.py', 'tests/test_factory_local_scheduler.py', 'config/local-release-scheduler.json.example', 'schemas/factory-release/promotion-record.schema.json', 'schemas/factory-release/fixtures/promotion-healthy.json', 'integrations/bazzite/factory-local-promotion.service', 'integrations/bazzite/factory-local-promotion.timer',
'schemas/routing-event.schema.json', 'docs/routing-events.md', 'cezar/packages/cezar/src/server/routing-events/routing-events.test.ts',
'scripts/release/factory_promotion.py', 'scripts/release/validate-in-container.sh', 'config/promotion-policy.json', 'tests/test_factory_promotion.py', 'tests/test_factory_promotion_pipeline.py', 'docs/promotion-pipeline.md',
'policies/evidence-retention.yaml', 'schemas/evidence-manifest.schema.json'
foreach ($f in $required) { Assert "exists $f" (Test-Path (Join-Path $factory $f)) }
foreach ($schemaFile in 'schemas/evidence-manifest.schema.json', 'schemas/verification-query.schema.json', 'schemas/memory-candidate.schema.json', 'schemas/memory-record.schema.json', 'schemas/memory-recall.schema.json', 'schemas/memory-retrieval-capture.schema.json', 'schemas/hindsight-deterministic-index.schema.json') {
    try { Get-Content -Raw (Join-Path $factory $schemaFile) | ConvertFrom-Json | Out-Null; Assert "valid JSON $schemaFile" $true }
    catch { Assert "valid JSON $schemaFile" $false }
}
$legacyMemoryRecall = '{"status":"miss","banksQueried":[],"memoryIds":[],"memoryCount":0,"contextChars":0,"selected":[]}'
$currentMemoryRecall = '{"status":"ok","banksQueried":["project-cezar"],"memoryIds":["m1"],"memoryCount":1,"contextChars":2,"selected":[{"id":"m1","excerpt":"ok","version":1,"contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","readAt":"2026-11-10T00:00:00Z","validationStatus":"unvalidated","superseded":false}],"deterministicMatches":[],"retrievalCapture":{"schemaVersion":1,"project":"cezar","readAt":"2026-11-10T00:00:00Z","deterministicMatches":[],"memories":[{"id":"m1","version":1,"contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","readAt":"2026-11-10T00:00:00Z","validationStatus":"unvalidated"}]}}'
$memoryRecord = '{"id":"m1","project":"cezar","topic":"Startup readiness","lesson":"Use bounded readiness checks.","kind":"successful-fix","scope":"repo","claimType":"hypothesis","validationStatus":"unvalidated","evidenceLinks":[{"kind":"issue","ref":"issue:123","validationStatus":"unvalidated"}],"version":1,"contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","retainedAt":"2026-11-10T00:00:00Z","superseded":false,"supersedes":null,"supersededBy":null,"versionHistory":[]}'
$memoryCandidate = '{"topic":"Startup readiness","lesson":"Use bounded readiness checks.","kind":"successful-fix","evidence":"The local issue records this change.","scope":"repo","claimType":"hypothesis","evidenceLinks":[{"kind":"issue","ref":"issue:123"}]}'
$deterministicIndex = '{"schemaVersion":1,"records":[{"kind":"run","id":"run-1","ref":"run:123","verified":true}]}'
$memoryRecallSchema = Join-Path $factory 'schemas/memory-recall.schema.json'
$memorySchemaChecks = @(
    (Test-Json -Json $memoryRecord -SchemaFile (Join-Path $factory 'schemas/memory-record.schema.json')),
    (Test-Json -Json $memoryCandidate -SchemaFile (Join-Path $factory 'schemas/memory-candidate.schema.json')),
    (Test-Json -Json $deterministicIndex -SchemaFile (Join-Path $factory 'schemas/hindsight-deterministic-index.schema.json'))
)
Assert 'candidate, retained-memory and deterministic-index examples validate' ($memorySchemaChecks -notcontains $false)
try {
    Assert 'legacy Hindsight recall artifacts remain valid' (Test-Json -Json $legacyMemoryRecall -SchemaFile $memoryRecallSchema)
    Assert 'provenance recall artifacts validate against the additive schema' (Test-Json -Json $currentMemoryRecall -SchemaFile $memoryRecallSchema)
} catch { Assert 'Hindsight recall artifacts validate against the additive schema' $false }
$incidentSource = Get-Content -Raw (Join-Path $factory 'scripts/hindsight/incident.py')
$incidentDocs = Get-Content -Raw (Join-Path $factory 'docs/hindsight-provenance.md')
Assert 'Hindsight memory remains advisory and deterministic ledgers own incident counts and gates' ($incidentSource -match 'Nothing here decides counts, lifecycle status or gates' -and $incidentDocs -match 'incident\s+counts,\s+and gates')
$evidenceRetention = Get-Content -Raw (Join-Path $factory 'policies/evidence-retention.yaml')
Assert 'coding evidence retention defaults to 30 days with bounded store and redaction' ($evidenceRetention -match '(?m)^defaultRetentionDays:\s*30$' -and $evidenceRetention -match '(?m)^maxArtifactBytes:\s*16777216$' -and $evidenceRetention -match '(?m)^maxStoreBytes:\s*1073741824$' -and $evidenceRetention -match '(?m)^  textArtifacts:\s*redact$' -and $evidenceRetention -match '(?m)^  binaryArtifacts:\s*requireCallerAssertion$')
Assert 'merge eligibility script exists' (Test-Path (Join-Path $factory 'scripts/verify-merge-eligibility.ps1'))
Assert 'review validates the reviewed PR head before the merge gate so receipts bind to it' ((Test-Path (Join-Path $factory 'scripts/validate-reviewed-head.ps1')) -and ((Get-Content -Raw (Join-Path $factory 'workflows/review.yaml')) -match '(?s)id: validate-head.*validate-reviewed-head.ps1.*id: merge-eligibility'))
Assert 'validate-reviewed-head labels the PR through the REST API, since gh pr edit fails on the Projects (classic) GraphQL error' ((Get-Content -Raw (Join-Path $factory 'scripts/validate-reviewed-head.ps1')) -notmatch 'pr edit' -and (Get-Content -Raw (Join-Path $factory 'scripts/validate-reviewed-head.ps1')) -like '*issues/$number/labels*')
Assert 'automation catalog validates' ((Run 'validate-automation-catalog.ps1' @{}).Code -eq 0)
$catalog = Get-Content -Raw (Join-Path $factory 'routing/automation-catalog.json') | ConvertFrom-Json
$intakeAutomation = Get-Content -Raw (Join-Path $factory 'automations/intake.json') | ConvertFrom-Json
Assert 'intake automation catches older backlog and excludes tracking parents' ($intakeAutomation.filters.lookbackDays -ge 30 -and $intakeAutomation.filters.excludeLabels -contains 'epic' -and $intakeAutomation.filters.excludeLabels -contains 'factory:tracking')
# TEMPORARY (2026-11-07): every codex agent turn ends with 0 tokens on the host, so agent workflows run on Claude until codex is fixed.
Assert 'implementation and fix-review run on the Claude runner while codex is broken' ($catalog.automationProfiles.'factory-implement'.runner -eq 'claude' -and $catalog.automationProfiles.'factory-implement'.model -eq 'sonnet' -and $catalog.automationProfiles.'factory-fix-review'.runner -eq 'claude')
Assert 'complexity variants all route to Claude Sonnet while codex is broken' (@(@('complexity:small','complexity:medium','complexity:large') | Where-Object { $v = $catalog.automationProfiles.'factory-implement'.complexityVariants.$_; $v.runner -ne 'claude' -or $v.model -ne 'sonnet' }).Count -eq 0)
Assert 'planning routes every complexity tier to Claude Sonnet' ($catalog.automationProfiles.'factory-plan'.runner -eq 'claude' -and $catalog.automationProfiles.'factory-plan'.model -eq 'sonnet' -and $catalog.automationProfiles.'factory-plan'.complexityVariants.'complexity:small'.runner -eq 'claude' -and $catalog.automationProfiles.'factory-plan'.complexityVariants.'complexity:medium'.model -eq 'sonnet' -and $catalog.automationProfiles.'factory-plan'.complexityVariants.'complexity:large'.model -eq 'sonnet')
Assert 'maintenance runs on the Claude runner while codex is broken' ($catalog.automationProfiles.'factory-maintenance'.runner -eq 'claude' -and $catalog.automationProfiles.'factory-maintenance'.model -eq 'sonnet')
Assert 'health is pinned to the Factory gateway code model' ($catalog.automationProfiles.'factory-health'.runner -eq 'codex' -and $catalog.automationProfiles.'factory-health'.model -eq 'factory-gateway/factory-code')
$backlogAuditSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-backlog-label-audit/SKILL.md')
Assert 'backlog audit documents read-only collector and deterministic preparation' ($backlogAuditSkill -match 'read-only collector' -and $backlogAuditSkill -match 'deterministic preparation consumer' -and $backlogAuditSkill -match '/projects/cezar-factory/scripts/audit-backlog-labels\.ps1' -and $backlogAuditSkill -match 'Do not call `gh issue list`')
Assert 'backlog audit rejects bare skips and requires a durable closing-label proposal' ($backlogAuditSkill -match 'Do not use a bare skipped outcome' -and $backlogAuditSkill -match 'Every proposal must include a durable closing label')
Assert 'backlog audit skill proposes changes without applying GitHub effects' ($backlogAuditSkill -match 'Do not read GitHub state or apply any changes' -and $backlogAuditSkill -notmatch 'execute and re-read one closing label edit')
$maintenanceWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/maintenance.yaml')
Assert 'maintenance prompt states the complete candidate proposal contract' ($maintenanceWorkflow -match 'considered.*exact candidate `number` values' -and $maintenanceWorkflow -match 'every candidate exactly once' -and $maintenanceWorkflow -match 'field `issue`' -and $maintenanceWorkflow -match 'include `added`' -and $maintenanceWorkflow -match '`reason`')
Assert 'backlog collector is read-only and workflow prepares effects before agent dispatch' ($maintenanceWorkflow -match '(?s)id: backlog-label-audit-prepare.*?id: backlog-label-audit\r?\n' -and $backlogAuditSkill -match 'read-only collector')
Assert 'maintenance watchdog covers issue runs: implement and fix runs are routed to investigate, plan, review and investigate runs are only cancelled' ($maintenanceWorkflow -match '(?s)id: watchdog-issue-runs.*-MaxRunMinutes 360 -Workflow factory-implement,factory-fix-review [^&]*-RouteCancelledRuns && .*-MaxRunMinutes 240 -Workflow factory-plan,factory-review,factory-investigate -ExcludeRunId "\$CEZ_TASK_ID";')
Assert 'maintenance ends by verifying the run made no commit, and tells the agent step not to' ($maintenanceWorkflow.TrimEnd() -match '(?s)id: no-run-commits\s+name: [^\n]+\s+command: pwsh -NoProfile -File \$FACTORY_RUNTIME_ROOT/scripts/assert-no-run-commits\.ps1 [^\n]+\s+timeoutSeconds: \d+$' -and $maintenanceWorkflow -match 'Do not commit, push, create a branch or open a pull request')
Assert 'independent maintenance runs before backlog agent dispatch' ($maintenanceWorkflow.IndexOf('id: refresh-stale-workable') -lt $maintenanceWorkflow.IndexOf('id: backlog-label-audit') -and $maintenanceWorkflow.IndexOf('id: repository-maintenance') -lt $maintenanceWorkflow.IndexOf('id: backlog-label-audit'))
Assert 'maintenance uses typed no-work output after deterministic audit preparation' ($maintenanceWorkflow -match '(?s)id: backlog-label-audit-prepare.*?-WorkflowContract.*?outputSchema:.*?candidateCount:.*?\$cezar:')
$planWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/plan.yaml')
$planSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-plan/SKILL.md')
$investigateWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/investigate.yaml')
$implementWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/implement.yaml')
$fixReviewWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/fix-review.yaml')
$reviewWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/review.yaml')
$lifecycleSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-workspace/SKILL.md')
$factoryReleaseSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-release/SKILL.md')
$factoryFinishReleaseSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-finish-release/SKILL.md')
$codexLifecycleHooks = Get-Content -Raw (Join-Path $factory 'integrations/agents/workspace-lifecycle/codex-hooks.json') | ConvertFrom-Json
$claudeLifecycleHooks = Get-Content -Raw (Join-Path $factory 'integrations/agents/workspace-lifecycle/claude-settings.fragment.json') | ConvertFrom-Json
$closePrScript = Get-Content -Raw (Join-Path $factory 'scripts/ensure-pr-closes-issue.ps1')
$implementSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-implement/SKILL.md')
$ensureImplementationResult = Get-Content -Raw (Join-Path $factory 'scripts/ensure-implementation-result.ps1')
$ensureInvestigationResult = Get-Content -Raw (Join-Path $factory 'scripts/ensure-investigation-result.ps1')
$investigateSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-investigate/SKILL.md')
$prepareScript = Get-Content -Raw (Join-Path $factory 'scripts/prepare-implementation.ps1')
$startupScript = Get-Content -Raw (Join-Path $factory 'scripts/factory-startup.ps1')
$validationLibrary = Get-Content -Raw (Join-Path $factory 'scripts/lib.ps1')
$routeState = Get-Content -Raw (Join-Path $factory 'scripts/route-state.ps1')
Assert 'isolated-worktree workflows use the registered Factory runtime' ($planWorkflow -match '\$FACTORY_RUNTIME_ROOT/scripts/(hindsight/recall|validate-result|route-state)' -and $investigateWorkflow -match '\$FACTORY_RUNTIME_ROOT/scripts/(hindsight/recall|validate-result|route-state)' -and $planWorkflow -notmatch '\.ai/factory/scripts' -and $investigateWorkflow -notmatch '\.ai/factory/scripts')
Assert 'external workspace skill uses the shared CLI and yields to a verified Factory execution' ($lifecycleSkill -match 'cez workspace context' -and $lifecycleSkill -match 'managed: true' -and $lifecycleSkill -match 'cez workspace adopt' -and $lifecycleSkill -notmatch '(?i)(pwsh|powershell).*\.ps1')
Assert 'local interactive development reuses the existing checkout unless the owner explicitly requests another' ($lifecycleSkill -match 'one existing checkout' -and $lifecycleSkill -match 'do not create or switch' -and $lifecycleSkill -match 'unless the user directly asks' -and $lifecycleSkill -match 'Do not clean up Cezar automation worktrees')
Assert 'production release gates are opt-in and do not block Dev-mode troubleshooting' ($factoryReleaseSkill.Contains('Production Run') -and $factoryReleaseSkill.Contains('Dev mode') -and $factoryFinishReleaseSkill.Contains('Production Run') -and $factoryFinishReleaseSkill.Contains('Dev mode') -and (Get-Content -Raw (Join-Path $factory 'AGENTS.md')) -match 'work in Dev mode by default')
Assert 'Python bytecode caches are ignored generated artifacts' ((Get-Content -Raw (Join-Path $factory '.gitignore')) -match '(?m)^__pycache__/$' -and (Get-Content -Raw (Join-Path $factory '.gitignore')) -match '(?m)^\*\.py\[cod\]$')
Assert 'Codex and Claude hook fragments connect session start/stop to verified workspace context' ($codexLifecycleHooks.hooks.SessionStart.hooks.command -like 'cez workspace hook-context*' -and $codexLifecycleHooks.hooks.Stop.hooks.command -like 'cez workspace hook-context*' -and $claudeLifecycleHooks.hooks.SessionStart.hooks.command -like 'cez workspace hook-context*' -and $claudeLifecycleHooks.hooks.Stop.hooks.command -like 'cez workspace hook-context*')
Assert 'Factory implementation and review defer full suites while preserving focused checks and the verified handoff' ($implementWorkflow -match 'id: targeted-tests' -and $implementWorkflow -notmatch 'id: full-verification|factory/test-full\.ps1' -and $reviewWorkflow -notmatch 'id: full-verification|factory/test-full\.ps1' -and $implementWorkflow -match '(?s)id: validate.*?id: route.*?id: workspace-preflight.*?cez workspace preflight.*?id: lifecycle-ready.*?cez workspace handoff' -and $fixReviewWorkflow -match '(?s)id: targeted-tests.*?id: validate.*?id: route.*?id: workspace-preflight.*?cez workspace preflight.*?id: lifecycle-ready.*?cez workspace handoff' -and $reviewWorkflow -match '(?s)id: merge-eligibility.*?id: route.*?id: lifecycle-ready.*?cez workspace handoff')
$testOwnership = Get-Content -Raw (Join-Path $factory '.ai/factory/test-ownership.json') | ConvertFrom-Json
$cezarTestOwners = @($testOwnership.checks | Where-Object { $_.id -in 'cezar-api-client', 'cezar-server', 'cezar-web' })
$documentationOwner = $testOwnership.checks | Where-Object { $_.id -eq 'documentation-diff' }
$localPreCommitHook = Get-Content -Raw (Join-Path $factory '.githooks/pre-commit')
Assert 'local pre-commit hook runs the full Factory suite and YAML lint' ($localPreCommitHook -match 'tests/run-tests\.ps1' -and $localPreCommitHook -match 'yamllint 1\.37\.1' -and $localPreCommitHook -match 'yamllint -c \.yamllint\.yaml')
Assert 'local pre-commit hook clears Git repository environment before isolated fixture tests' ($localPreCommitHook -match 'git rev-parse --local-env-vars' -and $localPreCommitHook -match 'unset "\$git_env"')
$trackedGitlinks = @(& git -C $factory ls-files -s 2>$null | Where-Object { $_ -match '^160000' } | ForEach-Object { ($_ -split "`t", 2)[1] })
Assert "no embedded repository (gitlink) is tracked; it breaks deploy parity ($($trackedGitlinks | Select-Object -First 5 | ForEach-Object { $_ }))" ($trackedGitlinks.Count -eq 0)
$hostedCiMentions = @()
foreach ($f in @('AGENTS.md', 'docs/local-validation.md') + @(Get-ChildItem (Join-Path $factory 'skills') -Recurse -Filter SKILL.md | ForEach-Object { $_.FullName.Substring($factory.Length + 1) }) + @(Get-ChildItem (Join-Path $factory '.claude/skills') -Recurse -Filter SKILL.md -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($factory.Length + 1) })) {
    foreach ($line in Get-Content (Join-Path $factory $f)) {
        if ($line -match 'gh (pr checks|run (watch|view|list|rerun))' -and $line -notmatch '(?i)\b(never|not|no|do not|must not)\b') { $hostedCiMentions += "${f}: $($line.Trim())" }
    }
}
Assert "instructions never direct anyone to GitHub Actions or status checks ($($hostedCiMentions -join ' | '))" ($hostedCiMentions.Count -eq 0)
Assert 'AGENTS.md states that all validation runs on our own compute with no hosted CI' ((Get-Content -Raw (Join-Path $factory 'AGENTS.md')) -match 'nothing runs on GitHub' -and (Get-Content -Raw (Join-Path $factory 'docs/local-validation.md')) -match 'all validation runs on our own compute')
Assert 'AGENTS.md has the agent squash-merge broken-code fixes itself and never use --auto' ((Get-Content -Raw (Join-Path $factory 'AGENTS.md')) -match 'gh pr merge <number> --squash' -and (Get-Content -Raw (Join-Path $factory 'AGENTS.md')) -match 'Do not use `--auto`')
Assert 'no GitHub Actions workflow runs repository scripts' (@(Get-ChildItem (Join-Path $factory '.github/workflows') -Filter *.yml -ErrorAction SilentlyContinue).Count -eq 0 -and @(Get-ChildItem (Join-Path $factory '.github/workflows') -Filter *.yaml -ErrorAction SilentlyContinue).Count -eq 0)
Assert 'Cezar owners run changed tests or related tests without package-wide Vitest' ($cezarTestOwners.Count -eq 3 -and @($cezarTestOwners | Where-Object { $_.command -notmatch 'vitest run \$tests' -or $_.command -notmatch 'vitest related --run \$sources' -or $_.command -match 'vitest run;|vitest run\s*;' }).Count -eq 0)
Assert 'documentation owner quotes the braced validation base passed to git diff' ($documentationOwner.command.Contains('git diff --check "${env:FACTORY_VALIDATION_BASE}...HEAD"'))
Assert 'Factory validation captures bounded command output on timeout' ($validationLibrary -match 'Preserve the bounded diagnostic output on timeouts' -and $validationLibrary -match 'Configured validation\.\$Stage exceeded')
Assert 'investigation output example includes the required issue field' ($investigateSkill -match '"issue"\s*:\s*272' -and $investigateWorkflow -match 'numeric issue number' -and $investigateWorkflow -match 'required integer "issue" field')
Assert 'investigation workflow retries a missing handoff once, then preserves an explicit unknown result' ($investigateWorkflow -match 'ensure-investigation-result\.ps1 -Task "\{\{task\}\}"' -and $investigateWorkflow -match 'onFail:\s*\r?\n\s+retry: investigate\s*\r?\n\s+max: 1' -and $ensureInvestigationResult -match "failureClassification = 'unknown'" -and $ensureInvestigationResult -match "confidence = 'low'" -and $ensureInvestigationResult.Contains('automaticRetryAppropriate = $false'))
Assert 'implement workflow prepares context before implementation' ($implementWorkflow -match 'id: prepare' -and $implementWorkflow -match 'prepare-implementation\.ps1 -Task' -and $implementWorkflow -match 'route-state\.ps1 -Event start -Task' -and $implementWorkflow -match 'implementation-context\.json')
Assert 'implement workflow enforces a PR closing reference after the LLM step' ($implementWorkflow -match 'id: ensure-pr-closes-issue' -and $implementWorkflow -match 'ensure-pr-closes-issue\.ps1 -Path \.factory/implement-result\.json')
Assert 'implement workflow preserves a missing result as a structured failure' ($implementWorkflow -match 'id: ensure-result' -and $implementWorkflow -match 'ensure-implementation-result\.ps1' -and $ensureImplementationResult -match "status = 'failure'" -and $closePrScript -match "status = 'skipped'; reason = 'implementation-failure'")
Assert 'PR close guard edits the PR with a GitHub closing reference' ($closePrScript -match "pr', 'view" -and $closePrScript -match "pr', 'edit" -and $closePrScript -match 'Closes #\$issue')
Assert 'maintenance workflow reflects delivered work by closing issues merged into dev' ($maintenanceWorkflow -match 'id: sync-issue-delivery' -and $maintenanceWorkflow -match 'sync-issue-delivery\.ps1 -OutputPath' -and $maintenanceWorkflow -match '-RequiredScripts [^\r\n]*sync-issue-delivery\.ps1')
Assert 'implementation preparation fetches issue and captures environment' ($implementWorkflow -match 'prepare-implementation\.ps1' -and $prepareScript -match 'gh.*issue.*view' -and $prepareScript -match 'comments' -and $prepareScript -match 'toolingFiles' -and $prepareScript -match 'AGENTS\.md')
Assert 'every workflow starts with shared startup preflight' (($startupScript -match 'RUNTIME_ROOT_INVALID' -and $startupScript -match 'REQUIRED_SCRIPT_MISSING' -and $startupScript -match 'GH_MISSING') -and @('health','fix-review','implement','intake','investigate','maintenance','plan','review' | ForEach-Object { (Get-Content -Raw (Join-Path $factory "workflows/$_.yaml")) -match 'id: startup' } | Where-Object { -not $_ }).Count -eq 0)
$backlogWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')
Assert 'health workflow owns snapshot and dry-run script calls' ($backlogWorkflow -match 'collect-backlog-snapshot\.ps1' -and $backlogWorkflow -match 'reconcile-backlog\.ps1 .* -DryRun' -and $backlogWorkflow -match 'BatchCap 1 -ProjectConcurrencyCap 1')
Assert 'failure-audit startup preflights the workflow-owned publisher and GitHub CLI' ((Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')) -match 'id: publish' -and (Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')) -match 'publish-failure-audit\.ps1' -and (Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')) -match '-RequireGh' -and (Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')) -match 'publish-failure-audit\.ps1')
# $input is PowerShell's automatic stdin enumerator. Using it as a variable makes a script wait for
# stdin, which a task runner leaves open, so the step hangs forever (backlog audit validation, 2026-11-01).
$inputVariableUses = @(Get-ChildItem (Join-Path $factory 'scripts') -Recurse -Filter *.ps1 | Where-Object { (Get-Content -Raw $_.FullName) -match '(?i)\$input\b' } | ForEach-Object Name)
Assert "no Factory script uses the automatic stdin variable (input) (hangs on an open stdin): $($inputVariableUses -join ', ')" ($inputVariableUses.Count -eq 0)
# Hang-risk lint (see tests/hang-lint.ps1). The self-tests prove each rule fires, so a rule cannot rot silently.
. (Join-Path $PSScriptRoot 'hang-lint.ps1')
function Lint-Rules([string]$Source) { @(Get-HangLintFindings -Text $Source | ForEach-Object Rule) }
Assert 'hang-lint flags the automatic $input variable' ((Lint-Rules '$input = Get-Content x') -contains 'automatic-input')
Assert 'hang-lint flags interactive prompts' ((Lint-Rules '$x = Read-Host "name"') -contains 'interactive-prompt' -and (Lint-Rules '$c = Get-Credential') -contains 'interactive-prompt')
Assert 'hang-lint flags HTTP calls without -TimeoutSec but accepts bounded ones' ((Lint-Rules 'Invoke-RestMethod -Uri $u') -contains 'http-without-timeout' -and (Lint-Rules 'Invoke-RestMethod -Uri $u -TimeoutSec 30') -notcontains 'http-without-timeout')
Assert 'hang-lint flags unbounded waits' ((Lint-Rules '$p.WaitForExit()') -contains 'unbounded-wait' -and (Lint-Rules 'Start-Process x -Wait') -contains 'unbounded-wait' -and (Lint-Rules '$p.WaitForExit(5000)') -notcontains 'unbounded-wait')
Assert 'hang-lint flags an editor-opening git commit but accepts -m' ((Lint-Rules '& git commit') -contains 'editor-opening-git' -and (Lint-Rules '& git commit -m "x"') -notcontains 'editor-opening-git')
Assert 'hang-lint flags ssh without BatchMode' ((Lint-Rules '& ssh -o ConnectTimeout=5 host cmd') -contains 'ssh-without-batchmode' -and (Lint-Rules '& ssh -o BatchMode=yes host cmd') -notcontains 'ssh-without-batchmode')
Assert 'hang-lint honours a reasoned suppression and ignores comments' ((Lint-Rules '$x = Read-Host "n" # hang-lint: allow interactive-prompt - operator tool') -notcontains 'interactive-prompt' -and (Lint-Rules '# Read-Host is banned') -notcontains 'interactive-prompt' -and (Lint-Rules "<#`nRead-Host`n#>") -notcontains 'interactive-prompt')
Assert 'hang-lint requires an explicit deadline on every workflow command step' (@(Get-WorkflowDeadlineFindings -Text "steps:`n  - id: a`n    command: x").Count -eq 1 -and @(Get-WorkflowDeadlineFindings -Text "steps:`n  - id: a`n    command: x`n    timeoutSeconds: 60").Count -eq 0 -and @(Get-WorkflowDeadlineFindings -Text "steps:`n  - id: a`n    command: x`n    timeoutSeconds: 99999").Count -eq 1)
$hangFindings = @(Get-ChildItem (Join-Path $factory 'scripts') -Recurse -Filter *.ps1 | ForEach-Object { Get-HangLintFindings -Text (Get-Content -Raw $_.FullName) -Name $_.FullName.Substring($factory.Length + 1) })
foreach ($finding in $hangFindings) { Write-Host "       $($finding.File):$($finding.Line) [$($finding.Rule)] $($finding.Message)" -ForegroundColor Yellow }
Assert 'no Factory script contains a construct that can wait forever (tests/hang-lint.ps1)' ($hangFindings.Count -eq 0)
$deadlineFindings = @(Get-ChildItem (Join-Path $factory 'workflows') -Filter *.yaml | ForEach-Object { Get-WorkflowDeadlineFindings -Text (Get-Content -Raw $_.FullName) -Name $_.Name })
foreach ($finding in $deadlineFindings) { Write-Host "       $($finding.File):$($finding.Line) [$($finding.Rule)] $($finding.Message)" -ForegroundColor Yellow }
Assert 'every workflow command step declares a timeoutSeconds deadline' ($deadlineFindings.Count -eq 0)

Assert 'startup keeps its failure reason visible on stderr' ($startupScript -match 'Console]::Error.WriteLine' -and $startupScript -match 'GIT_WORKTREE_CONFIG_INVALID')
Assert 'startup normalizes comma-delimited required scripts from workflow commands' ($startupScript -match "-split ','" -and $startupScript -match 'requiredScripts = @\(\$RequiredScripts\)')
$pushFactoryUpdates = Get-Content -Raw (Join-Path $factory 'scripts/push-factory-updates.ps1')
$promoteStable = Get-Content -Raw (Join-Path $factory 'scripts/release/promote-stable.ps1')
$legacyReportDefault = "Join-Path `$factory '.factory/release-reports"
Assert 'release records force-refresh requirement for blocked managed updates' ($pushFactoryUpdates -match 'forceRefreshRequired' -and $pushFactoryUpdates -match 'release-status\.jsonl')
Assert 'legacy push holds the configured controller and autodeploy locks through the command and is explicitly deprecated' ($pushFactoryUpdates -match 'FACTORY_RELEASE_LOCKS_HELD' -and $pushFactoryUpdates -match 'check-release-locks\.py' -and $pushFactoryUpdates -match '--hold' -and $pushFactoryUpdates -match 'Deprecated')
Assert 'release reports default to host state outside the shared checkout' ($pushFactoryUpdates -match 'FACTORY_STATE_DIR' -and $pushFactoryUpdates -match 'XDG_STATE_HOME' -and $promoteStable -match 'FACTORY_STATE_DIR' -and $promoteStable -match 'XDG_STATE_HOME' -and -not $pushFactoryUpdates.Contains($legacyReportDefault) -and -not $promoteStable.Contains($legacyReportDefault))
$gitignore = Get-Content -Raw (Join-Path $factory '.gitignore')
Assert 'the generated Prometheus bearer token is ignored as host-local secret state' ($gitignore -match '(?m)^integrations/bazzite/prometheus-vllm-token\.generated\s*$')
$onboardScript = Get-Content -Raw (Join-Path $factory 'scripts/onboard-project.ps1')
Assert 'new-project onboarding creates dev from the default branch' ($onboardScript -match 'git/ref/heads/dev' -and $onboardScript -match 'refs/heads/dev' -and $onboardScript -match 'defaultBranchRef')
Assert 'new-project onboarding is bounded and release-gated' ($onboardScript -match 'SeedOpenIssues' -and $onboardScript -match 'DryRun' -and $onboardScript -match 'never merges|never.*enables live automations|never.*dispatches')
$maintenanceWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/maintenance.yaml')
Assert 'maintenance workflow includes one bounded existing-issue intake pull' ($maintenanceWorkflow -match 'select-intake-issue\.ps1' -and $maintenanceWorkflow -match 'classify-intake\.ps1' -and $maintenanceWorkflow -match 'route-intake-or-no-work\.ps1')
$staleWorkableScript = Get-Content -Raw (Join-Path $factory 'scripts/refresh-stale-workable.ps1')
Assert 'stale-workable replay leaves new issues to the scheduled intake pull' ($staleWorkableScript -notmatch "'factory:new'")
$intakeWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/intake.yaml')
Assert 'intake workflow passes task context to the workflow-owned selector' ($intakeWorkflow -match 'select-intake-issue\.ps1 -Task "\{\{task\}\}"')
Assert 'maintenance workflow recovers audit reservations before collection' ($maintenanceWorkflow -match 'recover-audit-reservations\.ps1' -and $maintenanceWorkflow -match 'id: recover-audit-reservations')
$recoveryScript = Get-Content -Raw (Join-Path $factory 'scripts/recover-audit-reservations.ps1')
Assert 'maintenance recovery uses Cezar loopback API and selected worktree identity' ($recoveryScript -match 'http://127\.0\.0\.1:4321' -and $recoveryScript -match '\.ai' -and $recoveryScript -match 'worktrees' -and $recoveryScript -match 'Split-Path \$Matches\.root -Leaf' -and $maintenanceWorkflow -notmatch '\$env:CEZAR_|\$CEZAR_')
$failureAuditWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')
$failureAuditScript = Get-Content -Raw (Join-Path $factory 'scripts/audit-factory-failures.ps1')
Assert 'failure audit does not depend on missing per-project shell variables' ($failureAuditWorkflow -notmatch '\$env:CEZAR_|\$CEZAR_' -and $failureAuditScript -match 'http://127\.0\.0\.1:4321' -and $failureAuditScript -match '\.ai' -and $failureAuditScript -match 'worktrees' -and $failureAuditScript -match 'Split-Path \$Matches\.root -Leaf')
Assert 'maintenance validates the audit handoff before the model step' ($maintenanceWorkflow -match 'id: backlog-label-audit-collect' -and $maintenanceWorkflow -match 'id: backlog-label-audit-validate\r?\n\s+name: Validate bounded backlog-label audit handoff' -and $maintenanceWorkflow -match 'validate-backlog-label-audit-input\.ps1')
$auditGuard = Get-Content -Raw (Join-Path $factory 'scripts/validate-backlog-label-audit-input.ps1')
Assert 'audit handoff guard fails closed and prevents rediscovery' ($auditGuard -match 'handoff is missing' -and $auditGuard -match 'Stop before the audit skill' -and $auditGuard -match 'MaxCandidates')
$scriptOwnershipViolations = @()
foreach ($wf in Get-ChildItem (Join-Path $factory 'workflows') -Filter *.yaml) {
    # Only `prompt:` blocks are model-facing; `command:` lines are the workflow's own script steps.
    $inPrompt = $false
    foreach ($line in Get-Content $wf.FullName) {
        if ($line -match '^\s+prompt:') { $inPrompt = $true; continue }
        if ($inPrompt -and $line -match '^\s{0,5}\S') { $inPrompt = $false }
        if ($inPrompt -and $line -match '(pwsh|powershell).*\.ps1|run `[^`]*\.ps1') { $scriptOwnershipViolations += "$($wf.Name): $($line.Trim())" }
    }
}
foreach ($sk in Get-ChildItem (Join-Path $factory 'skills') -Directory | Where-Object { $_.Name -notin 'interactive-github-backlog', 'factory-work-backlog', 'factory-cezar-skill-operations' }) {
    foreach ($line in Get-Content (Join-Path $sk.FullName 'SKILL.md')) {
        if ($line -match '(pwsh|powershell)\s+.*\.ps1' -and $line -notmatch '(?i)\b(not|never|must not|do not)\b') { $scriptOwnershipViolations += "$($sk.Name): $($line.Trim())" }
    }
}
Assert "workflows own scripts: no prompt or skill tells the model to run one ($($scriptOwnershipViolations -join ' | '))" ($scriptOwnershipViolations.Count -eq 0)
Assert 'release skills leave operational script execution to workflow command steps' ($factoryReleaseSkill -notmatch '(?i)(pwsh|powershell)\s+.*\.ps1|run `[^`]*\.ps1' -and $factoryFinishReleaseSkill -notmatch '(?i)(pwsh|powershell)\s+.*\.ps1|run `[^`]*\.ps1')
$shipLoop = Join-Path $factory '.claude/ship/ship-loop.ps1'
$iterDry = (& pwsh -NoProfile -File $shipLoop -Action Run -Workflow health -Task 'smoke' -DryRun 2>&1 | Out-String)
$iterDryCode = $LASTEXITCODE
# Show the output when it fails: these assertions used to discard it, which hid a Linux-only failure.
if ($iterDryCode -ne 0 -or $iterDry -notmatch 'run smoke --workflow factory-health') {
    Write-Host "ship-loop Run -DryRun exited ${iterDryCode}:`n$iterDry"
    Write-Host ("diagnostics: toplevel=" + ((& git -C (Split-Path -Parent $shipLoop) rev-parse --show-toplevel 2>&1) | Out-String).Trim() + " pwd=$PWD git-env=" + ((Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','))
}
Assert 'ship-loop Run resolves a workflow by file name to its cezar name' ($iterDryCode -eq 0 -and $iterDry -match 'run smoke --workflow factory-health')
$iterUnknown = (& pwsh -NoProfile -File $shipLoop -Action Run -Workflow no-such-workflow -Task 'x' -DryRun 2>&1 | Out-String)
$iterUnknownCode = $LASTEXITCODE
if ($iterUnknownCode -ne 2) { Write-Host "ship-loop Run (unknown workflow) exited ${iterUnknownCode}:`n$iterUnknown" }
Assert 'ship-loop Run rejects an unknown workflow with exit 2' ($iterUnknownCode -eq 2)
$trackedScratch = @(& git -C $factory ls-files -- .factory | Where-Object { $_ -notmatch '^\.factory/(release-reports/|obot-caddy-root\.crt$)' })
Assert "no workflow scratch is tracked under .factory/ ($($trackedScratch -join ', '))" ($trackedScratch.Count -eq 0)
# Cezar autosaves whatever is not ignored at the end of every run. Any new scratch name under .factory/ must
# already be ignored, so a step that writes a new file cannot start a stream of commits.
$notIgnored = @('.factory/zz-brand-new-scratch.json', '.factory/gh-cache/0123abcd.json', '.factory/lifecycle-sweep.json', '.factory/run-commits.json', '.factory/release-reports/shadow-audit.json', '.factory/nested/anything.txt' | Where-Object { & git -C $factory check-ignore -q -- $_; $LASTEXITCODE -ne 0 })
Assert "new scratch under .factory/ is ignored by default ($($notIgnored -join ', '))" ($notIgnored.Count -eq 0)
$ignoredButTracked = @('.factory/obot-caddy-root.crt', '.factory/release-reports/promote-stable.jsonl' | Where-Object { & git -C $factory check-ignore -q --no-index -- $_; $LASTEXITCODE -eq 0 })
Assert "the deliberately tracked files under .factory/ are not ignored ($($ignoredButTracked -join ', '))" ($ignoredButTracked.Count -eq 0)
# Scratch-state gate: every `.factory/<name>` that a workflow or script mentions is created, untracked, in a clean
# repository carrying the real .gitignore, and the checkout must still be clean. That is the condition the deploy
# guard, the promotion gate and the end-of-run autosave all depend on. A repository without the rule is the control.
$scratchSources = @(Get-ChildItem (Join-Path $factory 'workflows'), (Join-Path $factory 'scripts') -Recurse -File | Where-Object { $_.Extension -in '.yaml', '.ps1', '.py', '.sh' -and $_.FullName -notmatch '[\/](artifacts|__pycache__)[\/]' })
$scratchNames = @($scratchSources | ForEach-Object { [regex]::Matches([IO.File]::ReadAllText($_.FullName), '\.factory/([A-Za-z0-9_][A-Za-z0-9_.\-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.\-]*)*)') | ForEach-Object { $_.Groups[1].Value.TrimEnd('.') } } | Where-Object { $_ -and $_ -notmatch '^(release-reports|obot-caddy-root\.crt)' } | Sort-Object -Unique)
Assert "the factory's own code names a broad set of .factory/ scratch paths ($($scratchNames.Count))" ($scratchNames.Count -ge 30)
function Get-ScratchDirtyCount([string]$GitignoreSource) {
    $scratchRepo = Join-Path ([IO.Path]::GetTempPath()) "factory-scratch-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    try {
        New-Item -ItemType Directory -Force $scratchRepo | Out-Null
        & git -C $scratchRepo init -q -b stable 2>&1 | Out-Null
        if ($GitignoreSource) { Copy-Item $GitignoreSource (Join-Path $scratchRepo '.gitignore') } else { '' | Set-Content (Join-Path $scratchRepo '.gitignore') }
        & git -C $scratchRepo add .gitignore 2>&1 | Out-Null
        & git -C $scratchRepo -c user.name=t -c user.email=t@example.invalid commit -q -m base 2>&1 | Out-Null
        foreach ($name in ($scratchNames | Sort-Object { $_.Length } -Descending)) {
            $scratchPath = Join-Path $scratchRepo ".factory/$name"
            try { New-Item -ItemType Directory -Force -Path (Split-Path $scratchPath -Parent) | Out-Null; if (-not (Test-Path $scratchPath)) { Set-Content -Path $scratchPath -Value 'scratch' } } catch { }
        }
        @(& git -C $scratchRepo status --porcelain --untracked-files=all)
    }
    finally { Remove-Item -Recurse -Force $scratchRepo -ErrorAction SilentlyContinue }
}
$scratchDirty = @(Get-ScratchDirtyCount (Join-Path $factory '.gitignore'))
Assert "a checkout stays clean after every .factory/ scratch path the code mentions is written ($(@($scratchDirty | Select-Object -First 5) -join '; '))" ($scratchDirty.Count -eq 0)
Assert 'the scratch-state gate fails without the ignore rule (control)' (@(Get-ScratchDirtyCount '').Count -gt 0)Assert 'workflow-iterate skill documents the Run action'((Get-Content -Raw (Join-Path $factory '.claude/skills/workflow-iterate/SKILL.md')) -match 'ship-loop\.ps1 -Action Run')
# Copyable result examples must remain valid JSON and satisfy their declared
# schema. A missing required field is a real contract failure, not just prose
# drift; #33 will extend this to the full workflow command inventory.
$resultExamples = @(
    @{ Skill = 'factory-plan'; Schema = 'plan.schema.json' },
    @{ Skill = 'factory-implement'; Schema = 'implementation-result.schema.json' },
    @{ Skill = 'factory-fix'; Schema = 'implementation-result.schema.json' },
    @{ Skill = 'factory-review'; Schema = 'review-result.schema.json' },
    @{ Skill = 'factory-investigate'; Schema = 'investigation-result.schema.json' }
)
foreach ($entry in $resultExamples) {
    $skillPath = Join-Path $factory "skills/$($entry.Skill)/SKILL.md"
    $example = [regex]::Match((Get-Content -Raw $skillPath), '(?ms)```json\s*(\{.*?\})\s*```')
    Assert "$($entry.Skill) has a concrete JSON result example" $example.Success
    if (-not $example.Success) { continue }
    $schemaPath = Join-Path $factory "schemas/$($entry.Schema)"
    $valid = $false
    try { $valid = [bool](Test-Json -Json $example.Groups[1].Value -SchemaFile $schemaPath -ErrorAction Stop) } catch { }
    Assert "$($entry.Skill) example satisfies $($entry.Schema)" $valid
    if ($valid) {
        $withoutIssue = $example.Groups[1].Value | ConvertFrom-Json -AsHashtable
        $withoutIssue.Remove('issue')
        $invalid = $false
        try { $invalid = [bool](Test-Json -Json ($withoutIssue | ConvertTo-Json -Depth 10) -SchemaFile $schemaPath -ErrorAction Stop) } catch { }
        Assert "$($entry.Skill) example contract rejects a missing issue" (-not $invalid)
    }
}

# Documentation-state contract fixtures combine Draft-07 shape validation with
# cross-field lifecycle and revision checks that JSON Schema cannot express.
$docStateSchema = Join-Path $factory 'schemas/documentation-state/state.schema.json'
$docStateFixtures = Join-Path $factory 'schemas/documentation-state/fixtures'
function Test-DocStateSemantics([hashtable]$Record) {
    $allowedPrevious = @{
        proposed = @('')
        approved = @('proposed')
        implemented = @('approved')
        verified = @('implemented')
        superseded = @('proposed', 'approved', 'implemented', 'verified')
    }
    $previous = if ($null -eq $Record.previousState) { '' } else { [string]$Record.previousState }
    if ($previous -notin $allowedPrevious[[string]$Record.state]) { return $false }
    if (@($Record.claims | Where-Object { $_.knowledge -eq 'proposed' -and $_.speculative -ne $true }).Count -gt 0) { return $false }
    if (@($Record.claims | Where-Object { $_.knowledge -eq 'verified' -and ($_.speculative -ne $false -or @($_.evidence).Count -eq 0) }).Count -gt 0) { return $false }
    if ($Record.state -eq 'verified') {
        if ($Record.verification.status -ne 'verified' -or @($Record.claims | Where-Object knowledge -ne 'verified').Count -gt 0) { return $false }
        if ($Record.freshness.status -ne 'fresh' -or $Record.freshness.checkedAgainstSha -cne $Record.revision.observedSha) { return $false }
    }
    switch ([string]$Record.freshness.status) {
        'fresh' { if (-not $Record.freshness.checkedAgainstSha -or $Record.freshness.checkedAgainstSha -cne $Record.revision.observedSha) { return $false } }
        'stale' { if (-not $Record.freshness.checkedAgainstSha -or $Record.freshness.checkedAgainstSha -ceq $Record.revision.observedSha) { return $false } }
        'unknown' { if ($Record.freshness.ContainsKey('checkedAgainstSha')) { return $false } }
    }
    return $true
}
$docStateSchemaCases = @(
    @{ Name = 'state-proposed.json'; SchemaValid = $true; SemanticValid = $true },
    @{ Name = 'state-verified.json'; SchemaValid = $true; SemanticValid = $true },
    @{ Name = 'state-invalid-proposed-claim.json'; SchemaValid = $false; SemanticValid = $false },
    @{ Name = 'state-invalid-transition.json'; SchemaValid = $true; SemanticValid = $false },
    @{ Name = 'state-invalid-stale-evidence.json'; SchemaValid = $true; SemanticValid = $false },
    @{ Name = 'migration-v0-to-v1/expected.json'; SchemaValid = $true; SemanticValid = $true }
)
foreach ($case in $docStateSchemaCases) {
    $fixturePath = Join-Path $docStateFixtures $case.Name
    $raw = Get-Content -Raw $fixturePath
    $record = $raw | ConvertFrom-Json -AsHashtable
    $schemaValid = $false
    try { $schemaValid = [bool](Test-Json -Json $raw -SchemaFile $docStateSchema -ErrorAction Stop) } catch { }
    Assert "documentation state $($case.Name) schema validity is $($case.SchemaValid)" ($schemaValid -eq $case.SchemaValid)
    Assert "documentation state $($case.Name) semantic validity is $($case.SemanticValid)" ((Test-DocStateSemantics $record) -eq $case.SemanticValid)
}
$migrationInput = Get-Content -Raw (Join-Path $docStateFixtures 'migration-v0-to-v1/input.json') | ConvertFrom-Json -AsHashtable
$migrationExpected = Get-Content -Raw (Join-Path $docStateFixtures 'migration-v0-to-v1/expected.json') | ConvertFrom-Json -AsHashtable
Assert 'documentation-state migration preserves legacy text as an explicit proposal' ($migrationExpected.claims[0].text -eq $migrationInput.summary -and $migrationExpected.claims[0].speculative -and $migrationExpected.state -eq 'proposed')
Assert 'documentation-state migration does not infer verification or freshness' ($migrationExpected.verification.status -eq 'not-verified' -and $migrationExpected.freshness.status -eq 'unknown' -and $migrationExpected.migratedFrom.schemaVersion -eq 'unversioned/v0')
$docRoutingScenarios = @(Select-String -Path (Join-Path $factory 'schemas/documentation-state/README.md') -Pattern '^\| (?![-:])[^|]+\|[^|]+\|[^|]+\|$')
Assert 'documentation routing contract contains at least 12 deterministic scenarios' ($docRoutingScenarios.Count -ge 12)

function Missing-StartupScripts([string]$WorkflowText) {
    $startup = [regex]::Match($WorkflowText, '(?m)^\s+command:.*factory-startup\.ps1.*-RequiredScripts\s+([^\s]+)')
    if (-not $startup.Success) { return @('startup manifest missing') }
    $required = @($startup.Groups[1].Value -split ',')
    $called = @([regex]::Matches($WorkflowText, '(?m)^\s+command:.*?/scripts/([a-zA-Z0-9/_-]+\.ps1)') |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -ne 'factory-startup.ps1' })
    @($called | Where-Object { $_ -notin $required } | Sort-Object -Unique)
}
foreach ($workflowName in @('intake', 'plan', 'investigate')) {
    $workflowText = Get-Content -Raw (Join-Path $factory "workflows/$workflowName.yaml")
    Assert "$workflowName startup lists every called script" (@(Missing-StartupScripts $workflowText).Count -eq 0)
}
$investigateWithoutRouter = (Get-Content -Raw (Join-Path $factory 'workflows/investigate.yaml')) -replace ',route-state\.ps1(?=[,\r\n])', ''
Assert 'startup manifest check detects a missing route script' (@(Missing-StartupScripts $investigateWithoutRouter) -contains 'route-state.ps1')
Assert 'plan startup includes its routing helper' ((Get-Content -Raw (Join-Path $factory 'workflows/plan.yaml')) -match 'RequiredScripts[^\r\n]*route-state\.ps1')
Assert 'implement and fix-review move the issue to working from a workflow step' ((Get-Content -Raw (Join-Path $factory 'workflows/fix-review.yaml')) -match 'id: start' -and $routeState -match '\[string\]\$Task')
Assert 'implement skill prevents speculative recovery'  ($implementSkill -match 'Do not dispatch a child Cezar task' -and $implementSkill -match 'Do not use anonymous GitHub.*curl' -and $implementSkill -match 'stop and write a failure result' -and $implementSkill -match 'Repeating the same failed command')
Assert 'route-state tolerates pre-complexity installed layers' ($routeState -match 'Older installed Factory layers predate complexity labels' -and $routeState -match 'complexity:small.*complexity:medium.*complexity:large')
Assert 'central route-state writes execution data to the current project' ($routeState -match '\[string\]\$ProjectPath = \(Get-Location\)\.Path' -and $routeState -match 'Join-Path \$ProjectPath ''.factory/execution.json''')
Assert 'deployment env examples do not contain real secrets' ((Get-Content -Raw (Join-Path $factory 'integrations/bazzite/env.example')) -match 'change-me-on-host' -and (Get-Content -Raw (Join-Path $factory 'integrations/mac-mini/vllm/env.example')) -match 'REPLACE_ON_HOST')
Assert 'Mac vLLM env includes installer inputs' ((Get-Content -Raw (Join-Path $factory 'integrations/mac-mini/vllm/env.example')) -match '(?m)^VLLM_VENV=' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-vllm-mac.sh')) -match 'creates the plist|cat > "\$PLIST_PATH"')
Assert 'Mac vLLM deployment supports general profile' ((Get-Content -Raw (Join-Path $factory 'integrations/mac-mini/vllm/env.example')) -match '(?m)^VLLM_GENERAL_MODEL=' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-vllm-mac.sh')) -match 'PROFILE.*general')
Assert 'Mac vLLM deployment supports bounded tool calling' ((Get-Content -Raw (Join-Path $factory 'integrations/mac-mini/vllm/env.example')) -match '(?m)^VLLM_ENABLE_AUTO_TOOL_CHOICE=' -and (Get-Content -Raw (Join-Path $factory 'integrations/mac-mini/vllm/env.example')) -match '(?m)^VLLM_TOOL_CALL_PARSER=qwen3_xml' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-vllm-mac.sh')) -match 'enable-auto-tool-choice' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-vllm-mac.sh')) -match 'tool-call-parser')
Assert 'Mac vLLM trusted proxy is allowlisted and authenticated' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/vllm-trusted-proxy.py')) -match 'client_allowed' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/vllm-trusted-proxy.py')) -match 'Bearer' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-vllm-trusted-proxy-mac.sh')) -match 'launchctl')
$remoteScript = Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-remote.sh')
Assert 'deployment scripts avoid unsafe unquoted remote paths' ($remoteScript.Contains("cd '`$MODEL_HOST_FACTORY_DIR'"))
Assert 'credential rotation helper avoids token-status output' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/rotate-cezar-github-token.bat')) -match 'read -r -s' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/rotate-cezar-github-token.bat')) -match 'gh auth login' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/rotate-cezar-github-token.bat')) -notmatch 'gh auth status')
$cezarDockerfile = Get-Content -Raw (Join-Path $factory 'cezar/Dockerfile')
Assert 'cezar image pushes over https through the gh credential helper' ($cezarDockerfile -match 'credential\.https://github\.com\.helper' -and $cezarDockerfile -match '!gh auth git-credential' -and $cezarDockerfile -match 'GIT_TERMINAL_PROMPT=0')
Assert 'remote validation reads named Podman connection from topology' ($remoteScript -match 'FACTORY_CONTROL_PLANE_PODMAN_CONNECTION' -and $remoteScript -match 'FACTORY_CONTROL_PLANE_HEALTH_BASE_URL')
Assert 'control-plane deployment targets named Podman connection' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'FACTORY_CONTROL_PLANE_PODMAN_CONNECTION' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'podman --connection')
Assert 'control-plane validation supports topology health URL' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-deployment.sh')) -match 'base_url' -and (Get-Content -Raw (Join-Path $factory 'config/server-topology.env.example')) -match 'FACTORY_CONTROL_PLANE_HEALTH_BASE_URL')
Assert 'Bazzite validation uses LiteLLM master key for gateway health' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-deployment.sh')) -match 'litellm_api_key' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-deployment.sh')) -match '4001/health')
Assert 'LiteLLM config mount is SELinux-safe' ((Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')) -match 'litellm-config\.yaml:/app/config\.yaml:ro,Z')
Assert 'Bazzite preflight rejects example registry' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'registry\\.example')
Assert 'Bazzite preflight requires OpenHands auth' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'OPENHANDS_SESSION_API_KEY')
$obotDir = Join-Path $factory 'integrations/bazzite/obot'
$obotCompose = Get-Content -Raw (Join-Path $obotDir 'compose.yaml')
$obotDeploy = Get-Content -Raw (Join-Path $obotDir 'deploy.sh')
$obotValidate = Get-Content -Raw (Join-Path $obotDir 'validate.sh')
$obotTeardown = Get-Content -Raw (Join-Path $obotDir 'teardown.sh')
$obotSetupRuntime = Get-Content -Raw (Join-Path $obotDir 'setup-runtime.sh')
$obotDocs = Get-Content -Raw (Join-Path $obotDir 'README.md')
$obotEnv = Get-Content -Raw (Join-Path $obotDir 'env.example')
$obotProxyCompose = ($obotCompose -split '(?m)^  obot:$')[0]
Assert 'Obot POC pins a supported image by version and digest' ($obotEnv -match '(?m)^OBOT_IMAGE=ghcr\.io/obot-platform/obot:v0\.27\.0@sha256:[a-f0-9]{64}$')
Assert 'Obot HTTPS proxy pins a supported image by version and digest' ($obotEnv -match '(?m)^CADDY_IMAGE=docker\.io/library/caddy:[0-9]+\.[0-9]+\.[0-9]+-alpine@sha256:[a-f0-9]{64}$')
Assert 'Obot POC requires authentication and publishes only a loopback port' ($obotCompose -match 'OBOT_SERVER_ENABLE_AUTHENTICATION: "true"' -and $obotCompose -match '127\.0\.0\.1:\$\{OBOT_HOST_PORT')
Assert 'Obot TLS proxy binds the LAN address and uses an internal CA' ((Get-Content -Raw (Join-Path $obotDir 'Caddyfile')) -match 'tls internal' -and (Get-Content -Raw (Join-Path $obotDir 'Caddyfile')) -match 'bind \{\$OBOT_BIND_ADDRESS\}' -and $obotCompose -match 'network_mode: host')
Assert 'Obot Caddyfile uses a shared SELinux label for host and Cezar checkout access' ($obotCompose -cmatch '(?m)^\s+- \./Caddyfile:/etc/caddy/Caddyfile:ro,z$' -and $obotCompose -cnotmatch '(?m)^\s+- \./Caddyfile:/etc/caddy/Caddyfile:.*\bZ\b')
Assert 'Obot exclusive Caddy data volumes get private SELinux relabeling on recreation' ($obotProxyCompose -match '(?m)^\s+- obot-proxy-data:/data:Z$' -and $obotProxyCompose -match '(?m)^\s+- obot-proxy-config:/config:Z$')
Assert 'Obot grants only PostgreSQL initialization, directory, and privilege-drop capabilities' ($obotCompose -match '(?ms)^  obot:.*?security_opt:\s+- no-new-privileges:true\s+- label=disable\s+cap_drop:\s+- ALL\s+cap_add:\s+- CHOWN\s+- DAC_READ_SEARCH\s+- FOWNER\s+- SETGID\s+- SETUID(?:\s|$)')
Assert 'Obot TLS proxy drops all capabilities except the Caddy image requirement' ($obotProxyCompose -match '(?ms)^  https-proxy:.*?cap_drop:\s+- ALL\s+cap_add:\s+- NET_BIND_SERVICE\s*$' -and $obotProxyCompose -notmatch 'no-new-privileges')
 $obotScriptModes = @(& git -C $factory ls-files --stage -- 'integrations/bazzite/obot/deploy.sh' 'integrations/bazzite/obot/validate.sh' 'integrations/bazzite/obot/teardown.sh' 'integrations/bazzite/obot/setup-runtime.sh' | ForEach-Object { ($_ -split '\s+')[0] })
Assert 'Obot host entrypoints are executable in the released Git tree' ($obotScriptModes.Count -eq 4 -and @($obotScriptModes | Where-Object { $_ -ne '100755' }).Count -eq 0)
Assert 'Obot uses only the dedicated rootless runtime socket with API access and app-only SELinux label disable' ($obotCompose -match '/run/obot-runtime-api/podman\.sock:/var/run/docker\.sock(?:\s|$)' -and $obotCompose -notmatch '/run/obot-runtime-api/podman\.sock:/var/run/docker\.sock:ro' -and $obotCompose -match 'DOCKER_HOST: unix:///var/run/docker\.sock' -and $obotCompose -match 'security_opt:\s+- no-new-privileges:true\s+- label=disable' -and $obotProxyCompose -notmatch 'label=disable' -and $obotCompose -notmatch 'privileged:\s*true' -and $obotValidate -match '\$runtime_socket:rw=true' -and $obotValidate -match 'label=disable')
Assert 'Obot does not mount the rootful Docker or default Podman socket' ($obotCompose -notmatch '(?m)^\s+-\s+(/var/run/docker\.sock|/run/podman/podman\.sock):')
Assert 'Dedicated Obot runtime is sandboxed, rate-limited, and ignores absent default socket paths' ($obotSetupRuntime -match 'RUNTIME_USER="obot-runtime"' -and $obotSetupRuntime -match '/var/mnt/podman/obot-runtime/storage' -and $obotSetupRuntime -match 'setfacl -m.*RUNTIME_USER:---' -and $obotSetupRuntime -match 'StartLimitBurst=5' -and $obotSetupRuntime -match 'InaccessiblePaths=\$factory_storage_parent -/run/podman/podman\.sock -/var/run/docker\.sock' -and $obotSetupRuntime -match 'timeout --kill-after=1 3 podman --remote')
Assert 'Obot runtime setup restores the dedicated socket host SELinux label' ($obotSetupRuntime -match 'restorecon -F "\$RUNTIME_API_DIR" "\$RUNTIME_API_SOCKET"' -and $obotSetupRuntime -match 'RUNTIME_API_SOCKET="\$RUNTIME_API_DIR/podman\.sock"')
Assert 'Operator can resolve the dedicated runtime mount point without reading runtime data' ($obotSetupRuntime -match 'setfacl -m "u:\$SUDO_USER:--x" "\$RUNTIME_ROOT"' -and $obotDocs -match 'operator receives execute-only traversal on the runtime')
Assert 'Only Obot receives the runtime socket; HTTPS proxy has no runtime socket' ($obotProxyCompose -notmatch 'docker\.sock|podman\.sock')
Assert 'Obot deployment requires explicit topology services and local control-plane address' ($obotDeploy -match 'FACTORY_CONTROL_PLANE_SERVICES' -and $obotDeploy -match 'FACTORY_CONTROL_PLANE_ADDRESS' -and (Get-Content -Raw (Join-Path $factory 'config/server-topology.env.example')) -match 'FACTORY_CONTROL_PLANE_SERVICES=.*obot obot-https')
Assert 'Obot deploy and validation require app, proxy, and dedicated runtime storage on secondary disk' ($obotDeploy -match 'OBOT_REQUIRED_PODMAN_STORAGE_MOUNT' -and $obotDeploy -match 'findmnt' -and $obotDeploy -match 'runtime_graphroot' -and $obotValidate -match 'volume inspect' -and $obotValidate -match 'graphroot' -and $obotValidate -match 'proxy_volume_mount' -and $obotValidate -match 'runtime_graphroot_real')
Assert 'Obot health validation uses official health endpoint and avoids raw log output' ($obotValidate -match '/api/healthz' -and $obotValidate -notmatch 'podman.*logs')
Assert 'Obot teardown preserves app and CA data unless exact volume names are confirmed' ($obotTeardown -match '--purge-data' -and $obotTeardown -match 'volume rm' -and $obotTeardown -match 'confirmation_text' -and $obotTeardown -match 'All data volumes preserved')
Assert 'Obot teardown removes only Obot-labeled workloads from the isolated runtime' ($obotTeardown -match 'label=mcp\.server\.id' -and $obotTeardown -match 'RUNTIME_API_URL' -and $obotTeardown -notmatch 'podman.*--all.*rm')
Assert 'Obot operator guide documents the least-privilege GitHub MCP and lifecycle evidence' ($obotDocs -match 'api\.githubcopilot\.com/mcp/x/repos/readonly' -and $obotDocs -match 'get_file_contents' -and $obotDocs -match 'backup' -and $obotDocs -match 'Restore' -and $obotDocs -match 'rollback' -and $obotDocs -match 'go/no-go')
$bazziteCompose = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')
Assert 'Bazzite composes a persistent loopback-only Vault service' ($bazziteCompose -match '(?ms)^  vault:.*?127\.0\.0\.1:8200:8200' -and $bazziteCompose -match 'vault-data:/vault/file:Z')
Assert 'Vault uses integrated storage with an explicit mlock setting' ((Get-Content -Raw (Join-Path $factory 'integrations/bazzite/vault-config/vault.hcl')) -match 'storage "raft"' -and (Get-Content -Raw (Join-Path $factory 'integrations/bazzite/vault-config/vault.hcl')) -match 'disable_mlock = true')
$bazziteEnv = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/env.example')
Assert 'LiteLLM has persistent PostgreSQL backing' ($bazziteCompose -match 'litellm-db:' -and $bazziteCompose -match 'litellm-db-data:/var/lib/postgresql/data' -and $bazziteCompose -match 'condition: service_healthy' -and $bazziteEnv -match '(?m)^LITELLM_DATABASE_URL=' -and $bazziteEnv -match '(?m)^LITELLM_SALT_KEY=')
Assert 'OpenHands deployment uses Agent Canvas image' ($bazziteEnv -match 'OPENHANDS_IMAGE=ghcr\.io/openhands/agent-canvas:' -and $bazziteCompose -match 'OPENHANDS_BIND_ADDRESS.*3001:8000' -and $bazziteEnv -match '(?m)^OPENHANDS_BIND_ADDRESS=127\.0\.0\.1')
Assert 'OpenHands deployment persists auth and workspaces' ($bazziteCompose -match 'LOCAL_BACKEND_API_KEY' -and $bazziteCompose -match 'openhands-data:/home/openhands/.openhands' -and $bazziteCompose -match 'openhands-projects:/projects' -and $bazziteEnv -match '(?m)^OPENHANDS_SESSION_API_KEY=')
$openhandsAdapter = Get-Content -Raw (Join-Path $factory 'scripts/openhands/run-job.py')
Assert 'OpenHands provider adapter is bounded, event-backed, and observable' ($openhandsAdapter -match '/api/conversations' -and $openhandsAdapter -match 'worktree' -and $openhandsAdapter -match 'max_iterations' -and $openhandsAdapter -match 'events/search' -and $openhandsAdapter -match 'validationPassed' -and $openhandsAdapter -match 'max_attempts' -and $openhandsAdapter -match 'agent_profile_id' -and $openhandsAdapter -match 'promptTokens' -and $openhandsAdapter -match 'duration')
foreach ($f in Get-ChildItem (Join-Path $factory 'scripts/deploy') -Filter '*.sh') {
    $text = Get-Content -Raw $f.FullName
    Assert "deployment script strict mode $($f.Name)" ($text -match 'set -Eeuo pipefail')
    Assert "deployment script has usage/error path $($f.Name)" ($text -match '>&2|usage|Usage')
}
Assert 'Grafana dashboard JSON is valid' ($(try { Get-Content -Raw (Join-Path $factory 'integrations/bazzite/grafana/dashboards/factory-overview.json') | ConvertFrom-Json | Out-Null; $true } catch { $false }))
Assert 'VERSION is semver' (Test-SemVer (Get-FactoryVersion $factory))
Assert 'local utility docs define bounded advisory contract' ((Get-Content -Raw (Join-Path $factory 'docs/local-utility-jobs.md')) -match '12,000' -and (Get-Content -Raw (Join-Path $factory 'docs/local-utility-jobs.md')) -match 'advisory')
$routingPolicy = Get-Content -Raw (Join-Path $factory 'routing/default.yaml')
$localJobPolicy = Get-Content -Raw (Join-Path $factory 'routing/local-jobs.yaml')
Assert 'routing policy identifies bounded local and premium classes' ($routingPolicy -match '(?ms)classify:\s*\r?\n\s+worker: local' -and $routingPolicy -match '(?ms)implementation:\s*\r?\n\s+preferred: codex' -and $routingPolicy -match '(?ms)architecture:\s*\r?\n\s+preferred: claude' -and $localJobPolicy -match 'summarize-logs:' -and $localJobPolicy -match 'no_code_changes: true')
Assert 'local routing live evidence exists' (Test-Path (Join-Path $factory 'docs/local-utility-live-evidence.md'))
$litellmConfig = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/litellm-config.yaml')
Assert 'LiteLLM health-aware fallback is configured' ($litellmConfig -match 'enable_pre_call_checks:\s*true' -and $litellmConfig -match 'fallbacks:' -and $litellmConfig -match 'factory-code: \[factory-small\]')
Assert 'LiteLLM uses Langfuse v4 OTEL callback' ($litellmConfig -match 'langfuse_otel' -and $bazziteEnv -match '(?m)^LANGFUSE_OTEL_HOST=')
Assert 'LiteLLM logical models target live vLLM model' ($litellmConfig -match 'model: openai/qwen3\.5-9b')
Assert 'LiteLLM normalizes Codex developer messages for Qwen chat templates' ([regex]::Matches($litellmConfig, 'supports_mid_conversation_system:\s*false').Count -eq 2)
Assert 'LiteLLM drops parameters unsupported by the configured model' ($litellmConfig -match '(?m)^\s*drop_params:\s*true\s*$')
Assert 'LiteLLM live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/litellm-live-evidence.md'))
Assert 'LiteLLM bypasses proxy for private vLLM hop from topology' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'FACTORY_VLLM_METRICS_TARGET.*127\.0\.0\.1,localhost' -and (Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')) -match 'NO_PROXY: \$\{NO_PROXY\}')
Assert 'Hindsight deployment uses pinned official image and bounded retain budget' ($bazziteEnv -match 'HINDSIGHT_IMAGE=ghcr\.io/vectorize-io/hindsight:0\.10\.0' -and $bazziteEnv -match '(?m)^HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=12000')
Assert 'Hindsight live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/hindsight-live-evidence.md'))
Assert 'Observability live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/observability-live-evidence.md'))
Assert 'Local utility live evidence exists' (Test-Path (Join-Path $factory 'docs/local-utility-live-evidence.md'))
Assert 'Langfuse live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/langfuse-live-evidence.md'))
$langfuseCompose = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')
$missingLangfuseServices = @(@('langfuse-worker:', 'langfuse-postgres:', 'langfuse-clickhouse:', 'langfuse-redis:', 'langfuse-minio:', 'langfuse-event-storage-init:', 'langfuse-clickhouse-retention:') | Where-Object { $langfuseCompose -notmatch "(?m)^  $_" })
Assert 'Langfuse Compose has web, worker, and all four supporting stores' ($missingLangfuseServices.Count -eq 0)
Assert 'Langfuse release and stateful component versions are explicit' ($bazziteEnv -match '(?m)^LANGFUSE_IMAGE_TAG=\d+\.\d+$' -and $bazziteEnv -match '(?m)^LANGFUSE_POSTGRES_VERSION=' -and $bazziteEnv -match '(?m)^LANGFUSE_CLICKHOUSE_VERSION=' -and $bazziteEnv -match '(?m)^LANGFUSE_REDIS_VERSION=' -and $langfuseCompose -match 'cgr\.dev/chainguard/minio@sha256:[0-9a-f]{64}')
Assert 'Langfuse OSS retention is 30 days for trace tables and isolated event objects, not media' ($bazziteEnv -match '(?m)^LANGFUSE_RETENTION_DAYS=30$' -and $langfuseCompose -match 'LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse-events' -and $langfuseCompose -match 'mc ilm rule add --expire-days' -and $langfuseCompose -match 'mc ilm rule add --prefix events/' -and $langfuseCompose -match 'ALTER TABLE traces MODIFY TTL timestamp' -and $langfuseCompose -match 'ALTER TABLE observations MODIFY TTL start_time' -and $langfuseCompose -match 'ALTER TABLE scores MODIFY TTL timestamp' -and $langfuseCompose -match 'ALTER TABLE event_log MODIFY TTL created_at' -and $langfuseCompose -match 'LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: langfuse')
Assert 'Langfuse web and MinIO are loopback-only while databases stay internal' ($langfuseCompose -match '127\.0\.0\.1:\$\{LANGFUSE_WEB_PORT' -and $langfuseCompose -match '127\.0\.0\.1:\$\{LANGFUSE_MINIO_API_PORT' -and $langfuseCompose -match 'langfuse-postgres-data:/var/lib/postgresql/data' -and $langfuseCompose -match 'langfuse-clickhouse-data:/var/lib/clickhouse' -and $langfuseCompose -notmatch '(?ms)^  langfuse-(postgres|clickhouse|redis):\r?\n(?:(?!^  [\w-]+:).)*?^    ports:')
Assert 'Langfuse operations guide covers isolated upgrades and backups' ((Get-Content -Raw (Join-Path $factory 'docs/langfuse-operations.md')) -match 'Backup and restore rehearsal' -and (Get-Content -Raw (Join-Path $factory 'docs/langfuse-operations.md')) -match 'langfuse-scratch')
$langfuseFixture = Get-Content -Raw (Join-Path $factory 'integrations/langfuse/fixtures/factory-eval-fixture.json') | ConvertFrom-Json
Assert 'Langfuse evaluation fixture is synthetic and correlates two workers' ($langfuseFixture.syntheticOnly -and $langfuseFixture.observations.Count -eq 2 -and $langfuseFixture.observations[0].workerId -ne $langfuseFixture.observations[1].workerId -and $langfuseFixture.observations[1].parentSpanId -eq $langfuseFixture.observations[0].spanId)
Assert 'Langfuse fixture excludes raw prompt, source, command, and secret fields' ((Get-Content -Raw (Join-Path $factory 'integrations/langfuse/fixtures/factory-eval-fixture.json')) -notmatch '(?i)"(prompt|source|command|token|secret|output)"\s*:')
$openhandsEvidence = Get-Content -Raw (Join-Path $factory 'docs/openhands-live-evidence.md')
Assert 'OpenHands live evidence records tool-enabled repository read' ($openhandsEvidence -match '4d1695f0-c868-4e4b-94c4-15672b064e1f' -and $openhandsEvidence -match 'qwen3_xml' -and $openhandsEvidence -match 'terminal\s+actions')
Assert 'OpenHands live evidence records concurrent isolated worktrees' ($openhandsEvidence -match '1cf59217-923a-4187-8c32-7237071ad196' -and $openhandsEvidence -match '2980fac1-408e-4784-b6cc-61aa1987b274' -and $openhandsEvidence -match 'distinct')
Assert 'OpenHands live evidence records failed-task recovery' ($openhandsEvidence -match 'a24884fd-c1ac-4d1e-aa96-aa2d641e7939' -and $openhandsEvidence -match 'exit code 1' -and $openhandsEvidence -match 'recovery-ok')
Assert 'OpenHands live evidence records Cezar provider adapter success' ($openhandsEvidence -match '43cb8a22-fb6c-4f8c-9100-568d0b06314f' -and $openhandsEvidence -match 'validationPassed: true')
Assert 'OpenHands live evidence records bounded provider retry' ($openhandsEvidence -match 'b0b1f575-4b42-451b-a736-684e06605941' -and $openhandsEvidence -match '8389f81b-a0d8-469a-b742-eaa23de90a3e' -and $openhandsEvidence -match 'attempts: 2')
Assert 'vLLM live evidence records latency and throughput' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match '2\.008 seconds' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match '34\.75')
Assert 'vLLM live evidence records topology without identifiers' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'Apple M6' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'Metal 4' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -notmatch 'Serial Number|Hardware UUID')
Assert 'vLLM route uses configured control-plane-reachable address' ((Get-Content -Raw (Join-Path $factory 'config/server-topology.env.example')) -match '(?m)^FACTORY_VLLM_BASE_URL=' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'network namespace')
Assert 'vLLM live evidence records coding capability' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'coding capability check' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'qwen3\.5-9b')
Assert 'vLLM live evidence records general model candidate' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'gemma-4-E4B' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match '0\.992 seconds')
Assert 'vLLM live evidence records persistent general profile' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'com\.vllm\.gemma4\.plist' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'Both model profiles')
Assert 'vLLM live evidence records unified-memory footprint' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match '1,336 MB physical footprint' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match '4,164 MB')
Assert 'vLLM live evidence records trusted proxy cutover' ((Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'com\.vllm\.trusted-proxy' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'HTTP 401' -and (Get-Content -Raw (Join-Path $factory 'docs/vllm-live-evidence.md')) -match 'connection refused')
foreach ($f in Get-ChildItem (Join-Path $factory 'schemas') -Filter *.json -Recurse) {
    $ok = $true; try { Get-Content -Raw $f.FullName | ConvertFrom-Json | Out-Null } catch { $ok = $false }
    Assert "valid JSON schemas/$($f.Name)" $ok
}
$releaseFixtures = Join-Path $factory 'schemas/factory-release/fixtures'
$releaseSchemas = Join-Path $factory 'schemas/factory-release'
$manifestFixture = Get-Content -Raw (Join-Path $releaseFixtures 'manifest-valid.json')
$manifestUnknown = Get-Content -Raw (Join-Path $releaseFixtures 'manifest-unknown-schema.json')
$activeReceipt = Get-Content -Raw (Join-Path $releaseFixtures 'receipt-active.json')
$incompatibleReceipt = Get-Content -Raw (Join-Path $releaseFixtures 'receipt-incompatible.json')
$stagedReceipt = Get-Content -Raw (Join-Path $releaseFixtures 'receipt-staged.json')
$verifiedState = Get-Content -Raw (Join-Path $releaseFixtures 'state-verified.json')
$activeLease = Get-Content -Raw (Join-Path $releaseFixtures 'lease-active.json')
$expiredLease = Get-Content -Raw (Join-Path $releaseFixtures 'lease-expired.json')
$healthyPromotion = Get-Content -Raw (Join-Path $releaseFixtures 'promotion-healthy.json')
Assert 'release contracts: valid immutable manifest fixture satisfies JSON Schema' (Test-Json -Json $manifestFixture -SchemaFile (Join-Path $releaseSchemas 'manifest.schema.json'))
Assert 'release contracts: unknown manifest schema fixture is rejected by v1 schema' (-not (Test-Json -Json $manifestUnknown -SchemaFile (Join-Path $releaseSchemas 'manifest.schema.json') -ErrorAction SilentlyContinue))
Assert 'release contracts: active target receipt fixture satisfies JSON Schema' (Test-Json -Json $activeReceipt -SchemaFile (Join-Path $releaseSchemas 'receipt.schema.json'))
Assert 'release contracts: incompatible target is distinct from a failed release' (Test-Json -Json $incompatibleReceipt -SchemaFile (Join-Path $releaseSchemas 'receipt.schema.json'))
Assert 'release contracts: interrupted activation remains a recoverable staged receipt' (Test-Json -Json $stagedReceipt -SchemaFile (Join-Path $releaseSchemas 'receipt.schema.json'))
Assert 'release contracts: verified release requires passing evidence' (Test-Json -Json $verifiedState -SchemaFile (Join-Path $releaseSchemas 'state.schema.json'))
Assert 'release contracts: active and expired task pins satisfy lease shape' ((Test-Json -Json $activeLease -SchemaFile (Join-Path $releaseSchemas 'lease.schema.json')) -and (Test-Json -Json $expiredLease -SchemaFile (Join-Path $releaseSchemas 'lease.schema.json')))
Assert 'release contracts: local promotion evidence fixture satisfies its versioned schema' (Test-Json -Json $healthyPromotion -SchemaFile (Join-Path $releaseSchemas 'promotion-record.schema.json'))
$unsafeManifest = (Get-Content -Raw (Join-Path $releaseFixtures 'manifest-valid.json') | ConvertFrom-Json -AsHashtable); $unsafeManifest.files[0].path = '../VERSION'
Assert 'release contracts: path traversal is rejected' (-not (Test-Json -Json ($unsafeManifest | ConvertTo-Json -Depth 20) -SchemaFile (Join-Path $releaseSchemas 'manifest.schema.json') -ErrorAction SilentlyContinue))
foreach ($path in @(& git -C $factory ls-files -- '*.yaml' '*.yml' | Where-Object { $_ -notmatch '(^|/)(tests|node_modules)/' -and (Test-Path (Join-Path $factory $_)) })) {
    $file = Join-Path $factory $path
    $t = Get-Content -Raw $file
    Assert "yaml sane $path" (-not $t.Contains("`t") -and $t.Trim().Length -gt 0)
}
foreach ($d in Get-ChildItem (Join-Path $factory 'skills') -Directory) {
    $p = Join-Path $d.FullName 'SKILL.md'
    Assert "skill $($d.Name) has SKILL.md" ((Test-Path $p) -and ((Get-Content -Raw $p) -match '(?m)^# '))
}
$allowedPlaceholders = 'github.kind', 'github.number', 'github.title', 'github.url', 'github.author', 'github.assignees', 'github.labels', 'github.event', 'date', 'time', 'project', 'automation'
foreach ($f in Get-ChildItem (Join-Path $factory 'automations') -Filter *.json) {
    $d = Get-Content -Raw $f.FullName | ConvertFrom-Json
    Assert "automation $($f.Name) name prefixed" $d.name.StartsWith('[factory] ')
    Assert "automation $($f.Name) workflow exists" (Test-Path (Join-Path $factory "workflows/$($d.task.workflow -replace '^factory-', '').yaml"))
    $ph = [regex]::Matches($d.task.prompt, '\{\{([^}]+)\}\}') | ForEach-Object { $_.Groups[1].Value }
    Assert "automation $($f.Name) placeholders allowed" (-not ($ph | Where-Object { $allowedPlaceholders -notcontains $_ }))
    if ($d.kind -eq 'github') {
        Assert "automation $($f.Name) poll keys" ($d.events -and $d.intervalSeconds -ge 60 -and $d.filters)
        if ($d.events -contains 'issue.labeled') { Assert "automation $($f.Name) changedLabels" ([bool]$d.filters.changedLabels) }
    }
    else { Assert "automation $($f.Name) schedule" ([bool]$d.schedule) }
    # Level-triggered: an issue.labeled automation also re-lists open issues that still carry its label, so an event
    # it never saw is recovered, and it admits one new launch per poll so a backlog cannot start all at once.
    if ($d.kind -eq 'github' -and @($d.events) -contains 'issue.labeled') {
        Assert "automation $($f.Name) reconciles existing labels (fullReconcileHours) and admits one launch per poll" ($d.filters.fullReconcileHours -ge 1 -and $d.filters.fullReconcileHours -le 24 -and $d.filters.maxAdmissionsPerCycle -eq 1 -and $d.filters.maxRecords -ge 10)
        $initialSyncProperty = $d.filters.PSObject.Properties['initialSync']
        $initialSync = if ($initialSyncProperty) { [string]$initialSyncProperty.Value } else { '' }
        Assert "automation $($f.Name) never replays history on creation if it starts or fixes work" (($d.task.workflow -notin 'factory-implement', 'factory-fix-review') -or $initialSync -ne 'eligible')
    }
}
# Workflows must satisfy Cezar's schema: unique ids, agent XOR check steps, onFail.retry -> earlier step.
foreach ($f in Get-ChildItem (Join-Path $factory 'workflows') -Filter *.yaml) {
    $ids = @(); $cur = $null; $steps = @()
    foreach ($l in Get-Content $f.FullName) {
        if ($l -match '^  - id:\s*(\S+)') { $cur = @{ id = $Matches[1]; agent = $false; check = $false; retry = $null }; $steps += $cur }
        elseif ($cur -and $l -match '^    (skill|prompt):') { $cur.agent = $true }
        elseif ($cur -and $l -match '^    command:') { $cur.check = $true }
        elseif ($cur -and $l -match '^      retry:\s*(\S+)') { $cur.retry = $Matches[1] }
    }
    $t = Get-Content -Raw $f.FullName
    Assert "workflow $($f.Name) name factory-$($f.BaseName)" ($t -match "(?m)^name:\s*factory-$($f.BaseName)\s*$")
    Assert "workflow $($f.Name) has steps" ($steps.Count -ge 1)
    Assert "workflow $($f.Name) steps agent XOR check" (-not ($steps | Where-Object { $_.agent -eq $_.check }))
    Assert "workflow $($f.Name) unique ids" (@($steps.id | Sort-Object -Unique).Count -eq $steps.Count)
    $okRetry = $true
    for ($i = 0; $i -lt $steps.Count; $i++) { if ($steps[$i].retry) { $earlier = @(); if ($i -gt 0) { $earlier = @($steps[0..($i - 1)] | ForEach-Object { $_.id }) }; if ($earlier -notcontains $steps[$i].retry) { $okRetry = $false } } }
    Assert "workflow $($f.Name) retry targets earlier step" $okRetry
}

# No script may define a function named like the external command it shells out to (`gh`): PowerShell
# resolves functions before executables, so `& 'gh'` would call the function and recurse forever.
foreach ($f in Get-ChildItem (Join-Path $factory 'scripts') -Filter *.ps1) {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$null)
    $bad = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'gh', 'git', 'uv', 'npm', 'pwsh', 'node' }, $true))
    Assert "no command-shadowing functions in $($f.Name)" ($bad.Count -eq 0)
}

# Lifecycle as data (policies/lifecycle.json, scripts/lifecycle-lib.ps1). The shipped profile must be
# sound: every state has an owner, an exit and a deadline, agrees with the label taxonomy, and every
# automated state has an automation that consumes it. A state missing from one hard-coded list was
# how work ended up where nothing picked it up.
. (Join-Path $factory 'scripts/lifecycle-lib.ps1')
$lifecycle = Get-FactoryLifecycle
$taxonomyStates = @(); $inTaxonomy = $false
foreach ($l in Get-Content (Join-Path $factory 'policies/labels.yaml')) {
    if ($l -match '^factory-state:') { $inTaxonomy = $true; continue }
    if ($inTaxonomy -and $l -match '^\s+-\s+(\S+)') { $taxonomyStates += $Matches[1]; continue }
    if ($inTaxonomy -and $l -match '^\S') { break }
}
$automationDefinitions = @(Get-ChildItem (Join-Path $factory 'automations') -Filter *.json | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json })
# Every profile the policy ships must be sound, not only the default. A profile that extends another is resolved
# first; the label taxonomy must be covered by it, and equal to it for the default profile.
$shippedProfiles = @((Get-Content -Raw (Join-Path $factory 'policies/lifecycle.json') | ConvertFrom-Json -AsHashtable).profiles.Keys)
Assert "the policy ships the standard profile and at least one variant ($($shippedProfiles -join ', '))" ($shippedProfiles -contains 'standard' -and $shippedProfiles.Count -ge 2)
foreach ($shippedProfile in $shippedProfiles) {
    $shippedLifecycle = Get-FactoryLifecycle -Profile $shippedProfile
    $shippedTaxonomy = @(); if ($shippedProfile -eq $lifecycle.Name) { $shippedTaxonomy = $taxonomyStates }
    $shippedProblems = Test-FactoryLifecycle -Lifecycle $shippedLifecycle -StateLabels $shippedTaxonomy -Automations $automationDefinitions
    $shippedProblems += @($taxonomyStates | Where-Object { $shippedLifecycle.States.Keys -notcontains $_ } | ForEach-Object { "profile $shippedProfile lacks the taxonomy state $_" })
    $shippedProblems | ForEach-Object { Write-Host "    $_" }
    Assert "lifecycle profile '$shippedProfile' is sound" ($shippedProblems.Count -eq 0)
}
$riskGated = Get-FactoryLifecycle -Profile 'risk-gated'
Assert 'the risk-gated profile extends standard: it inherits every state and adds a human sign-off gate' (@($lifecycle.States.Keys | Where-Object { $riskGated.States.Keys -notcontains $_ }).Count -eq 0 -and $riskGated.States['factory:design-signoff']['kind'] -eq 'human' -and $riskGated.States['factory:design-signoff']['owner']['role'] -eq 'tech-lead')
Assert 'a conditional exit applies only to the labels it names' ((Get-FactoryLifecycleConditionalExit -Lifecycle $riskGated -State 'factory:needs-plan' -Event 'plan-result' -IssueLabels @('risk:high')) -eq 'factory:design-signoff' -and $null -eq (Get-FactoryLifecycleConditionalExit -Lifecycle $riskGated -State 'factory:needs-plan' -Event 'plan-result' -IssueLabels @('risk:medium')) -and $null -eq (Get-FactoryLifecycleConditionalExit -Lifecycle $lifecycle -State 'factory:needs-plan' -Event 'plan-result' -IssueLabels @('risk:high')))
$lifecycleDoc = (Get-Content -Raw (Join-Path $factory 'docs/lifecycle.md')).Replace("`r`n", "`n")
$tableBlock = [regex]::Match($lifecycleDoc, '(?s)<!-- lifecycle-table:begin -->\n(.*?)\n<!-- lifecycle-table:end -->')
Assert 'docs/lifecycle.md carries the state table rendered from the standard profile (refresh: pwsh -Command ". scripts/lifecycle-lib.ps1; Update-FactoryLifecycleDoc")' ($tableBlock.Success -and $tableBlock.Groups[1].Value.Trim() -eq (Format-FactoryLifecycleTable -Lifecycle (Get-FactoryLifecycle -Profile 'standard')).Trim())
$lifecycleProblems = Test-FactoryLifecycle -Lifecycle $lifecycle -StateLabels $taxonomyStates -Automations $automationDefinitions
$lifecycleProblems | ForEach-Object { Write-Host "    $_" }
Assert 'shipped lifecycle profile is sound: every state has an owner, an exit, a deadline and a consumer' ($lifecycleProblems.Count -eq 0)
Assert 'lifecycle loader answers which states are automated and which wait for a person' ((Get-FactoryLifecycleStates $lifecycle -Kind automated) -contains 'factory:ready' -and (Get-FactoryLifecycleStates $lifecycle -Kind human) -contains 'factory:needs-help' -and @(Get-FactoryLifecycleStates $lifecycle -Kind terminal).Count -eq 1)
$lifecycleFixture = Join-Path ([IO.Path]::GetTempPath()) "factory-lifecycle-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"
try {
    # A second profile changes the process by configuration alone: risky work passes a technical
    # design step and a manual sign-off before it is ready.
    $custom = Get-Content -Raw (Join-Path $factory 'policies/lifecycle.json') | ConvertFrom-Json -AsHashtable
    $gated = $custom.profiles.standard | ConvertTo-Json -Depth 12 | ConvertFrom-Json -AsHashtable
    $gated.states['factory:needs-plan'].exits += @{ to = 'factory:tech-design'; on = 'plan-result'; when = @{ risk = @('risk:high') } }
    $gated.states['factory:tech-design'] = @{ kind = 'automated'; owner = @{ workflow = 'factory-tech-design' }; exits = @(@{ to = 'factory:design-signoff'; on = 'design-result' }); maxDwellHours = 24; onTimeout = 'retrigger' }
    $gated.states['factory:design-signoff'] = @{ kind = 'human'; owner = @{ role = 'tech-lead' }; exits = @(@{ to = 'factory:ready'; on = 'manual' }, @{ to = 'factory:needs-plan'; on = 'manual' }); maxDwellHours = 72; onTimeout = 'escalate' }
    $custom.profiles['design-gated'] = $gated
    $custom | ConvertTo-Json -Depth 14 | Set-Content $lifecycleFixture
    $gatedLifecycle = Get-FactoryLifecycle -Path $lifecycleFixture -Profile 'design-gated'
    $gatedAutomations = $automationDefinitions + [pscustomobject]@{ kind = 'github'; filters = [pscustomobject]@{ allLabels = @('factory:tech-design') }; task = [pscustomobject]@{ workflow = 'factory-tech-design' } }
    $gatedProblems = Test-FactoryLifecycle -Lifecycle $gatedLifecycle -StateLabels ($taxonomyStates + 'factory:tech-design', 'factory:design-signoff') -Automations $gatedAutomations
    $gatedProblems | ForEach-Object { Write-Host "    $_" }
    Assert 'a profile can add a technical-design step with manual sign-off by configuration alone' ($gatedProblems.Count -eq 0 -and (Get-FactoryLifecycleStates $gatedLifecycle -Kind human) -contains 'factory:design-signoff')
    $withoutConsumer = Test-FactoryLifecycle -Lifecycle $gatedLifecycle -StateLabels ($taxonomyStates + 'factory:tech-design', 'factory:design-signoff') -Automations $automationDefinitions
    Assert 'lifecycle check rejects an automated state that no automation consumes' (@($withoutConsumer | Where-Object { $_ -match 'factory:tech-design is automated but no automation' }).Count -eq 1)
    # Seeded defects: each must be reported.
    $broken = $custom.profiles.standard | ConvertTo-Json -Depth 12 | ConvertFrom-Json -AsHashtable
    $broken.states['factory:blocked'].exits = @()
    $broken.states['factory:needs-help'].Remove('maxDwellHours')
    $broken.states['factory:review'].exits += @{ to = 'factory:nowhere'; on = 'review-result' }
    $broken.states['factory:investigate'].Remove('owner')
    $custom.profiles['broken'] = $broken
    $custom | ConvertTo-Json -Depth 14 | Set-Content $lifecycleFixture
    $brokenProblems = Test-FactoryLifecycle -Lifecycle (Get-FactoryLifecycle -Path $lifecycleFixture -Profile 'broken') -StateLabels $taxonomyStates -Automations $automationDefinitions
    Assert 'lifecycle check reports a state with no exit, no deadline, an undefined target and no owner' (@($brokenProblems | Where-Object { $_ -match 'factory:blocked has no exit' }).Count -eq 1 -and @($brokenProblems | Where-Object { $_ -match 'factory:needs-help has no deadline' }).Count -eq 1 -and @($brokenProblems | Where-Object { $_ -match "factory:review exits to undefined state 'factory:nowhere'" }).Count -eq 1 -and @($brokenProblems | Where-Object { $_ -match 'factory:investigate has no owning workflow' }).Count -eq 1)
    $unknownProfile = $false; try { Get-FactoryLifecycle -Path $lifecycleFixture -Profile 'missing' | Out-Null } catch { $unknownProfile = $_.Exception.Message -match "profile 'missing' is not defined" }
    Assert 'lifecycle loader refuses an undefined profile' $unknownProfile
    # A malformed condition and a profile that extends something that does not exist are both reported.
    $badWhen = $custom.profiles.standard | ConvertTo-Json -Depth 12 | ConvertFrom-Json -AsHashtable
    $badWhen.states['factory:needs-plan'].exits += @{ to = 'factory:ready'; on = 'plan-result'; when = @{ colour = @('red'); risk = @('high') } }
    $custom.profiles['bad-when'] = $badWhen
    $custom.profiles['orphan'] = @{ extends = 'nothing'; states = @{} }
    $custom | ConvertTo-Json -Depth 14 | Set-Content $lifecycleFixture
    $badWhenProblems = Test-FactoryLifecycle -Lifecycle (Get-FactoryLifecycle -Path $lifecycleFixture -Profile 'bad-when') -StateLabels $taxonomyStates -Automations $automationDefinitions
    $orphanMessage = ''; try { Get-FactoryLifecycle -Path $lifecycleFixture -Profile 'orphan' | Out-Null } catch { $orphanMessage = $_.Exception.Message }
    Assert 'lifecycle check reports an unknown condition and a condition that is not a label of its kind; a profile extending a missing profile is refused' (@($badWhenProblems | Where-Object { $_ -match "unknown condition 'colour'" }).Count -eq 1 -and @($badWhenProblems | Where-Object { $_ -match "condition 'risk' must list risk:" }).Count -eq 1 -and $orphanMessage -match "extends 'nothing', which is not defined")
}
finally { Remove-Item -Force $lifecycleFixture -ErrorAction SilentlyContinue }

# The router and the model must agree (STABILIZATION-PLAN.md item 1.4c). For each event the router handles, every
# state it accepts as a source and every state it sets must be an exit the model declares for that event, and every
# model exit for one of those events must be one the router can take. Editing one without the other fails here.
$routerText = Get-Content -Raw (Join-Path $factory 'scripts/route-state.ps1')
$routerBlocks = @{}
foreach ($m in [regex]::Matches($routerText.Substring($routerText.IndexOf('switch ($Event) {')), "(?ms)^    '([a-z-]+)' \{(.*?)(?=^    '[a-z-]+' \{|\z)")) { $routerBlocks[$m.Groups[1].Value] = $m.Groups[2].Value }
$routerDrift = @()
foreach ($evt in $routerBlocks.Keys) {
    if ($evt -eq 'already-resolved') { continue }
    $sources = @([regex]::Matches((($routerBlocks[$evt] -split "`n") | Where-Object { $_ -match 'Assert-Source' }) -join ' ', "'(factory:[a-z-]+)'") | ForEach-Object { $_.Groups[1].Value })
    $targets = @([regex]::Matches($routerBlocks[$evt], "Set-State '(factory:[a-z-]+)'") | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    foreach ($t in $targets) {
        if (-not @($sources | Where-Object { @($lifecycle.States[$_]['exits'] | Where-Object { $_['to'] -eq $t }).Count }).Count) { $routerDrift += "$evt sets $t, which no accepted source reaches in the model" }
    }
}
foreach ($stateName in $lifecycle.States.Keys) {
    foreach ($exit in @($lifecycle.States[$stateName]['exits'] | Where-Object { $_ })) {
        $evt = [string]$exit['on']
        if (-not $routerBlocks.ContainsKey($evt)) { continue }
        $block = $routerBlocks[$evt]
        $accepts = (($block -split "`n") | Where-Object { $_ -match 'Assert-Source' }) -join ' '
        if ($accepts -notmatch [regex]::Escape("'$stateName'") -or $block -notmatch [regex]::Escape("'$($exit['to'])'")) { $routerDrift += "model exit $stateName -> $($exit['to']) on $evt is not handled by route-state.ps1" }
    }
}
$routerDrift | ForEach-Object { Write-Host "    $_" }
Assert 'route-state.ps1 and the lifecycle model declare the same transitions' ($routerBlocks.Count -ge 6 -and -not $routerDrift.Count)

# The lifecycle lives in policies/lifecycle.json. These scripts still name lifecycle states in code and
# are being moved to the loader (STABILIZATION-PLAN.md item 1.4c); the list may shrink, never grow. A new
# script that needs to know the states asks scripts/lifecycle-lib.ps1.
$stateLiteralAllowlist = 'route-state.ps1', 'onboard-project.ps1', 'create-labels.ps1', 'apply-backlog-label-audit.ps1', 'sync-issue-delivery.ps1', 'maintain-repository.ps1', 'audit-backlog-labels.ps1', 'update-github-lifecycle.ps1', 'collect-backlog-snapshot.ps1', 'watchdog-automations.ps1', 'select-intake-issue.ps1', 'reconcile-backlog.ps1', 'publish-failure-audit.ps1', 'check-already-resolved.ps1'
$stateLiteralPattern = "'(" + ((@($lifecycle.States.Keys) | ForEach-Object { [regex]::Escape($_) }) -join '|') + ")'"
$stateLiteralFiles = @(Get-ChildItem (Join-Path $factory 'scripts') -Filter *.ps1 | Where-Object { (Get-Content -Raw $_.FullName) -match $stateLiteralPattern } | ForEach-Object { $_.Name })
$newStateLiteralFiles = @($stateLiteralFiles | Where-Object { $stateLiteralAllowlist -notcontains $_ })
$newStateLiteralFiles | ForEach-Object { Write-Host "    $_ names lifecycle states in code; read them from scripts/lifecycle-lib.ps1" }
Assert 'no new script hard-codes lifecycle states (read them from the lifecycle policy)' ($newStateLiteralFiles.Count -eq 0)
Assert 'the hard-coded lifecycle-state allowlist has no stale entries' (@($stateLiteralAllowlist | Where-Object { $stateLiteralFiles -notcontains $_ }).Count -eq 0)

# Script and workflow contract (tests/workflow-contract.ps1): every script parses, and every workflow
# command step names an existing script and passes exactly the parameters it declares. A workflow step
# is the only caller of most scripts and first runs on the host after merge, so this is checked here.
. (Join-Path $PSScriptRoot 'workflow-contract.ps1')
$parseProblems = Get-ScriptParseProblems -Roots @((Join-Path $factory 'scripts'), (Join-Path $factory 'tests'), (Join-Path $factory '.claude'))
$parseProblems | ForEach-Object { Write-Host "    $_" }
Assert 'every PowerShell script parses without errors' ($parseProblems.Count -eq 0)
$contractProblems = Get-WorkflowContractProblems -WorkflowsPath (Join-Path $factory 'workflows') -FactoryRoot $factory
$contractProblems | ForEach-Object { Write-Host "    $_" }
Assert 'every workflow command step matches its script (exists, declared parameters, mandatory parameters)' ($contractProblems.Count -eq 0)
$portabilityProblems = Get-PortabilityProblems -Roots @((Join-Path $factory 'scripts'), (Join-Path $factory 'tests'), (Join-Path $factory '.claude'))
$portabilityProblems | ForEach-Object { Write-Host "    $_" }
Assert 'no script uses a construct that only works on Windows (the Factory runs on Linux)' ($portabilityProblems.Count -eq 0)
$hostCommandProblems = Get-HostCommandProblems -FactoryRoot $factory
$hostCommandProblems | ForEach-Object { Write-Host "    $_" }
Assert 'every Python entry point is started with flags and a command its argument parser defines (workflows and systemd units)' ($hostCommandProblems.Count -eq 0)
# Prove the checks fire: a fixture with one of each defect must report each of them.
$contractFixture = Join-Path ([IO.Path]::GetTempPath()) "factory-contract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $contractFixture 'scripts'), (Join-Path $contractFixture 'workflows') | Out-Null
    'param([Parameter(Mandatory)][string]$InputPath, [string]$OutputPath)' | Set-Content (Join-Path $contractFixture 'scripts/good.ps1')
    'param([string]$Path' | Set-Content (Join-Path $contractFixture 'scripts/broken.ps1')
    @(
        'steps:'
        '  - id: ok'
        '    command: pwsh -NoProfile -File $FACTORY_RUNTIME_ROOT/scripts/good.ps1 -InputPath "a -Quoted b" -OutputPath out.json'
        '  - id: renamed'
        '    command: pwsh -NoProfile -File $FACTORY_RUNTIME_ROOT/scripts/good.ps1 -InputPath a -ResultPath out.json'
        '  - id: missing-mandatory'
        '    command: pwsh -NoProfile -File $FACTORY_RUNTIME_ROOT/scripts/good.ps1 -OutputPath out.json'
        '  - id: deleted'
        '    command: pwsh -NoProfile -File $FACTORY_RUNTIME_ROOT/scripts/gone.ps1'
    ) | Set-Content (Join-Path $contractFixture 'workflows/fixture.yaml')
    $seededParse = Get-ScriptParseProblems -Roots @((Join-Path $contractFixture 'scripts'))
    $seededContract = Get-WorkflowContractProblems -WorkflowsPath (Join-Path $contractFixture 'workflows') -FactoryRoot $contractFixture
    Assert 'contract check reports a script with a syntax error' (@($seededParse | Where-Object { $_ -match 'broken\.ps1' }).Count -ge 1 -and @($seededParse | Where-Object { $_ -match 'good\.ps1' }).Count -eq 0)
    @(
        'Start-Process pwsh -WindowStyle Hidden'
        '$state = Join-Path $env:LOCALAPPDATA "factory"'
        '$fallback = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:HOME }'
        '$tool = "C:\tools\gh.exe"'
        '& "wrapper.cmd"'
        'Start-Process notepad -WindowStyle Hidden # windows-only'
    ) | Set-Content (Join-Path $contractFixture 'scripts/windows.ps1')
    $seededPortability = @((Get-PortabilityProblems -Roots @((Join-Path $contractFixture 'scripts'))) | Where-Object { $_ -match 'windows\.ps1' })
    Assert 'portability check reports a Windows-only parameter, an unguarded Windows variable, a drive path and a command shim, and accepts a guarded or marked line' ($seededPortability.Count -eq 4 -and @($seededPortability | Where-Object { $_ -match ':1 .*-WindowStyle' }).Count -eq 1 -and @($seededPortability | Where-Object { $_ -match ':2 .*LOCALAPPDATA' }).Count -eq 1 -and @($seededPortability | Where-Object { $_ -match ':4 .*drive-letter' }).Count -eq 1 -and @($seededPortability | Where-Object { $_ -match ':5 .*shim' }).Count -eq 1)
    New-Item -ItemType Directory -Force -Path (Join-Path $contractFixture 'scripts/release') | Out-Null
    'p.add_argument("command", choices=("run", "status")); p.add_argument("--repo"); p.add_argument("--store")' | Set-Content (Join-Path $contractFixture 'scripts/release/tool.py')
    @(
        'ExecStart=/usr/bin/python3 %h/cezar-factory/scripts/release/tool.py run --repo %h/x --store %h/y'
        'ExecStart=/usr/bin/python3 %h/cezar-factory/scripts/release/tool.py run --repo %h/x --state-root %h/y'
        'ExecStart=/usr/bin/python3 %h/cezar-factory/scripts/release/tool.py promote --repo %h/x'
        'ExecStart=/usr/bin/python3 %h/cezar-factory/scripts/release/absent.py run'
    ) | Set-Content (Join-Path $contractFixture 'unit.service')
    $seededHost = Get-HostCommandProblems -FactoryRoot $contractFixture -CommandFiles @((Join-Path $contractFixture 'unit.service'))
    Assert 'host command check reports an undefined flag, an unknown command and a missing script, and accepts a correct unit' ($seededHost.Count -eq 3 -and @($seededHost | Where-Object { $_ -match ':2 .*--state-root' }).Count -eq 1 -and @($seededHost | Where-Object { $_ -match ":3 .*'promote'" }).Count -eq 1 -and @($seededHost | Where-Object { $_ -match ':4 .*absent\.py does not exist' }).Count -eq 1)
    Assert 'contract check reports an undeclared parameter, a missing mandatory parameter and a missing script, and nothing else' ($seededContract.Count -eq 3 -and @($seededContract | Where-Object { $_ -match ':5 .*-ResultPath' }).Count -eq 1 -and @($seededContract | Where-Object { $_ -match ':7 .*mandatory -InputPath' }).Count -eq 1 -and @($seededContract | Where-Object { $_ -match ':9 .*gone\.ps1 does not exist' }).Count -eq 1)
}
finally { Remove-Item -Recurse -Force $contractFixture -ErrorAction SilentlyContinue }

# Start every script a workflow runs, exactly as its workflow step starts it (table-driven from the workflows, so
# a new step is covered the day it is written). Scripts that probe live endpoints or need a real model are left to
# their own tests and canaries.
$smokeSkip = 'scripts/probe-model-endpoint.ps1', 'scripts/collect-environment-state.ps1', 'scripts/factory-startup.ps1'
$startDirectory = Join-Path ([IO.Path]::GetTempPath()) "factory-start-$([guid]::NewGuid().ToString('N').Substring(0,8))"
try {
    $smokeInvocations = Get-WorkflowScriptInvocations -WorkflowsPath (Join-Path $factory 'workflows') -Skip $smokeSkip
    Assert "the workflows yield start-up invocations for a broad set of scripts ($($smokeInvocations.Count))" ($smokeInvocations.Count -ge 30)
    $startProblems = Get-ScriptStartProblems -FactoryRoot $factory -WorkDirectory $startDirectory -Invocations $smokeInvocations
    $startProblems | ForEach-Object { Write-Host "    $_" }
    Assert 'every workflow script starts, as its workflow starts it, without dying on a defect in its own code' ($startProblems.Count -eq 0)
    New-Item -ItemType Directory -Force -Path (Join-Path $startDirectory 'seed/scripts') | Out-Null
    'param([string]$Path) Get-Content -Raw $Path -WindowStyle Hidden' | Set-Content (Join-Path $startDirectory 'seed/scripts/defect.ps1')
    'param([string]$Path) if (-not (Test-Path $Path)) { Write-Error "result file not found: $Path"; exit 1 }' | Set-Content (Join-Path $startDirectory 'seed/scripts/refuses.ps1')
    $seededStart = Get-ScriptStartProblems -FactoryRoot (Join-Path $startDirectory 'seed') -WorkDirectory (Join-Path $startDirectory 'seed-work') -Invocations @{ 'scripts/defect.ps1' = @('-Path', 'x.json'); 'scripts/refuses.ps1' = @('-Path', 'x.json') }
    Assert 'start-up smoke reports a script that dies on its own defect and accepts one that refuses its input' ($seededStart.Count -eq 1 -and $seededStart[0] -match 'defect\.ps1')
}
finally { Remove-Item -Recurse -Force $startDirectory -ErrorAction SilentlyContinue }

if ($StaticOnly) {
    if ($script:fail) { Write-Error "$script:fail static checks failed."; exit 1 }
    Write-Host 'STATIC CHECKS PASSED'
    exit 0
}

# ---- Scenarios -----------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) "factory-tests-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory $tmp | Out-Null
try {
    # factory-startup names a stale shared core.worktree instead of failing with a bare path error.
    $staleRepo = Join-Path $tmp 'stale-core-worktree'
    New-Item -ItemType Directory $staleRepo | Out-Null
    Push-Location $staleRepo
    try {
        & git init -q -b main; & git config user.email t@example.com; & git config user.name t
        'x' | Set-Content seed.txt; & git add -A; & git commit -q -m seed
        $taskWorktree = Join-Path $tmp 'stale-core-worktree-task'
        & git worktree add -q -b task $taskWorktree
        # Production shape: per-worktree config is enabled, the main worktree pins its own
        # core.worktree, and a stray shared core.worktree names a directory that does not exist.
        & git config extensions.worktreeConfig true; & git config --worktree core.worktree $staleRepo
        & git config core.worktree (Join-Path $tmp 'does-not-exist')
        Push-Location $taskWorktree
        try { $staleStartup = Run 'factory-startup.ps1' @{ Workflow = 'factory-test'; Step = 'check'; OutputPath = (Join-Path $tmp 'stale-startup.json') } } finally { Pop-Location }
    } finally { Pop-Location }
    Assert 'startup reports a stale core.worktree with an actionable code and message' ($staleStartup.Code -eq 1 -and $staleStartup.Out -match 'GIT_WORKTREE_CONFIG_INVALID' -and $staleStartup.Out -match 'git config --local --unset core.worktree')
    # watchdog-automations cancels only stale runs of the named workflows and never the calling run.
    $wdPort = Get-Random -Minimum 20000 -Maximum 40000
    $wdLog = Join-Path $tmp 'watchdog-cancelled.txt'
    $wdOld = [DateTime]::UtcNow.AddMinutes(-90).ToString('o'); $wdYoung = [DateTime]::UtcNow.AddMinutes(-2).ToString('o')
    $wdRuns = @{ runs = @(
        @{ id = 'r-old-maint'; status = 'running'; startedAt = $wdOld; workflow = 'factory-maintenance' }
        @{ id = 'r-old-impl'; status = 'running'; startedAt = $wdOld; workflow = 'factory-implement' }
        @{ id = 'r-self'; status = 'running'; startedAt = $wdOld; workflow = 'factory-maintenance' }
        @{ id = 'r-young'; status = 'running'; startedAt = $wdYoung; workflow = 'factory-maintenance' }
        @{ id = 'r-done'; status = 'done'; startedAt = $wdOld; workflow = 'factory-maintenance' }) } | ConvertTo-Json -Depth 5
    $wdJob = Start-Job -ArgumentList $wdPort, $wdRuns, $wdLog -ScriptBlock {
        param($port, $json, $log)
        # HttpListener cannot start on some restricted Windows runners. Use a
        # loopback TCP listener, matching tests/mock-cezar.ps1's fixture.
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
        $until = [DateTime]::UtcNow.AddSeconds(60)
        try {
            while ([DateTime]::UtcNow -lt $until) {
                if (-not $listener.Pending()) { Start-Sleep -Milliseconds 50; continue }
                $client = $listener.AcceptTcpClient()
                $reader = $null
                try {
                    $stream = $client.GetStream()
                    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
                    $requestLine = $reader.ReadLine()
                    if (-not $requestLine) { continue }
                    $parts = $requestLine.Split(' ')
                    $method = $parts[0]; $path = $parts[1]
                    while (($line = $reader.ReadLine()) -ne '') { }
                    if ($method -eq 'POST') { Add-Content $log $path; $body = '{}' } else { $body = $json }
                    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
                    $head = "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
                    $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
                    $stream.Write($headBytes, 0, $headBytes.Length)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                }
                finally { if ($reader) { $reader.Dispose() }; $client.Dispose() }
            }
        }
        finally { $listener.Stop() }
    }
    Start-Sleep -Seconds 2
    $wd = Run 'watchdog-automations.ps1' @{ ApiUrl = "http://127.0.0.1:$wdPort"; ProjectId = 'p'; MaxRunMinutes = 30; Workflow = 'factory-maintenance,factory-intake'; ExcludeRunId = 'r-self' }
    Stop-Job $wdJob -ErrorAction SilentlyContinue; Remove-Job $wdJob -Force -ErrorAction SilentlyContinue
    $wdCancelled = @(if (Test-Path $wdLog) { Get-Content $wdLog })
    Assert 'watchdog cancels only stale runs of the named workflows and spares the calling run' ($wd.Code -eq 0 -and $wdCancelled.Count -eq 1 -and $wdCancelled[0] -like '*r-old-maint*')

    # sync-issue-delivery: delivered issues close even though the PR merged into dev, not the default branch.
    $closeState = Join-Path $tmp 'close-state.json'
    $recent = [DateTime]::UtcNow.AddDays(-1).ToString('o'); $old = [DateTime]::UtcNow.AddDays(-60).ToString('o')
    @{
        prs = @(
            @{ number = 10; url = 'https://example/pull/10'; title = 'Feature'; mergedAt = $recent; body = "Closes #1, fixes #2`nIntentionally not closed: #3`nResolves #4 and Closes #5`n``````text`nCloses #6`n```````n<!-- Closes #7 -->`nCloses #8" }
            @{ number = 9; url = 'https://example/pull/9'; title = 'Old'; mergedAt = $old; body = 'Closes #9' }
        )
        issues = @{
            '1' = @{ state = 'OPEN'; labels = @('factory:review', 'type:feature'); comments = @() }
            '2' = @{ state = 'CLOSED'; labels = @(); comments = @() }
            '4' = @{ state = 'OPEN'; labels = @('factory:tracking', 'factory:working'); comments = @() }
            '5' = @{ state = 'OPEN'; labels = @('factory:ready'); comments = @('<!-- factory-closed-by-merge:5 -->') }
            '8' = @{ state = 'OPEN'; labels = @('factory:done'); comments = @() }
            '21' = @{ state = 'OPEN'; labels = @('factory:working', 'factory:interactive'); comments = @() }
            '22' = @{ state = 'OPEN'; labels = @('factory:review'); comments = @() }
            '23' = @{ state = 'OPEN'; labels = @('type:feature'); comments = @() }
            '24' = @{ state = 'OPEN'; labels = @('factory:tracking', 'factory:working'); comments = @() }
            '25' = @{ state = 'OPEN'; labels = @('factory:pr-open'); comments = @() }
            '26' = @{ state = 'OPEN'; labels = @('factory:working'); comments = @() }        }
        openPrs = @(
            @{ number = 20; url = 'https://example/pull/20'; title = 'Open'; isDraft = $false; body = 'Closes #21, closes #22, closes #23, closes #24, closes #25' }
            @{ number = 21; url = 'https://example/pull/21'; title = 'Draft'; isDraft = $true; body = 'Closes #26' }
        )
        failClose = @()
        calls = @()
    } | ConvertTo-Json -Depth 8 | Set-Content $closeState
    $env:FAKE_CLOSE_STATE = $closeState
    $closeOut = Join-Path $tmp 'close-output.json'
    $closeRun = Run 'sync-issue-delivery.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $closeOut }
    $closeAfter = Get-Content -Raw $closeState | ConvertFrom-Json -AsHashtable
    $closeResult = Get-Content -Raw $closeOut | ConvertFrom-Json
    Assert 'merged-to-dev PR closes its referenced open issues and sets factory:done' ($closeRun.Code -eq 0 -and $closeAfter.issues['1'].state -eq 'CLOSED' -and $closeAfter.issues['1'].labels -contains 'factory:done' -and $closeAfter.issues['1'].labels -notcontains 'factory:review' -and $closeAfter.issues['8'].state -eq 'CLOSED')
    Assert 'close step skips tracking epics, human-reopened issues, code/comment/non-closing references, and PRs past the lookback' ($closeAfter.issues['4'].state -eq 'OPEN' -and $closeAfter.issues['5'].state -eq 'OPEN' -and -not (@($closeAfter.calls) -match 'issue view (3|6|7|9) ') -and @($closeResult.closed.issue) -join ',' -eq '1,8')
    Assert 'open non-draft PR moves pre-PR issues to factory:pr-open and never overwrites review, tracking, or draft-PR issues' ($closeAfter.issues['21'].labels -contains 'factory:pr-open' -and $closeAfter.issues['21'].labels -notcontains 'factory:working' -and $closeAfter.issues['21'].labels -contains 'factory:interactive' -and $closeAfter.issues['23'].labels -contains 'factory:pr-open' -and $closeAfter.issues['22'].labels -contains 'factory:review' -and $closeAfter.issues['22'].labels -notcontains 'factory:pr-open' -and $closeAfter.issues['24'].labels -contains 'factory:working' -and $closeAfter.issues['26'].labels -contains 'factory:working' -and @($closeResult.promoted.issue) -join ',' -eq '21,23' -and $closeAfter.labelsEnsured -contains 'factory:pr-open')
    $closeRerun = Run 'sync-issue-delivery.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $closeOut }
    Assert 'close step is idempotent' ($closeRerun.Code -eq 0 -and @((Get-Content -Raw $closeOut | ConvertFrom-Json).closed).Count -eq 0)
    $closeAfter.prs = @(@{ number = 11; url = 'https://example/pull/11'; title = 'Two'; mergedAt = $recent; body = 'Closes #11 and closes #12' })
    $closeAfter.issues = @{ '11' = @{ state = 'OPEN'; labels = @('factory:review'); comments = @() }; '12' = @{ state = 'OPEN'; labels = @('factory:review'); comments = @() } }
    $closeAfter.openPrs = @(); $closeAfter.failClose = @(11); $closeAfter.calls = @()
    $closeAfter | ConvertTo-Json -Depth 8 | Set-Content $closeState
    $closeFail = Run 'sync-issue-delivery.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $closeOut }
    $closeFailResult = Get-Content -Raw $closeOut | ConvertFrom-Json
    Assert 'one failed close is reported without stopping the remaining issues' ($closeFail.Code -eq 0 -and $closeFailResult.status -eq 'partial' -and @($closeFailResult.errors).Count -eq 1 -and @($closeFailResult.closed.issue) -contains 12)
    # Fewer gh calls: closed issues cost no `issue view`, and labels are listed once instead of created every run.
    $callState = Get-Content -Raw $closeState | ConvertFrom-Json -AsHashtable
    $callState.prs = @(@{ number = 30; url = 'https://example/pull/30'; title = 'Calls'; mergedAt = $recent; body = 'Closes #31, closes #32' })
    $callState.openPrs = @(); $callState.failClose = @(); $callState.calls = @(); $callState.labelsEnsured = @()
    $callState.existingLabels = @('factory:pr-open', 'factory:done', 'factory:implemented', 'factory:interactive')
    $callState.issues = @{ '31' = @{ state = 'CLOSED'; labels = @(); comments = @() }; '32' = @{ state = 'OPEN'; labels = @(); comments = @() } }
    $callState | ConvertTo-Json -Depth 8 | Set-Content $closeState
    $callRun = Run 'sync-issue-delivery.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $closeOut }
    $callAfter = Get-Content -Raw $closeState | ConvertFrom-Json -AsHashtable
    Assert 'delivery sync reads no closed issue and creates no label that already exists' ($callRun.Code -eq 0 -and -not (@($callAfter.calls) -match 'issue view 31 ') -and (@($callAfter.calls) -match 'issue view 32 ').Count -eq 1 -and @($callAfter.labelsEnsured).Count -eq 0 -and $callAfter.issues['32'].state -eq 'CLOSED' -and $callAfter.issues['32'].labels -contains 'factory:done')

    # gh-cache: a fresh entry serves repeat reads, expiry and -Refresh refetch, and TTL 0 disables it.
    . (Join-Path $scripts 'gh-cache.ps1')
    $cacheDir = Join-Path $tmp 'gh-cache'; $env:FACTORY_GH_CACHE_DIR = $cacheDir
    $script:cacheFetches = 0; $fetch = { $script:cacheFetches++; "payload-$script:cacheFetches" }
    $env:FACTORY_GH_CACHE_TTL_SECONDS = '0'
    $off1 = Get-GhCachedText 'k' $fetch; $off2 = Get-GhCachedText 'k' $fetch
    Assert 'gh cache is disabled by TTL 0 and writes nothing' ($off1 -eq 'payload-1' -and $off2 -eq 'payload-2' -and -not (Test-Path $cacheDir))
    $env:FACTORY_GH_CACHE_TTL_SECONDS = '60'; $script:cacheFetches = 0
    $hit1 = Get-GhCachedText 'k' $fetch; $hit2 = Get-GhCachedText 'k' $fetch; $other = Get-GhCachedText 'other' $fetch
    Assert 'gh cache serves a fresh entry per key without refetching' ($hit1 -eq 'payload-1' -and $hit2 -eq 'payload-1' -and $other -eq 'payload-2' -and $script:cacheFetches -eq 2)
    $refreshed = Get-GhCachedText 'k' $fetch -Refresh; $afterRefresh = Get-GhCachedText 'k' $fetch
    Assert 'gh cache -Refresh refetches and stores the new answer' ($refreshed -eq 'payload-3' -and $afterRefresh -eq 'payload-3')
    (Get-ChildItem $cacheDir -Filter '*.json' | Select-Object -First 1).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-10)
    (Get-ChildItem $cacheDir -Filter '*.json' | Select-Object -Last 1).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-10)
    $expired = Get-GhCachedText 'k' $fetch
    Assert 'gh cache refetches an expired entry' ($expired -eq 'payload-4')
    Clear-GhCache
    Assert 'Clear-GhCache drops every entry' (@(Get-ChildItem $cacheDir -Filter '*.json' -ErrorAction SilentlyContinue).Count -eq 0)
    Remove-Item Env:FACTORY_GH_CACHE_DIR; $env:FACTORY_GH_CACHE_TTL_SECONDS = '0'

    # The stale refresher rotates: the least recently touched workable issue goes first, whatever its
    # creation date, so the same two old issues are not re-triggered forever while the rest starve.
    @{ prs = @(); openPrs = @(); issues = @{
            '1' = @{ state = 'OPEN'; labels = @('factory:ready', 'complexity:small'); comments = @(); createdAt = '2026-01-01T00:00:00Z'; updatedAt = '2026-03-03T00:00:00Z' }
            '2' = @{ state = 'OPEN'; labels = @('factory:ready', 'complexity:small'); comments = @(); createdAt = '2026-01-02T00:00:00Z'; updatedAt = '2026-03-01T00:00:00Z' }
            '3' = @{ state = 'OPEN'; labels = @('factory:needs-plan'); comments = @(); createdAt = '2026-01-03T00:00:00Z'; updatedAt = '2026-03-02T00:00:00Z' }
            '4' = @{ state = 'OPEN'; labels = @('factory:ready', 'complexity:small'); comments = @(); createdAt = '2026-01-04T00:00:00Z'; updatedAt = [DateTimeOffset]::UtcNow.ToString('o') }
            '5' = @{ state = 'OPEN'; labels = @('factory:blocked'); comments = @(); createdAt = '2026-01-01T00:00:00Z'; updatedAt = '2026-02-01T00:00:00Z' }
        } } | ConvertTo-Json -Depth 8 | Set-Content $closeState
    $refreshOut = Join-Path $tmp 'stale-refresh.json'
    $refreshRun = Run 'refresh-stale-workable.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $refreshOut }
    if ($refreshRun.Code -ne 0) { Write-Host $refreshRun.Out }
    $refresh = Get-Content -Raw $refreshOut | ConvertFrom-Json
    Assert 'stale refresher takes the least recently touched workable issues first, not the oldest by creation' ($refreshRun.Code -eq 0 -and (@($refresh.refreshed | ForEach-Object { $_.issue }) -join ',') -eq '2,3')
    Assert 'stale refresher leaves a recently touched issue and a human-owned state alone' ($refresh.eligible -eq 3 -and @($refresh.excluded | Where-Object { $_.issue -eq 5 -and $_.reason -eq 'manual-or-terminal-state' }).Count -eq 1)

    # A housekeeping run must leave no commit. The run branch is created when the run starts, so anything
    # after the branch's first reflog entry was committed by the run.
    $runRepo = Join-Path $tmp 'run-commits'
    New-Item -ItemType Directory -Force -Path $runRepo | Out-Null
    & git -C $runRepo init -q -b stable 2>&1 | Out-Null
    & git -C $runRepo config user.name 'Factory Test'; & git -C $runRepo config user.email 'factory-test@example.invalid'
    'base' | Set-Content (Join-Path $runRepo 'tracked.txt'); & git -C $runRepo add tracked.txt; & git -C $runRepo commit -q -m 'base' 2>&1 | Out-Null
    & git -C $runRepo switch -q -c 'cez/run-under-test' 2>&1 | Out-Null
    $runCommitsOut = Join-Path $tmp 'run-commits.json'
    $cleanRun = Run 'assert-no-run-commits.ps1' @{ OutputPath = $runCommitsOut; RepositoryPath = $runRepo }
    Assert 'a housekeeping run that made no commit passes' ($cleanRun.Code -eq 0 -and (Get-Content -Raw $runCommitsOut | ConvertFrom-Json).status -eq 'clean')
    'scratch' | Set-Content (Join-Path $runRepo 'audit.json'); & git -C $runRepo add audit.json; & git -C $runRepo commit -q -m 'factory: backlog label audit - no candidates to process' 2>&1 | Out-Null
    $dirtyRun = Run 'assert-no-run-commits.ps1' @{ OutputPath = $runCommitsOut; RepositoryPath = $runRepo }
    $dirtyResult = Get-Content -Raw $runCommitsOut | ConvertFrom-Json
    Assert 'a housekeeping run that committed fails and names the commit' ($dirtyRun.Code -ne 0 -and $dirtyResult.status -eq 'commits-found' -and @($dirtyResult.commits).Count -eq 1 -and $dirtyResult.commits[0] -match 'backlog label audit' -and $dirtyRun.Out -match 'must not commit')
    & git -C $runRepo switch -q --detach 2>&1 | Out-Null
    $detachedRun = Run 'assert-no-run-commits.ps1' @{ OutputPath = $runCommitsOut; RepositoryPath = $runRepo }
    Assert 'a checkout with no branch is reported as unknown, not guessed at' ($detachedRun.Code -eq 0 -and (Get-Content -Raw $runCommitsOut | ConvertFrom-Json).status -eq 'unknown')

    # Lifecycle sweep: every open issue is in one state, with an owner, inside its deadline. What is
    # mechanical is repaired with evidence; the rest goes into one rolling report issue.
    $fresh = [DateTimeOffset]::UtcNow.AddHours(-1).ToString('o'); $longAgo = '2026-01-01T00:00:00Z'
    @{ prs = @(); issues = @{
            '1'  = @{ state = 'OPEN'; labels = @('type:bug'); comments = @(); title = 'no state at all'; updatedAt = $fresh }
            '2'  = @{ state = 'OPEN'; labels = @('factory:ready'); comments = @(); title = 'ready without complexity'; updatedAt = $fresh }
            '3'  = @{ state = 'OPEN'; labels = @('factory:blocked'); comments = @(); title = 'blockers closed'; body = 'Blocked by #90 and #91.'; updatedAt = $fresh }
            '4'  = @{ state = 'OPEN'; labels = @('factory:blocked'); comments = @(); title = 'blocker still open'; body = 'Depends on #6'; updatedAt = $fresh }
            '5'  = @{ state = 'OPEN'; labels = @('factory:blocked'); comments = @(); title = 'names no blocker'; body = 'waiting'; updatedAt = $longAgo }
            '6'  = @{ state = 'OPEN'; labels = @('factory:ready', 'complexity:small', 'factory:review'); comments = @(); title = 'two states'; updatedAt = $fresh }
            '7'  = @{ state = 'OPEN'; labels = @('factory:needs-help'); comments = @(); title = 'waiting on a person too long'; updatedAt = $longAgo }
            '8'  = @{ state = 'OPEN'; labels = @('factory:review'); comments = @(); title = 'PR conflicts'; updatedAt = $fresh }
            '9'  = @{ state = 'OPEN'; labels = @('factory:tracking'); comments = @(); title = 'epic'; updatedAt = $longAgo }
            '10' = @{ state = 'OPEN'; labels = @('factory:ready', 'complexity:small'); comments = @(); title = 'healthy'; updatedAt = $fresh }
            '11' = @{ state = 'OPEN'; labels = @('factory:ready', 'complexity:large'); comments = @(); title = 'never consumed'; updatedAt = $longAgo }
            '12' = @{ state = 'OPEN'; labels = @('factory:blocked', 'factory:interactive'); comments = @(); title = 'a person owns it'; body = 'Blocked by #90'; updatedAt = $fresh }
        }
        openPrs = @(
            @{ number = 50; title = 'Fix'; body = 'Closes #8'; url = 'https://example/pull/50'; isDraft = $false; mergeable = 'CONFLICTING' },
            @{ number = 51; title = 'Draft work'; body = 'Closes #10'; url = 'https://example/pull/51'; isDraft = $true; mergeable = 'MERGEABLE' },
            @{ number = 52; title = 'No issue named'; body = 'tidy up'; url = 'https://example/pull/52'; isDraft = $false; mergeable = 'MERGEABLE' }
        ) } | ConvertTo-Json -Depth 8 | Set-Content $closeState
    $sweepOut = Join-Path $tmp 'lifecycle-sweep.json'
    $sweepRun = Run 'sweep-lifecycle.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $sweepOut }
    if ($sweepRun.Code -ne 0) { Write-Host $sweepRun.Out }
    $sweep = Get-Content -Raw $sweepOut | ConvertFrom-Json
    $sweepState = Get-Content -Raw $closeState | ConvertFrom-Json -AsHashtable
    $repairKinds = @{}; foreach ($repair in @($sweep.repairs)) { $repairKinds[[string]$repair.issue] = "$($repair.kind)>$($repair.added)" }
    $violationKinds = @{}; foreach ($violation in @($sweep.violations)) { $violationKinds[[string]$violation.issue] = [string]$violation.kind }
    Assert 'lifecycle sweep gives an issue with no state the initial state' ($sweepRun.Code -eq 0 -and $repairKinds['1'] -eq 'no-state>factory:new' -and $sweepState.issues['1'].labels -contains 'factory:new')
    Assert 'lifecycle sweep sends a ready issue with no complexity label back to planning' ($repairKinds['2'] -eq 'guard>factory:needs-plan' -and $sweepState.issues['2'].labels -contains 'factory:needs-plan' -and $sweepState.issues['2'].labels -notcontains 'factory:ready')
    Assert 'lifecycle sweep unblocks an issue whose named blockers are all closed, with evidence, into a state it can stay in' ($repairKinds['3'] -eq 'unblocked>factory:needs-plan' -and $sweepState.issues['3'].labels -notcontains 'factory:blocked' -and @($sweepState.issues['3'].comments | Where-Object { $_ -match '#90, #91' }).Count -eq 1)
    Assert 'lifecycle sweep leaves an issue blocked while a named blocker is open' (-not $repairKinds.ContainsKey('4') -and -not $violationKinds.ContainsKey('4') -and $sweepState.issues['4'].labels -contains 'factory:blocked')
    Assert 'lifecycle sweep routes an issue in review whose pull request conflicts to the fix automation' ($repairKinds['8'] -eq 'pr-conflict>factory:changes-requested' -and $sweepState.issues['8'].labels -contains 'factory:changes-requested')
    Assert 'lifecycle sweep reports what it must not guess: two states, no stated blocker, overdue human and automated work, draft and unlinked pull requests' ($violationKinds['6'] -eq 'multiple-states' -and $violationKinds['5'] -eq 'blocked-without-blocker' -and $violationKinds['7'] -eq 'overdue' -and $violationKinds['11'] -eq 'overdue' -and $violationKinds['51'] -eq 'draft-pr' -and $violationKinds['52'] -eq 'pr-without-issue')
    Assert 'lifecycle sweep reports, and does not change, an issue a person owns in a dev window' (-not $repairKinds.ContainsKey('12') -and $violationKinds['12'] -eq 'unblocked' -and $sweepState.issues['12'].labels -contains 'factory:blocked')
    Assert 'lifecycle sweep leaves healthy work and tracking epics alone' (-not $repairKinds.ContainsKey('10') -and -not $violationKinds.ContainsKey('10') -and -not $violationKinds.ContainsKey('9') -and $sweepState.issues['10'].labels.Count -eq 2)
    $reportIssue = @($sweepState.issues.Keys | Where-Object { $sweepState.issues[$_]['title'] -eq 'Factory stall report' })
    Assert 'lifecycle sweep writes one rolling stall report as a tracking issue' ($sweep.report.action -eq 'created' -and $reportIssue.Count -eq 1 -and $sweepState.issues[$reportIssue[0]].labels -contains 'factory:tracking' -and $sweepState.issues[$reportIssue[0]]['body'] -match '#7 \*\*overdue\*\*')
    # The second run sees the repaired labels: nothing is left to repair, and an issue the first run handed
    # to the fix automation is not reported as unowned. The third run changes nothing at all.
    $sweepAgain = Run 'sweep-lifecycle.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $sweepOut }
    $sweepSecond = Get-Content -Raw $sweepOut | ConvertFrom-Json
    Assert 'lifecycle sweep leaves nothing to repair after one pass and does not report work it handed to an automation' ($sweepAgain.Code -eq 0 -and @($sweepSecond.repairs).Count -eq 0 -and @($sweepSecond.violations | Where-Object { $_.issue -in 2, 3, 8 }).Count -eq 0)
    $sweepThird = Run 'sweep-lifecycle.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $sweepOut }
    $sweepThirdResult = Get-Content -Raw $sweepOut | ConvertFrom-Json
    $sweepStateAgain = Get-Content -Raw $closeState | ConvertFrom-Json -AsHashtable
    Assert 'lifecycle sweep is idempotent: the report is not rewritten or duplicated when nothing changed' ($sweepThird.Code -eq 0 -and @($sweepThirdResult.repairs).Count -eq 0 -and $sweepThirdResult.report.action -eq 'unchanged' -and @($sweepStateAgain.issues.Keys | Where-Object { $sweepStateAgain.issues[$_]['title'] -eq 'Factory stall report' }).Count -eq 1)
    $sweepScript = Get-Content -Raw (Join-Path $scripts 'sweep-lifecycle.ps1')
    Assert 'lifecycle sweep rotates which blocked issues it reads, so one that cannot be unblocked does not starve the rest' ($sweepScript -match 'ToUnixTimeSeconds\(\) / 3600\) % \$blockerCandidates\.Count' -and $sweepScript -notmatch 'blockerBudget')
    $dryState = Get-Content -Raw $closeState
    $sweepDry = Run 'sweep-lifecycle.ps1' @{ GhCommand = (Join-Path $PSScriptRoot 'fake-delivery-gh.ps1'); OutputPath = $sweepOut; DryRun = $true; RepairLimit = 0 }
    Assert 'lifecycle sweep dry run changes no label and writes no comment' ($sweepDry.Code -eq 0 -and ((Get-Content -Raw $closeState | ConvertFrom-Json -AsHashtable).issues | ConvertTo-Json -Depth 8) -eq (($dryState | ConvertFrom-Json -AsHashtable).issues | ConvertTo-Json -Depth 8))
    Remove-Item Env:FAKE_CLOSE_STATE

    $backlogFeatureProject = Join-Path $tmp 'backlog-feature-project'
    Copy-Item (Join-Path $PSScriptRoot 'fixtures/generic-project') $backlogFeatureProject -Recurse
    $backlogFeatureConfig = Join-Path $backlogFeatureProject '.ai/factory/factory.config.yaml'
    $backlogFeatureText = [IO.File]::ReadAllText($backlogFeatureConfig)
    $backlogFeatureText = [regex]::Replace($backlogFeatureText, '(?m)^(\s*version:\s*)"\d+\.\d+\.\d+"', "`${1}`"$curVer`"")
    $backlogFeatureText = $backlogFeatureText -replace '(?m)^(\s*maintenance:\s*)false\s*$', "`${1}false`n  backlog_reconciliation: true"
    [IO.File]::WriteAllText($backlogFeatureConfig, $backlogFeatureText, [Text.UTF8Encoding]::new($false))
    $backlogFeatureInstall = Run 'install.ps1' @{ ProjectPath = $backlogFeatureProject; FactoryPath = $factory }
    Assert 'backlog_reconciliation feature installs the health workflow, work-backlog skill, and automation together' ($backlogFeatureInstall.Code -eq 0 -and (Test-Path (Join-Path $backlogFeatureProject '.ai/cezar/workflows/factory-health.yaml')) -and (Test-Path (Join-Path $backlogFeatureProject '.ai/skills/factory-work-backlog/SKILL.md')) -and (Test-Path (Join-Path $backlogFeatureProject '.ai/factory/automations/health.json')))

    $env:FAKE_BACKLOG_ISSUES = Join-Path $PSScriptRoot 'fixtures/backlog-issues.json'
    $backlogInput = Join-Path $tmp 'github-issues.json'
    $backlogOutput = Join-Path $tmp 'backlog-reconciliation.json'
    $fakeBacklogGh = Join-Path $PSScriptRoot 'fake-backlog-gh.ps1'
    $collectBacklog = Run 'collect-backlog-snapshot.ps1' @{ GhCommand = $fakeBacklogGh; Repo = 'fixture/repo'; OutputPath = $backlogInput }
    Assert 'backlog collector writes compact open issue snapshot' ($collectBacklog.Code -eq 0 -and (Test-Path $backlogInput))
    # The snapshot must not pull every closed issue's body and comments: that made it large enough for gh to return it truncated.
    $env:FAKE_BACKLOG_ARGS_LOG = Join-Path $tmp 'backlog-gh-args.txt'; Remove-Item $env:FAKE_BACKLOG_ARGS_LOG -ErrorAction SilentlyContinue
    $null = Run 'collect-backlog-snapshot.ps1' @{ GhCommand = $fakeBacklogGh; Repo = 'fixture/repo'; OutputPath = (Join-Path $tmp 'backlog-args-snapshot.json') }
    $ghCalls = @(Get-Content $env:FAKE_BACKLOG_ARGS_LOG)
    Remove-Item Env:FAKE_BACKLOG_ARGS_LOG -ErrorAction SilentlyContinue
    $closedCall = @($ghCalls | Where-Object { $_ -match '--state closed' })
    Assert 'backlog collector reads closed issues by number and state only, never their bodies or comments' ($ghCalls.Count -eq 2 -and $closedCall.Count -eq 1 -and $closedCall[0] -match '--json number,state( |$)' -and -not @($ghCalls | Where-Object { $_ -match '--state all' }))
    if (Test-Path $backlogInput) {
        $collected = Get-Content -Raw $backlogInput | ConvertFrom-Json
        $blockedByDependency = @($collected.issues | Where-Object { $_.number -eq 3 })[0]
        $releasedLease = @($collected.issues | Where-Object { $_.number -eq 4 })[0]
        Assert 'backlog collector treats open dependencies as not ready' (-not $blockedByDependency.dependenciesReady)
        Assert 'backlog collector preserves released lease marker' ($releasedLease.lease.releasedAt -and $releasedLease.dependenciesReady)
        $malformedLeases = @(Get-Content -Raw (Join-Path $PSScriptRoot 'fixtures/backlog-issues.json') | ConvertFrom-Json)
        (@($malformedLeases | Where-Object { $_.number -eq 4 })[0]).comments[0].body = '<!-- factory-lease:4 -->`nnot-json'
        $malformedPath = Join-Path $tmp 'backlog-malformed-lease.json'
        $malformedLeases | ConvertTo-Json -Depth 8 | Set-Content $malformedPath
        $env:FAKE_BACKLOG_ISSUES = $malformedPath
        $malformedOutput = Join-Path $tmp 'malformed-backlog-snapshot.json'
        $malformedRun = Run 'collect-backlog-snapshot.ps1' @{ GhCommand = $fakeBacklogGh; Repo = 'fixture/repo'; OutputPath = $malformedOutput }
        Assert 'backlog collector rejects malformed lease markers' ($malformedRun.Code -ne 0 -and -not (Test-Path $malformedOutput))
        $atCap = @(); for ($i = 1; $i -le 1000; $i++) { $atCap += @{ number = $i; state = 'OPEN'; labels = @(); createdAt = '2026-01-01T00:00:00Z'; body = ''; comments = @() } }
        $atCapPath = Join-Path $tmp 'backlog-at-cap.json'
        $atCap | ConvertTo-Json -Depth 4 | Set-Content $atCapPath
        $env:FAKE_BACKLOG_ISSUES = $atCapPath
        $atCapOutput = Join-Path $tmp 'at-cap-backlog-snapshot.json'
        $atCapRun = Run 'collect-backlog-snapshot.ps1' @{ GhCommand = $fakeBacklogGh; Repo = 'fixture/repo'; OutputPath = $atCapOutput }
        Assert 'backlog collector rejects potentially truncated GitHub snapshots' ($atCapRun.Code -ne 0 -and -not (Test-Path $atCapOutput))
        # One or two truncated GitHub responses are retried; a persistent failure still fails the collector.
        $env:FAKE_BACKLOG_ISSUES = Join-Path $PSScriptRoot 'fixtures/backlog-issues.json'
        $env:FAKE_BACKLOG_COUNTER = Join-Path $tmp 'backlog-gh-calls.txt'; Remove-Item $env:FAKE_BACKLOG_COUNTER -ErrorAction SilentlyContinue
        $env:FAKE_BACKLOG_FAIL_FIRST = '2'
        $retryOutput = Join-Path $tmp 'retry-backlog-snapshot.json'
        $retryRun = Run 'collect-backlog-snapshot.ps1' @{ GhCommand = $fakeBacklogGh; Repo = 'fixture/repo'; OutputPath = $retryOutput; RetryDelaySeconds = 0 }
        Assert 'backlog collector retries a transient gh failure instead of failing the canary' ($retryRun.Code -eq 0 -and (Test-Path $retryOutput) -and [int](Get-Content -Raw $env:FAKE_BACKLOG_COUNTER) -eq 4)  # open listing: 2 failures + 1 success, then the closed listing
        Remove-Item $env:FAKE_BACKLOG_COUNTER -ErrorAction SilentlyContinue; $env:FAKE_BACKLOG_FAIL_FIRST = '9'
        $stuckOutput = Join-Path $tmp 'stuck-backlog-snapshot.json'
        $stuckRun = Run 'collect-backlog-snapshot.ps1' @{ GhCommand = $fakeBacklogGh; Repo = 'fixture/repo'; OutputPath = $stuckOutput; RetryDelaySeconds = 0 }
        Assert 'backlog collector still fails after its bounded attempts' ($stuckRun.Code -ne 0 -and -not (Test-Path $stuckOutput) -and [int](Get-Content -Raw $env:FAKE_BACKLOG_COUNTER) -eq 3)
        Remove-Item Env:FAKE_BACKLOG_FAIL_FIRST, Env:FAKE_BACKLOG_COUNTER -ErrorAction SilentlyContinue
        $env:FAKE_BACKLOG_ISSUES = Join-Path $PSScriptRoot 'fixtures/backlog-issues.json'
        $reconciled = Run 'reconcile-backlog.ps1' @{ InputPath = $backlogInput; OutputPath = $backlogOutput; BatchCap = 10; ProjectConcurrencyCap = 10; DryRun = $true }
        Assert 'backlog reconciler ignores released leases and excludes active leases' ($reconciled.Code -eq 0 -and (Test-Path $backlogOutput))
        if (Test-Path $backlogOutput) {
            $proposal = Get-Content -Raw $backlogOutput | ConvertFrom-Json
            Assert 'backlog proposal orders ready work and reports lease exclusion' (@($proposal.actions).Count -eq 2 -and $proposal.actions[0].issue -eq 4 -and @($proposal.excludedIssues | Where-Object { $_.issue -eq 3 -and $_.reason -eq 'active-lease' }).Count -eq 1)
        }
    }
    foreach ($fx in Get-ChildItem (Join-Path $PSScriptRoot 'fixtures') -Directory) {
        Write-Host "== fixture $($fx.Name) =="
        $proj = Join-Path $tmp $fx.Name
        Copy-Item $fx.FullName $proj -Recurse
        # Fixtures retain realistic project-owned pins, but each test run must
        # install the Factory version under test rather than a historic pin.
        $fixtureConfig = Join-Path $proj '.ai/factory/factory.config.yaml'
        $fixtureText = [IO.File]::ReadAllText($fixtureConfig)
        $fixtureText = [regex]::Replace($fixtureText, '(?m)^(\s*version:\s*)"\d+\.\d+\.\d+"', "`${1}`"$curVer`"")
        [IO.File]::WriteAllText($fixtureConfig, $fixtureText, [Text.UTF8Encoding]::new($false))
        $fdir = Join-Path $proj '.ai/factory'
        $a = @{ ProjectPath = $proj; FactoryPath = $factory }

        $r = Run 'install.ps1' (With $a @{ DryRun = $true })
        Assert 'install dry-run succeeds' ($r.Code -eq 0)
        Assert 'install dry-run writes nothing' (-not (Test-Path (Join-Path $fdir 'manifest.json')))

        $r = Run 'install.ps1' $a
        Assert 'install succeeds' ($r.Code -eq 0)
        Assert 'managed marker on skill' ((Get-Content -Raw (Join-Path $proj '.ai/skills/factory-plan/SKILL.md')) -match 'managed-by: cezar-factory')
        Assert 'managed marker on workflow' ((Get-Content -Raw (Join-Path $proj '.ai/cezar/workflows/factory-plan.yaml')) -match 'GENERATED BY CEZAR-FACTORY')
        Assert 'maintenance workflow not installed' (-not (Test-Path (Join-Path $proj '.ai/cezar/workflows/factory-maintenance.yaml')))
        Assert 'maintenance automation not installed' (-not (Test-Path (Join-Path $fdir 'automations/maintenance.json')))
        Assert 'combined maintenance automation not installed' (-not (Test-Path (Join-Path $fdir 'automations/maintenance.json')))
        Assert 'health is opt-in' (-not (Test-Path (Join-Path $proj '.ai/cezar/workflows/factory-health.yaml')) -and -not (Test-Path (Join-Path $fdir 'automations/health.json')))
        Assert 'verify passes' ((Run 'verify.ps1' $a).Code -eq 0)
        Assert 'diff clean' ((Run 'diff.ps1' $a).Code -eq 0)
        Assert 'reinstall idempotent' ((Run 'install.ps1' $a).Code -eq 0)

        # Drift detection
        $target = Join-Path $proj '.ai/skills/factory-plan/SKILL.md'
        $orig = [IO.File]::ReadAllText($target)
        Add-Content $target 'local edit'
        Assert 'diff detects modified file' ((Run 'diff.ps1' $a).Code -ne 0)
        Assert 'update refuses modified managed file' ((Run 'update.ps1' $a).Code -ne 0)
        Assert 'force update recovers modified managed file' ((Run 'force-update.ps1' $a).Code -eq 0)
        Assert 'force update creates recovery backup' (Test-Path (Join-Path $proj '.factory/factory-force-backups'))
        Assert 'force update restores clean managed layer' ((Run 'diff.ps1' $a).Code -eq 0)
        [IO.File]::WriteAllText($target, $orig)
        Remove-Item (Join-Path $fdir 'policies/escalation.md')
        Assert 'diff detects missing file' ((Run 'diff.ps1' $a).Code -ne 0)
        Assert 'update restores missing file' ((Run 'update.ps1' $a).Code -eq 0)
        Write-Utf8 (Join-Path $proj '.ai/skills/factory-stray/SKILL.md') "# stray`n"
        Assert 'diff detects unmanaged file' ((Run 'diff.ps1' $a).Code -ne 0)
        Remove-Item (Join-Path $proj '.ai/skills/factory-stray') -Recurse
        Assert 'diff clean after cleanup' ((Run 'diff.ps1' $a).Code -eq 0)

        # Override validity
        Write-Utf8 (Join-Path $fdir 'overrides/workflows/nonexistent.yaml') "name: x`n"
        Assert 'verify rejects override of unknown component' ((Run 'verify.ps1' $a).Code -ne 0)
        Remove-Item (Join-Path $fdir 'overrides') -Recurse

        # Upgrade to a synthetic 9.9.9: change a policy, add a policy, drop another (obsolete).
        $f2 = Join-Path $tmp "factory-9.9.9-$($fx.Name)"
        Copy-Factory $factory $f2
        Assert 'fixture factory copy excludes environment files' (@(Get-ChildItem -LiteralPath $f2 -File -Force -Recurse | Where-Object { $_.Name -match '^\.env(?:\..+)?$' }).Count -eq 0)
        Set-Content (Join-Path $f2 'VERSION') '9.9.9'
        Add-Content (Join-Path $f2 'skills/factory-review/SKILL.md') "`nUpgrade note."
        Write-Utf8 (Join-Path $f2 'policies/new-policy.md') "# New policy`n"
        Remove-Item (Join-Path $f2 'policies/risk.yaml')
        $cfgPath = Join-Path $fdir 'factory.config.yaml'
        $cfgText = Get-Content -Raw $cfgPath
        $a2 = @{ ProjectPath = $proj; FactoryPath = $f2 }
        Assert 'update refuses without pin change' ((Run 'update.ps1' $a2).Code -ne 0)
        Set-Content $cfgPath ($cfgText -replace '(?m)^(\s*version:\s*)"[0-9.]+"', '${1}"9.9.9"') -NoNewline
        $r = Run 'update.ps1' (With $a2 @{ DryRun = $true })
        Assert 'update dry-run succeeds' ($r.Code -eq 0)
        Assert 'update dry-run changes nothing' (Test-Path (Join-Path $fdir 'policies/risk.yaml'))
        $r = Run 'update.ps1' $a2
        Assert 'update to 9.9.9 succeeds' ($r.Code -eq 0)
        Assert 'summary shows version transition' ($r.Out -match "$([regex]::Escape($curVer)) -> 9\.9\.9")
        Assert 'new managed file added' (Test-Path (Join-Path $fdir 'policies/new-policy.md'))
        Assert 'obsolete managed file removed' (-not (Test-Path (Join-Path $fdir 'policies/risk.yaml')))
        Assert 'changed skill updated' ((Get-Content -Raw (Join-Path $proj '.ai/skills/factory-review/SKILL.md')) -match 'Upgrade note')
        Assert 'project skill preserved' (Test-Path (Join-Path $proj '.ai/skills/project-testing/SKILL.md'))
        Assert 'project config preserved' ((Get-Content -Raw $cfgPath) -match 'type: ')
        Assert 'verify passes at 9.9.9' ((Run 'verify.ps1' $a2).Code -eq 0)

        # Rollback: restore pin, run against the old factory.
        Set-Content $cfgPath $cfgText -NoNewline
        $r = Run 'update.ps1' $a
        Assert 'rollback to pinned version succeeds' ($r.Code -eq 0)
        Assert 'rollback restores removed file' (Test-Path (Join-Path $fdir 'policies/risk.yaml'))
        Assert 'rollback removes upgrade-only file' (-not (Test-Path (Join-Path $fdir 'policies/new-policy.md')))
        Assert 'diff clean after rollback' ((Run 'diff.ps1' $a).Code -eq 0)

        # Ambiguity: unmanaged file already sits at a managed path.
        Remove-Item (Join-Path $fdir 'manifest.json')
        Add-Content (Join-Path $fdir 'policies/labels.yaml') '# hand edit'
        Assert 'install refuses ambiguous ownership' ((Run 'install.ps1' $a).Code -ne 0)
    }

    # ---- Runtime scripts, run from an installed project -------------------
    Write-Host '== runtime scripts =='
    $rp = Join-Path $tmp 'runtime-project'
    Copy-Item (Join-Path $PSScriptRoot 'fixtures/generic-project') $rp -Recurse
    $runtimeConfig = Join-Path $rp '.ai/factory/factory.config.yaml'
    $runtimeConfigText = [IO.File]::ReadAllText($runtimeConfig)
    $runtimeConfigText = [regex]::Replace($runtimeConfigText, '(?m)^(\s*version:\s*)"\d+\.\d+\.\d+"', "`${1}`"$curVer`"")
    [IO.File]::WriteAllText($runtimeConfig, $runtimeConfigText, [Text.UTF8Encoding]::new($false))
    # The shipped scripts declare a PowerShell 7 shebang; invoke the runtime
    # scenario through pwsh even when the test harness itself is launched by
    # Windows PowerShell 5.1.
    & pwsh -NoProfile -File (Join-Path $scripts 'install.ps1') -ProjectPath $rp -FactoryPath $factory *>&1 | Out-Null
    $val = Join-Path $rp '.ai/factory/scripts/validate-result.ps1'
    $route = Join-Path $rp '.ai/factory/scripts/route-state.ps1'
    $localJob = Join-Path $rp '.ai/factory/scripts/local/run-local-job.ps1'
    Assert 'local utility runner installed' (Test-Path $localJob)
    Assert 'OpenHands job validator installed' (Test-Path (Join-Path $rp '.ai/factory/scripts/openhands/validate-job.ps1'))
    Assert 'Hindsight recall boundary installed' (Test-Path (Join-Path $rp '.ai/factory/scripts/hindsight/recall.ps1'))
    Assert 'backlog reconciler installed' (Test-Path (Join-Path $rp '.ai/factory/scripts/reconcile-backlog.ps1'))
    Assert 'backlog snapshot collector installed' (Test-Path (Join-Path $rp '.ai/factory/scripts/collect-backlog-snapshot.ps1'))
    Assert 'local evaluation scripts installed' ((Test-Path (Join-Path $rp '.ai/factory/scripts/record-local-evaluation.ps1')) -and (Test-Path (Join-Path $rp '.ai/factory/scripts/evaluate-local-promotion.ps1')))
    $missingInput = Run 'local/run-local-job.ps1' @{ Job = 'summarize-issue'; InputPath = (Join-Path $tmp 'does-not-exist.txt') }
    Assert 'local utility runner rejects missing input' ($missingInput.Code -ne 0)
    $smallLimit = Run 'local/run-local-job.ps1' @{ Job = 'summarize-issue'; InputPath = (Join-Path $rp 'README.md'); MaxChars = 99 }
    Assert 'local utility runner rejects unbounded limit' ($smallLimit.Code -ne 0)
    $reconcileInput = Join-Path $tmp 'reconcile-input.json'; $reconcileOutput = Join-Path $tmp 'reconcile-output.json'
    @{ issues = @(
        @{ number=9; labels=@('factory:ready'); priority=1; dependenciesReady=$true; createdAt='2026-01-03T00:00:00Z'; blocked=$false; openHumanGate=$false },
        @{ number=8; labels=@('factory:needs-plan'); priority=2; dependenciesReady=$true; createdAt='2026-01-02T00:00:00Z'; blocked=$false; openHumanGate=$false },
        @{ number=7; labels=@('factory:ready','factory:needs-plan'); priority=9; dependenciesReady=$true; createdAt='2026-01-01T00:00:00Z'; blocked=$false; openHumanGate=$false },
        @{ number=6; labels=@('factory:ready'); priority=9; dependenciesReady=$true; createdAt='2026-01-01T00:00:00Z'; blocked=$true; openHumanGate=$false },
        @{ number=5; labels=@('factory:ready'); priority=9; dependenciesReady=$true; createdAt='2026-01-01T00:00:00Z'; blocked=$false; openHumanGate=$true },
        @{ number=4; labels=@('factory:ready'); priority=9; dependenciesReady=$true; createdAt='2026-01-01T00:00:00Z'; blocked=$false; openHumanGate=$false; lease=@{ owner='other'; expiresAt='2099-01-01T00:00:00Z' } },
        @{ number=3; labels=@('factory:ready'); priority=3; dependenciesReady=$true; createdAt='2026-01-01T00:00:00Z'; blocked=$false; openHumanGate=$false; lease=@{ owner='old'; expiresAt='2000-01-01T00:00:00Z' } }
    ) } | ConvertTo-Json -Depth 6 | Set-Content $reconcileInput
    & pwsh -NoProfile -File (Join-Path $rp '.ai/factory/scripts/reconcile-backlog.ps1') -InputPath $reconcileInput -OutputPath $reconcileOutput -BatchCap 2 -ProjectConcurrencyCap 2 -DryRun *>&1 | Out-Null
    $reconciled = Get-Content -Raw $reconcileOutput | ConvertFrom-Json
    Assert 'reconciler: ordering and caps are deterministic' ($LASTEXITCODE -eq 0 -and @($reconciled.actions).Count -eq 2 -and $reconciled.actions[0].issue -eq 3 -and $reconciled.actions[1].issue -eq 8)
    Assert 'reconciler: invalid, blocked, gated, and claimed work excluded' (@($reconciled.invalidIssues).Count -eq 1 -and @($reconciled.excludedIssues).Count -eq 3)
    @{ issues = @(@{ number=1; labels=@('factory:working'); priority=0; dependenciesReady=$true; createdAt='2026-01-01T00:00:00Z'; blocked=$false; openHumanGate=$false }) } | ConvertTo-Json -Depth 4 | Set-Content $reconcileInput
    & pwsh -NoProfile -File (Join-Path $rp '.ai/factory/scripts/reconcile-backlog.ps1') -InputPath $reconcileInput -OutputPath $reconcileOutput -DryRun *>&1 | Out-Null
    $noCandidates = Get-Content -Raw $reconcileOutput | ConvertFrom-Json
    Assert 'reconciler: no candidate terminates cleanly' ($LASTEXITCODE -eq 0 -and $noCandidates.terminalReason -eq 'no-candidates' -and @($noCandidates.actions).Count -eq 0)
    $gh = Join-Path $PSScriptRoot 'fake-gh.ps1'
    $env:FAKE_GH_STATE = Join-Path $tmp 'gh-state.json'
    function Test-Validate([string]$Kind, $Obj) {
        $f = Join-Path $tmp "r-$Kind.json"; ($Obj | ConvertTo-Json -Depth 5) | Set-Content $f
        $global:LASTEXITCODE = 0; & pwsh -NoProfile -File $val -Kind $Kind -Path $f *>&1 | Out-Null; $global:LASTEXITCODE
    }
    function Validation-Errors($Obj) {
        $f = Join-Path $tmp 'r-semantic.json'; ($Obj | ConvertTo-Json -Depth 5) | Set-Content $f
        $global:LASTEXITCODE = 0
        $output = & pwsh -NoProfile -File $val -Kind implementation -Path $f | ConvertFrom-Json
        @($output.errors)
    }
    function Set-Gh($Labels, $Comments = @()) { @{ labels = @($Labels); comments = @($Comments); prMerged = $false; prs = @() } | ConvertTo-Json -Depth 5 | Set-Content $env:FAKE_GH_STATE }
    function Get-Gh { $o = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json; if (-not $o.PSObject.Properties['created']) { $o | Add-Member created @() }; $o }
    $leaseScript = Join-Path $rp '.ai/factory/scripts/lease.ps1'
    function Invoke-Lease([string]$Action, [string]$Owner = '') {
        $leaseArgs = @('-NoProfile','-File',$leaseScript,'-Action',$Action,'-Issue','7','-GhCommand',$gh)
        if ($Owner) { $leaseArgs += @('-Owner',$Owner) }
        $oldPreference = $ErrorActionPreference; try { $ErrorActionPreference = 'Continue'; $discard = & pwsh @leaseArgs *>&1 | Out-String } finally { $ErrorActionPreference = $oldPreference }
        $LASTEXITCODE
    }
    Set-Gh @('factory:ready')
    Assert 'lease: GitHub-visible claim created' ((Invoke-Lease 'create' 'worker-a') -eq 0 -and @((Get-Gh).comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 1)
    Assert 'lease: same owner is idempotent' ((Invoke-Lease 'create' 'worker-a') -eq 0 -and @((Get-Gh).comments | Where-Object { $_ -match 'factory-lease:7' }).Count -eq 1)
    Assert 'lease: collision refused' ((Invoke-Lease 'create' 'worker-b') -ne 0)
    Assert 'lease: release is idempotent' ((Invoke-Lease 'release') -eq 0 -and (Invoke-Lease 'release') -eq 0)
    function Invoke-Route([string]$Event, $Obj, [int]$Issue = 0, [string]$GatePath = '') {
        $f = Join-Path $tmp 'route-result.json'; if ($Obj) { ($Obj | ConvertTo-Json -Depth 5) | Set-Content $f }
        $global:LASTEXITCODE = 0
        $a = @{ Event = $Event; GhCommand = $gh; ProjectPath = $rp }
        if ($Obj) { $a.Path = $f } else { $a.Issue = $Issue }
        if ($GatePath) { $a.GatePath = $GatePath }
        try { & pwsh -NoProfile -File $route @a *>&1 | Out-Null } catch { $global:LASTEXITCODE = 1 }
        $global:LASTEXITCODE
    }
    $plan = @{ issue = 7; objective = 'o'; acceptanceCriteria = 'a'; nonGoals = 'n'; risks = 'r'; dependencies = 'd'; suggestedWorkBreakdown = '1. do'; requiredProjectSkills = @('s'); unresolvedQuestions = ''; complexity = 'complexity:medium'; readyNotReadyStatus = 'ready' }
    $intake = @{ issue = 7; type = 'type:bug'; risk = 'risk:low'; summary = 'clear bug'; unresolvedQuestions = '' }
    Assert 'validate: good intake passes' ((Test-Validate 'intake' $intake) -eq 0)
    Set-Gh @('factory:new')
    $selectorState = @{
        labels = @(); comments = @();
        issues = @(
            @{ number = 1; title = 'tracking epic'; body = ''; url = 'https://github.com/x/y/issues/1'; createdAt = '2026-01-01T00:00:00Z'; labels = @('factory:new', 'epic', 'type:feature', 'risk:medium') },
            @{ number = 2; title = 'ambiguous labels'; body = ''; url = 'https://github.com/x/y/issues/2'; createdAt = '2026-01-02T00:00:00Z'; labels = @('factory:new', 'type:bug', 'type:feature', 'risk:low') },
            @{ number = 3; title = 'eligible work'; body = ''; url = 'https://github.com/x/y/issues/3'; createdAt = '2026-01-03T00:00:00Z'; labels = @('factory:new', 'type:bug', 'risk:low') },
            @{ number = 4; title = 'tracking label'; body = ''; url = 'https://github.com/x/y/issues/4'; createdAt = '2026-01-04T00:00:00Z'; labels = @('factory:new', 'factory:tracking', 'type:feature', 'risk:low') },
            @{ number = 5; title = 'new eligible work'; body = ''; url = 'https://github.com/x/y/issues/5'; createdAt = '2026-01-05T00:00:00Z'; labels = @('factory:new', 'type:feature', 'risk:low') },
            @{ number = 6; title = '[promotion] canary failed'; body = ''; url = 'https://github.com/x/y/issues/6'; createdAt = '2026-01-06T00:00:00Z'; labels = @('factory:new') }
        )
    }
    $selectorState | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $selectorOutput = Join-Path $tmp 'intake-selection.json'
    $selectorRun = Run 'select-intake-issue.ps1' @{ GhCommand = $gh; OutputPath = $selectorOutput }
    $selectedIntake = Get-Content -Raw $selectorOutput | ConvertFrom-Json
    Assert 'intake selector skips epics, tracking parents, and ambiguous taxonomy' ($selectorRun.Code -eq 0 -and $selectedIntake.issue -eq 3)
    $selectorScheduledOutput = Join-Path $tmp 'intake-scheduled-selection.json'
    $selectorScheduledTask = "Run the scheduled intake workflow. The workflow's registered selector chooses at most one oldest eligible existing issue labeled factory:new. If it reports no eligible issue, report that no work was available and stop."
    $selectorScheduledRun = Run 'select-intake-issue.ps1' @{ GhCommand = $gh; Task = $selectorScheduledTask; OutputPath = $selectorScheduledOutput }
    $selectedScheduledIntake = Get-Content -Raw $selectorScheduledOutput | ConvertFrom-Json
    Assert 'scheduled intake treats generic task context as a request for the oldest eligible issue' ($selectorScheduledRun.Code -eq 0 -and $selectedScheduledIntake.issue -eq 3 -and $selectedScheduledIntake.terminalReason -eq 'selected-oldest-eligible-issue')
    $selectorTargetOutput = Join-Path $tmp 'intake-target-selection.json'
    $selectorTargetRun = Run 'select-intake-issue.ps1' @{ GhCommand = $gh; Task = 'GitHub issue #5 (new eligible work) at https://github.com/x/y/issues/5'; OutputPath = $selectorTargetOutput }
    $selectedTargetIntake = Get-Content -Raw $selectorTargetOutput | ConvertFrom-Json
    Assert 'event intake selects its triggering issue instead of the oldest issue' ($selectorTargetRun.Code -eq 0 -and $selectedTargetIntake.issue -eq 5 -and $selectedTargetIntake.terminalReason -eq 'selected-triggered-issue')
    $selectorUnlabelledOutput = Join-Path $tmp 'intake-unlabelled-selection.json'
    $selectorUnlabelledRun = Run 'select-intake-issue.ps1' @{ GhCommand = $gh; Task = 'GitHub issue #6 ([promotion] canary failed) at https://github.com/x/y/issues/6'; OutputPath = $selectorUnlabelledOutput }
    $selectedUnlabelledIntake = Get-Content -Raw $selectorUnlabelledOutput | ConvertFrom-Json
    Assert 'intake selects a factory:new issue that has no type or risk label yet (promoter-filed failures)' ($selectorUnlabelledRun.Code -eq 0 -and $selectedUnlabelledIntake.issue -eq 6)
    $selectorIneligibleOutput = Join-Path $tmp 'intake-ineligible-selection.json'
    $selectorIneligibleRun = Run 'select-intake-issue.ps1' @{ GhCommand = $gh; Task = 'GitHub issue #1 (tracking epic) at https://github.com/x/y/issues/1'; OutputPath = $selectorIneligibleOutput }
    $selectedIneligibleIntake = Get-Content -Raw $selectorIneligibleOutput | ConvertFrom-Json
    Assert 'event intake does not substitute another issue when its trigger is ineligible' ($selectorIneligibleRun.Code -eq 0 -and $null -eq $selectedIneligibleIntake.issue)
    $selectorMalformedOutput = Join-Path $tmp 'intake-malformed-event.json'
    $selectorMalformedRun = Run 'select-intake-issue.ps1' @{ GhCommand = $gh; Task = 'GitHub issue event without an identifier'; OutputPath = $selectorMalformedOutput }
    Assert 'event intake fails closed when its trigger identifier is missing' ($selectorMalformedRun.Code -ne 0 -and -not (Test-Path $selectorMalformedOutput))
    Set-Gh @('factory:new')
    Assert 'route: intake -> needs-plan' ((Invoke-Route 'intake-result' $intake) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan' -and (Get-Gh).labels -contains 'type:bug' -and (Get-Gh).labels -contains 'risk:low')
    Set-Gh @('factory:new')
    Assert 'route: intake question -> needs-help' ((Invoke-Route 'intake-result' (With $intake @{ unresolvedQuestions = 'Which data source is authoritative?' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Assert 'validate: good plan passes' ((Test-Validate 'plan' $plan) -eq 0)
    $memoryPlan = With $plan @{ memoryRecall = @{ banksQueried = @('project-7'); memoryIds = @('m1'); memoryCount = 1; contextChars = 4200 } }
    Assert 'validate: bounded memory recall passes' ((Test-Validate 'plan' $memoryPlan) -eq 0)
    Assert 'validate: ready plan with open questions fails' ((Test-Validate 'plan' (With $plan @{ unresolvedQuestions = 'which db?' })) -ne 0)
    $bad = $plan.Clone(); $bad.Remove('issue')
    Assert 'validate: missing issue fails' ((Test-Validate 'plan' $bad) -ne 0)
    Assert 'validate: not-ready plan with questions passes' ((Test-Validate 'plan' (With $plan @{ unresolvedQuestions = 'q'; readyNotReadyStatus = 'not-ready' })) -eq 0)
    $decisionPlan = With $plan @{ unresolvedQuestions = 'Where should state live?'; readyNotReadyStatus = 'not-ready'; decisions = @(@{ id = 'state-owner'; question = 'Where should state live?'; context = 'Two stores exist --> pick one.'; recommendedOptionId = 'registry'; options = @(@{ id = 'registry'; label = 'Registry'; summary = 'Shared'; tradeoffs = 'Migration' }, @{ id = 'local'; label = 'Local file' }) }) }
    Assert 'validate: structured decisions pass' ((Test-Validate 'plan' $decisionPlan) -eq 0)
    Assert 'validate: a plan that is not ready must say what has to be answered' ((Test-Validate 'plan' (With $plan @{ readyNotReadyStatus = 'not-ready'; unresolvedQuestions = '' })) -ne 0 -and (Test-Validate 'plan' $decisionPlan) -eq 0)
    Assert 'validate: decision with one option fails' ((Test-Validate 'plan' (With $decisionPlan @{ decisions = @(@{ id = 'x'; question = 'q'; options = @(@{ id = 'a'; label = 'A' }) }) })) -ne 0)
    Assert 'validate: decision with unknown recommendation fails' ((Test-Validate 'plan' (With $decisionPlan @{ decisions = @(@{ id = 'x'; question = 'q'; recommendedOptionId = 'zzz'; options = @(@{ id = 'a'; label = 'A' }, @{ id = 'b'; label = 'B' }) }) })) -ne 0)
    Assert 'validate: decision with bad id fails' ((Test-Validate 'plan' (With $decisionPlan @{ decisions = @(@{ id = 'Bad Id'; question = 'q'; options = @(@{ id = 'a'; label = 'A' }, @{ id = 'b'; label = 'B' }) }) })) -ne 0)
    $validationGhState = Get-Content -Raw $env:FAKE_GH_STATE
    $impl = @{ issue = 7; status = 'success'; summary = 's'; filesChanged = @('a.gd'); testsRun = @('unit suite'); testResult = 'pass'; acceptanceCriteriaStatus = 'met'; documentationUpdated = $true; knownConcerns = ''; followUpSuggestions = ''; durableKnowledgeCandidates = ''; pr = 'https://github.com/example/project/pull/1' }
    Assert 'validate: good implementation passes' ((Test-Validate 'implementation' $impl) -eq 0)
    Assert 'validate: implementation with no documentation change and nonblocking concern passes' ((Test-Validate 'implementation' (With $impl @{ documentationUpdated = $false; knownConcerns = 'Minor follow-up suggested.' })) -eq 0)
    $noPr = $impl.Clone(); $noPr.Remove('pr')
    Assert 'validate: success without PR fails' ((Test-Validate 'implementation' $noPr) -ne 0)
    foreach ($badTests in @('failed', 'Not met', 'not-run', 'skipped', 'unknown')) {
        Assert "validate: success with $badTests tests fails" ((Test-Validate 'implementation' (With $impl @{ testResult = $badTests })) -ne 0)
    }
    foreach ($badAcceptance in @('Not met', 'Partially met', 'TODO', 'Acceptance criteria status')) {
        Assert "validate: success with $badAcceptance acceptance fails" ((Test-Validate 'implementation' (With $impl @{ acceptanceCriteriaStatus = $badAcceptance })) -ne 0)
    }
    Assert 'validate: success with empty testsRun fails' ((Test-Validate 'implementation' (With $impl @{ testsRun = @() })) -ne 0)
    Assert 'validate: success with placeholder testsRun fails' ((Test-Validate 'implementation' (With $impl @{ testsRun = @('test name or identifier') })) -ne 0)
    Assert 'validate: success with placeholder filesChanged fails' ((Test-Validate 'implementation' (With $impl @{ filesChanged = @('path/to/file1') })) -ne 0)
    Assert 'validate: success with malformed PR fails' ((Test-Validate 'implementation' (With $impl @{ pr = 'https://github.com/example/project/issues/1' })) -ne 0)
    Assert 'validate: legitimate failure result passes' ((Test-Validate 'implementation' (With $impl @{ status = 'failure'; testResult = 'failed'; acceptanceCriteriaStatus = 'Not met'; pr = '' })) -eq 0)
    Assert 'validate: contradictory result names its field' ((Validation-Errors (With $impl @{ testResult = 'failed' })) -match 'testResult')
    $receiptSchema = Join-Path $factory 'schemas/validation-receipt.schema.json'
    $receipt = @{ schemaVersion = 1; issue = 7; repository = 'example/project'; pr = 'https://github.com/example/project/pull/1'; headSha = ('a' * 40); stage = 'full'; status = 'passed'; exitCode = 0; artifactPaths = @('.factory/artifacts/validation/full/attempt/receipt.json') }
    Assert 'receipt: valid head-bound workflow record satisfies v1 schema' (Test-Json -Json ($receipt | ConvertTo-Json -Depth 5) -SchemaFile $receiptSchema)
    Assert 'receipt: legacy agent result cannot satisfy receipt schema' (-not (Test-Json -Json ($impl | ConvertTo-Json -Depth 5) -SchemaFile $receiptSchema -ErrorAction SilentlyContinue))
    Assert 'receipt: missing head cannot satisfy receipt schema' (-not (Test-Json -Json ((With $receipt @{ headSha = '' }) | ConvertTo-Json -Depth 5) -SchemaFile $receiptSchema -ErrorAction SilentlyContinue))
    Assert 'validation has no GitHub side effects' ((Get-Content -Raw $env:FAKE_GH_STATE) -eq $validationGhState)
    $rev = @{ issue = 7; approvalChangeRequestStatus = 'change-request'; blockingFindings = ''; nonBlockingFindings = ''; acceptanceCriteriaVerification = 'v'; testAdequacy = 't'; riskObservations = 'r'; pr = 'https://github.com/example/project/pull/1'; reviewedHeadSha = ('a' * 40); reviewerIdentity = 'independent-reviewer/model' }
    Assert 'validate: change-request without findings fails' ((Test-Validate 'review' $rev) -ne 0)
    Assert 'validate: change-request with findings passes' ((Test-Validate 'review' (With $rev @{ blockingFindings = 'bug at x' })) -eq 0)
    Assert 'validate: review approval requires current head and reviewer identity' ((Test-Validate 'review' (With $rev @{ approvalChangeRequestStatus = 'approval'; reviewedHeadSha = 'head'; reviewerIdentity = '' })) -ne 0)
    # The eligibility command consumes live GitHub evidence and clean, head-bound workflow receipts.
    $eligibilityScript = Join-Path $scripts 'verify-merge-eligibility.ps1'
    $eligibilityRoot = Join-Path $tmp 'eligibility-receipts'
    foreach ($stage in @('changed','full','verify')) {
        $dir = Join-Path $eligibilityRoot "$stage/attempt"
        New-Item -ItemType Directory -Force $dir | Out-Null
        @{ schemaVersion = 1; issue = 7; repository = 'example/project'; pr = $rev.pr; headSha = ('a' * 40); stage = $stage; status = 'passed'; exitCode = 0; artifactPaths = @(".factory/artifacts/validation/$stage/receipt.json"); worktreeClean = $true } | ConvertTo-Json | Set-Content (Join-Path $dir 'receipt.json')
    }
    $eligibilityState = @{
        labels = @('factory:review'); comments = @(); prHeadSha = ('a' * 40)
        prDetails = @{ number = 1; url = $rev.pr; body = 'Closes #7'; state = 'OPEN'; isDraft = $false; baseRefName = 'dev'; headRefOid = ('a' * 40); author = @{ login = 'implementer' }; labels = @(@{ name = 'risk:medium' }); reviewDecision = 'APPROVED'; statusCheckRollup = @(@{ name = 'Factory CI'; conclusion = 'SUCCESS' }); reviews = @(@{ state = 'APPROVED'; commit = @{ oid = ('a' * 40) }; author = @{ login = 'independent-reviewer' } }); closingIssuesReferences = @(@{ number = 7 }) }
        repoSettings = @{ allow_auto_merge = $true }
        rules = @(
            @{ type = 'pull_request'; parameters = @{ required_approving_review_count = 1; dismiss_stale_reviews_on_push = $true; require_last_push_approval = $true } },
            @{ type = 'required_review_thread_resolution'; parameters = @{} },
            @{ type = 'required_status_checks'; parameters = @{ required_status_checks = @(@{ context = 'Factory CI' }) } }
        )
        graphql = @{ data = @{ repository = @{ pullRequest = @{ reviewThreads = @{ nodes = @(@{ isResolved = $true }); pageInfo = @{ hasNextPage = $false } } } } } }
    }
    $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    function Test-Eligibility($Review, [string]$Name, [string]$Mode = 'approval') {
        $reviewFile = Join-Path $tmp "eligibility-$Name-review.json"; $outputFile = Join-Path $tmp "eligibility-$Name-output.json"
        $Review | ConvertTo-Json -Depth 5 | Set-Content $reviewFile
        $null = & pwsh -NoProfile -File $eligibilityScript -ReviewPath $reviewFile -OutputPath $outputFile -GhCommand $gh -ReceiptRoot $eligibilityRoot -ReviewMode $Mode 2>&1
        [pscustomobject]@{ Code = $LASTEXITCODE; Output = if (Test-Path $outputFile) { Get-Content -Raw $outputFile | ConvertFrom-Json } else { $null } }
    }
    $approvedReview = With $rev @{ approvalChangeRequestStatus = 'approval'; blockingFindings = '' }
    $eligible = Test-Eligibility $approvedReview 'valid'
    Assert 'merge gate allows current reviewed head with clean receipts and effective rules' ($eligible.Code -eq 0 -and $eligible.Output.decision -eq 'allowed')
    Assert 'medium-risk changes can merge with focused and integration receipts without a full-suite receipt requirement' (-not $eligible.Output.validation.fullRequired -and $eligible.Output.validation.changed -and $eligible.Output.validation.verify)
    $highRiskFullReceipt = Join-Path $eligibilityRoot 'full/attempt/receipt.json'
    Remove-Item -LiteralPath $highRiskFullReceipt -Force
    $eligibilityState.prDetails.labels = @(@{ name = 'risk:high' }); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $highRiskWithoutFull = Test-Eligibility $approvedReview 'high-risk-needs-full'
    Assert 'merge gate retains the full-suite requirement for high-risk changes' ($highRiskWithoutFull.Output.decision -eq 'denied' -and $highRiskWithoutFull.Output.validation.fullRequired)
    $eligibilityState.prDetails.labels = @(@{ name = 'risk:medium' }); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    @{ schemaVersion = 1; issue = 7; repository = 'example/project'; pr = $rev.pr; headSha = ('a' * 40); stage = 'full'; status = 'passed'; exitCode = 0; artifactPaths = @('.factory/artifacts/validation/full/attempt/receipt.json'); worktreeClean = $true } | ConvertTo-Json | Set-Content $highRiskFullReceipt
    $failedReceiptPath = Join-Path $eligibilityRoot 'full/newer/receipt.json'; New-Item -ItemType Directory -Force (Split-Path $failedReceiptPath) | Out-Null
    @{ schemaVersion = 1; issue = 7; repository = 'example/project'; pr = $rev.pr; headSha = ('a' * 40); stage = 'full'; status = 'failed'; exitCode = 1; artifactPaths = @('.factory/artifacts/validation/full/newer/receipt.json'); worktreeClean = $true } | ConvertTo-Json | Set-Content $failedReceiptPath
    (Get-Item $failedReceiptPath).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(2)
    $latestFailure = Test-Eligibility $approvedReview 'newer-failure'
    Assert 'merge gate denies when a newer same-head validation attempt failed' ($latestFailure.Output.decision -eq 'denied' -and (@($latestFailure.Output.blockers) -match 'full'))
    Remove-Item -LiteralPath (Split-Path $failedReceiptPath -Parent) -Recurse -Force
    $wrongHead = Test-Eligibility (With $approvedReview @{ reviewedHeadSha = ('b' * 40) }) 'wrong-head'
    Assert 'merge gate denies stale reviewer head' ($wrongHead.Output.decision -eq 'denied' -and (@($wrongHead.Output.blockers) -match 'reviewed head'))
    $eligibilityState.prHeadSha = ('b' * 40); $eligibilityState.prDetails.headRefOid = ('b' * 40); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $liveChanged = Test-Eligibility $approvedReview 'live-head-changed'
    Assert 'merge gate denies a PR head race before merge' ($liveChanged.Output.decision -eq 'denied' -and (@($liveChanged.Output.blockers) -match 'reviewed head'))
    $eligibilityState.prHeadSha = ('a' * 40); $eligibilityState.prDetails.headRefOid = ('a' * 40); $eligibilityState.rules = @(); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $noRules = Test-Eligibility $approvedReview 'no-rules'
    Assert 'merge gate denies missing effective repository rules' ($noRules.Output.decision -ne 'allowed')
    # Solo-maintainer posture (promotion review mode 'self-review'): no dev rules and no independent GitHub approval exist,
    # so those two requirements give way to the exact-head review result and head-bound receipts, which stay mandatory.
    $eligibilityState.prDetails.reviewDecision = ''; $eligibilityState.prDetails.reviews = @(); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $soloStrict = Test-Eligibility $approvedReview 'solo-strict'
    Assert 'merge gate stays strict by default: no rules and no independent approval deny' ($soloStrict.Output.decision -eq 'denied' -and $soloStrict.Output.reviewMode -eq 'approval')
    $soloSelf = Test-Eligibility $approvedReview 'solo-self' 'self-review'
    Assert 'self-review mode allows a solo repo with head-bound receipts but no dev rules or GitHub approval' ($soloSelf.Output.decision -eq 'allowed' -and $soloSelf.Output.reviewMode -eq 'self-review')
    $eligibilityState.prDetails.files = @(@{ path = 'scripts/release/factory_self_healing.py' })
    $eligibilityState.prDetails.body = "Closes #7`n`n## Scope`nAdds host-local diagnosis.`n## Risk`nMedium.`n## Invariants`nDev only; no auto-merge.`n## Validation evidence`nLocal suite receipts.`n## Unresolved findings`nNone."
    $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $releaseSelfReview = Test-Eligibility $approvedReview 'release-structured-self-review' 'self-review'
    Assert 'release controller changes pass with complete structured solo self-review' ($releaseSelfReview.Output.decision -eq 'allowed')
    $releaseAuthorReview = Test-Eligibility (With $approvedReview @{ reviewerIdentity = 'implementer' }) 'release-author-self-review' 'self-review'
    Assert 'solo self-review can be authored by the PR author when structurally complete' ($releaseAuthorReview.Output.decision -eq 'allowed')
    $eligibilityState.prDetails.body = "Closes #7`n`n## Scope`nAdds host-local diagnosis.`n## Risk`nMedium.`n## Invariants`nDev only.`n## Validation evidence`nLocal suite.`n## Unresolved findings`nOne blocker."
    $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $releaseUnresolved = Test-Eligibility $approvedReview 'release-unresolved-self-review' 'self-review'
    Assert 'release controller changes are refused when self-review findings remain unresolved' ($releaseUnresolved.Output.decision -eq 'denied' -and (@($releaseUnresolved.Output.blockers) -match 'unresolved findings'))
    $eligibilityState.prDetails.files = @(); $eligibilityState.prDetails.body = 'Closes #7'; $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $soloWrongHead = Test-Eligibility (With $approvedReview @{ reviewedHeadSha = ('b' * 40) }) 'solo-wrong-head' 'self-review'
    Assert 'self-review mode still denies a review bound to a stale head' ($soloWrongHead.Output.decision -eq 'denied' -and (@($soloWrongHead.Output.blockers) -match 'reviewed head'))
    $eligibilityState.prDetails.labels = @(); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $soloNoRisk = Test-Eligibility $approvedReview 'solo-no-risk' 'self-review'
    Assert 'self-review mode still requires exactly one risk label' ($soloNoRisk.Output.decision -eq 'denied' -and (@($soloNoRisk.Output.blockers) -match 'risk label'))
    $eligibilityState.prDetails.labels = @(@{ name = 'risk:medium' }); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    Move-Item (Join-Path $eligibilityRoot 'verify/attempt/receipt.json') (Join-Path $eligibilityRoot 'verify/attempt/receipt.json.off')
    $soloNoReceipt = Test-Eligibility $approvedReview 'solo-no-receipt' 'self-review'
    Assert 'self-review mode still requires a head-bound verify receipt' ($soloNoReceipt.Output.decision -eq 'denied' -and (@($soloNoReceipt.Output.blockers) -match 'verify'))
    Move-Item (Join-Path $eligibilityRoot 'verify/attempt/receipt.json.off') (Join-Path $eligibilityRoot 'verify/attempt/receipt.json')
    $eligibilityState.prDetails.reviewDecision = 'APPROVED'; $eligibilityState.prDetails.reviews = @(@{ state = 'APPROVED'; commit = @{ oid = ('a' * 40) }; author = @{ login = 'independent-reviewer' } }); $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $eligibilityState.rules = @(
        @{ type = 'pull_request'; parameters = @{ required_approving_review_count = 1; dismiss_stale_reviews_on_push = $true; require_last_push_approval = $true } },
        @{ type = 'required_review_thread_resolution'; parameters = @{} },
        @{ type = 'required_status_checks'; parameters = @{ required_status_checks = @(@{ context = 'Factory CI' }) } }
    ); $eligibilityState.prDetails.statusCheckRollup[0].conclusion = 'FAILURE'; $eligibilityState | ConvertTo-Json -Depth 10 | Set-Content $env:FAKE_GH_STATE
    $failedCheck = Test-Eligibility $approvedReview 'failed-check'
    Assert 'merge gate denies failed required check' ($failedCheck.Output.decision -eq 'denied' -and (@($failedCheck.Output.blockers) -match 'Factory CI'))
    $inv = @{ issue = 7; failureClassification = 'flaky-test'; evidence = 'e'; attemptsReviewed = 'a'; rootCauseHypothesis = 'h'; confidence = 'high'; recommendedAction = 'retry'; automaticRetryAppropriate = $true }
    Assert 'validate: good investigation passes' ((Test-Validate 'investigation' $inv) -eq 0)
    Assert 'validate: unknown classification fails' ((Test-Validate 'investigation' (With $inv @{ failureClassification = 'gremlins' })) -ne 0)

    $investigationHandoffRoot = Join-Path $tmp 'investigation-handoff'
    New-Item -ItemType Directory -Force $investigationHandoffRoot | Out-Null
    Push-Location $investigationHandoffRoot
    try {
        $handoff = Run 'ensure-investigation-result.ps1' @{ Task = 'Investigate GitHub issue #7'; Path = '.factory/investigate-result.json' }
        Assert 'investigation handoff: first missing result requests the configured retry' ($handoff.Code -eq 1 -and -not (Test-Path '.factory/investigate-result.json'))
        $handoff = Run 'ensure-investigation-result.ps1' @{ Task = 'Investigate GitHub issue #7'; Path = '.factory/investigate-result.json' }
        $preserved = Get-Content -Raw '.factory/investigate-result.json' | ConvertFrom-Json
        Assert 'investigation handoff: repeated absence creates a valid conservative result' ($handoff.Code -eq 0 -and $preserved.issue -eq 7 -and $preserved.failureClassification -eq 'unknown' -and $preserved.confidence -eq 'low' -and -not $preserved.automaticRetryAppropriate)
        Assert 'investigation handoff: retry marker is removed after fallback creation' (-not (Test-Path '.factory/investigate-result.json.validation-attempt.json'))
    } finally { Pop-Location }

    Set-Gh @('factory:needs-plan', 'type:bug')
    Assert 'route: plan ready -> factory:ready' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:needs-plan' -and (Get-Gh).labels -contains 'type:bug' -and (Get-Gh).labels -contains 'complexity:medium')
    Assert 'route: plan posted as comment' (@((Get-Gh).comments).Count -eq 1)
    # A lifecycle profile can hold a completed plan for a person before implementation. The router reads that from
    # the policy; nothing in it names risk:high or the sign-off state.
    $env:FACTORY_LIFECYCLE_PROFILE = 'risk-gated'
    try {
        Set-Gh @('factory:needs-plan', 'type:bug', 'risk:high')
        Assert 'route (risk-gated profile): a completed plan for risk:high work waits for sign-off, not for implementation' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:design-signoff' -and (Get-Gh).labels -notcontains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:needs-plan' -and @((Get-Gh).comments | Where-Object { $_ -match 'Factory sign-off required' -and $_ -match 'tech-lead' }).Count -eq 1)
        Assert 'route (risk-gated profile): work that waits for sign-off cannot be started by the implement automation' ((Invoke-Route 'start' $null 7) -ne 0)
        Set-Gh @('factory:needs-plan', 'type:bug', 'risk:medium')
        Assert 'route (risk-gated profile): risk:medium work still goes straight to ready' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:design-signoff')
    } finally { Remove-Item Env:FACTORY_LIFECYCLE_PROFILE -ErrorAction SilentlyContinue }
    Set-Gh @('factory:needs-plan', 'type:bug', 'risk:high')
    Assert 'route (standard profile): risk:high work still goes to ready, so the default process is unchanged' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:design-signoff')
    Set-Gh @('factory:needs-plan', 'risk:high')
    Assert 'route: risk:high plan proceeds without user approval' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:needs-help')
    Set-Gh @('factory:needs-plan')
    Assert 'route: not-ready -> needs-help' ((Invoke-Route 'plan-result' (With $plan @{ readyNotReadyStatus = 'not-ready'; unresolvedQuestions = 'q' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:needs-plan')
    Assert 'route: structured decision -> needs-help' ((Invoke-Route 'plan-result' $decisionPlan) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    $decisionBody = @((Get-Gh).comments | Where-Object { $_ -match 'factory-decision:v1' })[0]
    $decisionJson = if ($decisionBody -match '<!-- factory-decision:v1 (.+?) -->') { $Matches[1] | ConvertFrom-Json } else { $null }
    Assert 'route: decision marker carries parseable options and recommendation' ($decisionJson -and $decisionJson.version -eq 1 -and $decisionJson.decisions[0].id -eq 'state-owner' -and @($decisionJson.decisions[0].options).Count -eq 2 -and $decisionJson.decisions[0].recommendedOptionId -eq 'registry')
    Assert 'route: decision marker cannot be closed by agent text' ($decisionBody -match 'pick one' -and $decisionBody -match '<!-- factory-decision:v1 ((?:(?!-->).)+) -->' -and $decisionJson.decisions[0].context -eq 'Two stores exist --> pick one.')
    Assert 'route: decision comment is readable on GitHub' ($decisionBody -match 'Suggested paths' -and $decisionBody -match 'recommended')
    Set-Gh @('factory:needs-plan')
    Assert 'route: plain not-ready posts no decision marker' ((Invoke-Route 'plan-result' (With $plan @{ readyNotReadyStatus = 'not-ready'; unresolvedQuestions = 'q' })) -eq 0 -and @((Get-Gh).comments | Where-Object { $_ -match 'factory-decision:v1' }).Count -eq 0)
    Set-Gh @('factory:review')
    Assert 'route: plan-result from wrong state refused' ((Invoke-Route 'plan-result' $plan) -ne 0)
    Assert 'route: wrong-state refusal leaves labels alone' (((Get-Gh).labels -join ',') -eq 'factory:review')
    Set-Gh @('factory:ready')
    Assert 'route: start -> working' ((Invoke-Route 'start' $null 7) -eq 0 -and (Get-Gh).labels -contains 'factory:working' -and (Get-Gh).labels -notcontains 'factory:ready')
    $execution = Get-Content -Raw (Join-Path $rp '.factory/execution.json') | ConvertFrom-Json
    Assert 'route: selected worker recorded' ($execution.execution.provider -eq 'openhands' -and $execution.execution.agent -eq 'codex' -and $execution.execution.status -eq 'selected')
    Set-Gh @('factory:ready', 'complexity:medium', 'agent:local')
    Assert 'route: medium complexity cannot select local worker' ((Invoke-Route 'start' $null 7) -eq 0 -and (Get-Content -Raw (Join-Path $rp '.factory/execution.json') | ConvertFrom-Json).execution.agent -eq 'codex')
    Assert 'route: start is idempotent while working' ((Invoke-Route 'start' $null 7) -eq 0)
    Set-Gh @('factory:needs-plan')
    Assert 'route: start from needs-plan refused' ((Invoke-Route 'start' $null 7) -ne 0)
    # already-resolved: closed issues finish early, reconcile to factory:done, and later steps no-op
    $resolvedScript = Join-Path $rp '.ai/factory/scripts/check-already-resolved.ps1'
    $marker = Join-Path $tmp '.factory/already-resolved.json'
    function Invoke-Resolved { Push-Location $tmp; try { $global:LASTEXITCODE = 0; & pwsh -NoProfile -File $resolvedScript -Task 'GitHub issue #7 (x) at https://github.com/o/r/issues/7' -GhCommand $gh *>&1 | Out-Null; $global:LASTEXITCODE } finally { Pop-Location } }
    function Set-IssueState([string]$S) { $o = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable; $o.issueState = $S; $o | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE }
    Set-Gh @('factory:ready'); Set-IssueState 'OPEN'
    Assert 'resolved: open issue writes no marker' ((Invoke-Resolved) -eq 0 -and -not (Test-Path $marker) -and (Get-Gh).labels -contains 'factory:ready')
    Set-IssueState 'CLOSED'
    Assert 'resolved: closed issue writes marker and reconciles to factory:done' ((Invoke-Resolved) -eq 0 -and (Test-Path $marker) -and (Get-Gh).labels -contains 'factory:done' -and (Get-Gh).labels -notcontains 'factory:ready')
    Push-Location $tmp
    try {
        Set-Gh @('factory:done'); Set-IssueState 'CLOSED'
        $v = & pwsh -NoProfile -File (Join-Path $rp '.ai/factory/scripts/validate-result.ps1') -Kind implementation -Path (Join-Path $tmp 'missing.json') *>&1 | Out-String
        Assert 'resolved: validate-result skips when marker present' ($LASTEXITCODE -eq 0 -and $v -match 'already-resolved')
        $r = & pwsh -NoProfile -File $route -Event implement-result -Path (Join-Path $tmp 'missing.json') -GhCommand $gh -ProjectPath $tmp *>&1 | Out-String
        Assert 'resolved: route-state skips when marker present' ($LASTEXITCODE -eq 0 -and $r -match 'already-resolved')
    } finally { Pop-Location }
    Set-IssueState 'OPEN'; Set-Gh @('factory:ready')
    Assert 'resolved: stale marker removed once issue is open' ((Invoke-Resolved) -eq 0 -and -not (Test-Path $marker))
    Set-Gh @('factory:working')
    Assert 'route: implement success -> review' ((Invoke-Route 'implement-result' $impl) -eq 0 -and (Get-Gh).labels -contains 'factory:review')
    $execution = Get-Content -Raw (Join-Path $rp '.factory/execution.json') | ConvertFrom-Json
    Assert 'route: execution completion recorded' ($execution.execution.status -eq 'complete' -and $execution.execution.result -eq 'success' -and $execution.execution.pr -eq $impl.pr)
    Set-Gh @('factory:working')
    Assert 'route: implement failure -> investigate' ((Invoke-Route 'implement-result' (With $impl @{ status = 'failure' })) -eq 0 -and (Get-Gh).labels -contains 'factory:investigate')
    Set-Gh @('factory:review')
    $commentsBefore = @((Get-Gh).comments).Count
    Assert 'route: a repeated implement success while already in review is a no-op' ((Invoke-Route 'implement-result' $impl) -eq 0 -and (Get-Gh).labels -contains 'factory:review' -and @((Get-Gh).comments).Count -eq $commentsBefore)
    Assert 'route: implement failure from review is still refused' ((Invoke-Route 'implement-result' (With $impl @{ status = 'failure' })) -ne 0)
    Assert 'route: review approval without PR requests implementation correction' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval'; pr = '' })) -eq 0 -and (Get-Gh).labels -contains 'factory:changes-requested' -and (Get-Gh).labels -notcontains 'factory:human-review')
    Set-Gh @('factory:review', 'risk:low')
    Assert 'route: approval without eligibility receipt cannot merge or mark done' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval' })) -eq 0 -and (Get-Gh).labels -contains 'factory:review' -and -not (Get-Gh).prMerged)
    $oldFactoryFence = $env:FACTORY_FENCING_TOKEN
    Remove-Item Env:FACTORY_FENCING_TOKEN -ErrorAction SilentlyContinue # hermetic: an ambient managed-run token defers factory:done
    $gatePath = Join-Path $tmp 'merge-eligibility.json'
    @{ decision = 'allowed'; pr = $rev.pr; headSha = ('a' * 40); blockers = @() } | ConvertTo-Json | Set-Content $gatePath
    $oldFactoryFence = $env:FACTORY_FENCING_TOKEN; Remove-Item Env:FACTORY_FENCING_TOKEN -ErrorAction SilentlyContinue
    $gs = Get-Gh; $gs | Add-Member -NotePropertyName prHeadSha -NotePropertyValue ('a' * 40) -Force; $gs | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
    $savedFence = $env:FACTORY_FENCING_TOKEN; Remove-Item Env:FACTORY_FENCING_TOKEN -ErrorAction SilentlyContinue
    try {
    Assert 'route: eligible approval uses expected head and marks done only after observed merge' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval' }) -GatePath $gatePath) -eq 0 -and (Get-Gh).labels -contains 'factory:done' -and (Get-Gh).prMerged -and (@((Get-Gh).prMergeArgs) -contains '--match-head-commit'))
    } finally { if ($null -ne $savedFence) { $env:FACTORY_FENCING_TOKEN = $savedFence } }
    $oldFactoryFence = $env:FACTORY_FENCING_TOKEN
    # Solo-maintainer posture: merge directly (dev has no rules, so --auto is rejected), pinned to the reviewed head.
    $selfGate = Join-Path $tmp 'merge-eligibility-self.json'
    @{ decision = 'allowed'; reviewMode = 'self-review'; pr = $rev.pr; headSha = ('a' * 40); blockers = @() } | ConvertTo-Json | Set-Content $selfGate
    Set-Gh @('factory:review', 'risk:low'); $gs = Get-Gh; $gs | Add-Member -NotePropertyName prHeadSha -NotePropertyValue ('a' * 40) -Force; $gs | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
    try {
        $env:FACTORY_FENCING_TOKEN = '12'
        Set-Gh @('factory:review', 'risk:low'); $managedState = Get-Gh; $managedState | Add-Member -NotePropertyName prHeadSha -NotePropertyValue ('a' * 40) -Force; $managedState | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
        $managedReview = Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval' }) -GatePath $gatePath
        Assert 'route: managed workspace waits for post-integration validation before factory:done' ($managedReview -eq 0 -and (Get-Gh).labels -contains 'factory:review' -and (Get-Gh).labels -notcontains 'factory:done' -and (Get-Gh).prMerged)
    } finally { if ($null -eq $oldFactoryFence) { Remove-Item Env:FACTORY_FENCING_TOKEN -ErrorAction SilentlyContinue } else { $env:FACTORY_FENCING_TOKEN = $oldFactoryFence } }
    Set-Gh @('factory:review')
    $chg = With $rev @{ blockingFindings = 'bug' }
    Assert 'route: review change-request -> changes-requested' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:changes-requested')
    Set-Gh @('factory:review') @('x <!-- factory:review-round -->', 'y <!-- factory:review-round -->')
    Assert 'route: review round limit starts automatic investigation' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:investigate' -and (@((Get-Gh).comments)[-1] -match 'continuing the work'))
    Set-Gh @('factory:investigate')
    Assert 'route: investigate retry -> ready' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:ready')
    Set-Gh @('factory:investigate') @('<!-- factory:investigate-retry -->')
    Assert 'route: second investigation re-plans automatically' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan')
    $before = @((Get-Gh).comments).Count
    Assert 'route: investigate re-run after a partial failure is idempotent' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan' -and @((Get-Gh).comments).Count -eq $before)
    Set-Gh @('factory:investigate')
    Assert 'route: low-confidence investigation re-plans automatically' ((Invoke-Route 'investigate-result' (With $inv @{ confidence = 'low' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan')
    Set-Gh @('factory:investigate')
    $architectureDecision = @(@{ id = 'state-owner'; question = 'Where should state live?'; options = @(@{ id = 'registry'; label = 'Registry' }, @{ id = 'ledger'; label = 'Ledger' }) })
    Assert 'route: major architecture investigation with a stated decision requests user input' ((Invoke-Route 'investigate-result' (With $inv @{ failureClassification = 'architecture'; automaticRetryAppropriate = $false; decisions = $architectureDecision })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help' -and @((Get-Gh).comments | Where-Object { $_ -match 'Where should state live' }).Count -ge 1)
    Set-Gh @('factory:investigate')
    Assert 'route: an architecture classification that states no decision is re-planned, not parked with nothing to answer' ((Invoke-Route 'investigate-result' (With $inv @{ failureClassification = 'architecture'; automaticRetryAppropriate = $false })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan' -and (Get-Gh).labels -notcontains 'factory:needs-help' -and @((Get-Gh).comments | Where-Object { $_ -match 'stated no decision to make' }).Count -eq 1)
    Set-Gh @('factory:investigate') @('first <!-- factory:investigate-result:aaaaaaaaaaaaaaaa -->', 'second <!-- factory:investigate-result:bbbbbbbbbbbbbbbb -->')
    Assert 'route: an issue investigated three times stops and asks a person to narrow, split or close it' ((Invoke-Route 'investigate-result' (With $inv @{ failureClassification = 'implementation'; automaticRetryAppropriate = $false })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help' -and @((Get-Gh).comments | Where-Object { $_ -match 'investigated 3 times without converging' -and $_ -match 'narrow the scope, split it' }).Count -eq 1)
    Set-Gh @('factory:investigate') @('first <!-- factory:investigate-result:aaaaaaaaaaaaaaaa -->')
    Assert 'route: a second investigation still re-plans' ((Invoke-Route 'investigate-result' (With $inv @{ failureClassification = 'implementation'; automaticRetryAppropriate = $false })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan')
    Set-Gh @('factory:investigate')
    Assert 'route: model-classified dependency without verified blocker re-plans automatically' ((Invoke-Route 'investigate-result' (With $inv @{ failureClassification = 'dependency'; automaticRetryAppropriate = $false })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan' -and (Get-Gh).labels -notcontains 'factory:blocked')
    Set-Gh @('factory:investigate')
    Assert 'route: model-classified environment without verified blocker re-plans automatically' ((Invoke-Route 'investigate-result' (With $inv @{ failureClassification = 'environment'; automaticRetryAppropriate = $false })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-plan' -and (Get-Gh).labels -notcontains 'factory:blocked')
    Set-Gh @('factory:ready', 'factory:working', 'type:bug')
    Assert 'route: conflicting state labels collapse to one' ((Invoke-Route 'implement-result' $impl) -eq 0 -and @((Get-Gh).labels | Where-Object { $_ -like 'factory:*' }).Count -eq 1)

    # ---- Decomposition ------------------------------------------------------
    $subs = @(
        @{ title = 'Phase A'; body = 'Do A'; type = 'type:feature'; risk = 'risk:medium'; complexity = 'complexity:medium' },
        @{ title = 'Phase B'; body = 'Do B'; type = 'type:test'; risk = 'risk:low'; complexity = 'complexity:small'; dependsOn = @(0) }
    )
    $dec = With $plan @{ readyNotReadyStatus = 'decomposed'; subIssues = $subs }
    Assert 'validate: good decomposition passes' ((Test-Validate 'plan' $dec) -eq 0)
    Assert 'validate: decomposed without subIssues fails' ((Test-Validate 'plan' (With $plan @{ readyNotReadyStatus = 'decomposed' })) -ne 0)
    Assert 'validate: unknown sub-issue label fails' ((Test-Validate 'plan' (With $plan @{ readyNotReadyStatus = 'decomposed'; subIssues = @(@{ title = 't'; body = 'b'; type = 'type:nope'; risk = 'risk:low' }) })) -ne 0)
    Assert 'validate: bad dependsOn index fails' ((Test-Validate 'plan' (With $plan @{ readyNotReadyStatus = 'decomposed'; subIssues = @(@{ title = 't'; body = 'b'; type = 'type:bug'; risk = 'risk:low'; dependsOn = @(5) }) })) -ne 0)
    Assert 'validate: duplicate sub-issue titles fail' ((Test-Validate 'plan' (With $plan @{ readyNotReadyStatus = 'decomposed'; subIssues = @($subs[0], $subs[0]) })) -ne 0)
    Set-Gh @('factory:needs-plan')
    Assert 'route: decomposed parent closes without scheduling handoff' ((Invoke-Route 'plan-result' $dec) -eq 0 -and (Get-Gh).labels -contains 'factory:done' -and (Get-Gh).issueCloseRequested -and (Get-Gh).issueState -eq 'CLOSED' -and (Get-Gh).labels -notcontains 'factory:human-review')
    $iss = @((Get-Gh).issues)
    Assert 'route: sub-issues queued for planning' ($iss.Count -eq 2 -and $iss[0].labels -eq 'factory:needs-plan,type:feature,risk:medium,complexity:medium')
    Assert 'route: sub-issue links back to parent' ($iss[0].body -match 'Parent: #7' -and $iss[0].body -match 'factory-parent:7')
    Assert 'route: parent comment lists children and dependencies' ((@((Get-Gh).comments)[-1]) -match '#100' -and (@((Get-Gh).comments)[-1]) -match '\| #101 \| Phase B .* \| #100 \|')
    $st = Get-Gh; $st.labels = @('factory:needs-plan'); $st | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
    Assert 'route: re-running does not duplicate sub-issues' ((Invoke-Route 'plan-result' $dec) -eq 0 -and @((Get-Gh).issues).Count -eq 2)

    $labelScript = Join-Path $rp '.ai/factory/scripts/create-labels.ps1'
    Set-Gh @()
    & pwsh -NoProfile -File $labelScript -GhCommand $gh *>&1 | Out-Null
    $created = @((Get-Gh).created)
    Assert 'labels: all factory-state labels created' (@(@('factory:new', 'factory:ready', 'factory:investigate', 'factory:done') | Where-Object { $created -notcontains $_ }).Count -eq 0)
    Assert 'labels: tracking-parent classification created' ($created -contains 'factory:tracking')
    Assert 'labels: the standard profile adds no state label of its own' ($created -notcontains 'factory:design-signoff')
    Set-Gh @()
    $env:FACTORY_LIFECYCLE_PROFILE = 'risk-gated'
    try { & pwsh -NoProfile -File $labelScript -GhCommand $gh *>&1 | Out-Null } finally { Remove-Item Env:FACTORY_LIFECYCLE_PROFILE -ErrorAction SilentlyContinue }
    Assert "labels: a lifecycle profile's own states get their labels (factory:design-signoff)" (@((Get-Gh).created) -contains 'factory:design-signoff')
    Set-Gh @()
    & pwsh -NoProfile -File $labelScript -GhCommand $gh *>&1 | Out-Null
    $created = @((Get-Gh).created)
    Assert 'labels: type, risk and agent labels created' ($created -contains 'type:bug' -and $created -contains 'risk:high' -and $created -contains 'agent:either')
    # Hourly maintenance runs this. Labels that already match cost no call, and one server error is retried.
    Set-Gh @()
    $labelState = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable
    $labelState.existingLabels = @(
        @{ name = 'factory:new'; color = '1d76db'; description = 'Factory: newly filed, not yet triaged' },
        @{ name = 'factory:done'; color = 'ffffff'; description = 'Factory: complete' },
        @{ name = 'risk:high'; color = 'b60205'; description = 'Factory risk label' }
    )
    $labelState.labelCreateFailures = 1
    $labelState | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $labelRun = & pwsh -NoProfile -File $labelScript -GhCommand $gh *>&1 | Out-String
    $labelCode = $LASTEXITCODE
    $created = @((Get-Gh).created)
    Assert 'labels: a label that already matches is not written again, one that differs or is missing is' ($labelCode -eq 0 -and $created -notcontains 'factory:new' -and $created -notcontains 'risk:high' -and $created -contains 'factory:done' -and $created -contains 'factory:ready')
    Assert 'labels: one GitHub server error is retried instead of failing the run' ($labelCode -eq 0 -and (Get-Gh).labelCreateFailures -eq 0 -and $labelRun -match 'labels ensured')
    Assert 'labels: dry-run creates nothing' ((& { Set-Gh @(); & pwsh -NoProfile -File $labelScript -GhCommand $gh -DryRun *>&1 | Out-Null; @((Get-Gh).created).Count -eq 0 }))

    $auditInput = Join-Path $tmp 'backlog-label-audit-input.json'
    @{ labels = @(); comments = @(); created = @(); issueState = 'OPEN'; issues = @(
        @{ number = 3; title = 'Unmarked test'; body = ''; labels = @(@{ name = 'test' }) },
        @{ number = 2; title = 'Already audited'; body = ''; labels = @(@{ name = 'factory:needs-help' }) },
        @{ number = 1; title = 'Unmarked docs'; body = ''; labels = @(@{ name = 'documentation' }) },
        @{ number = 4; title = 'Blocked legacy work'; body = ''; labels = @(@{ name = 'blocker' }) },
        @{ number = 5; title = 'Ambiguous legacy work'; body = ''; labels = @(@{ name = 'question' }) }
    ) } | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
    $auditScript = Join-Path $rp '.ai/factory/scripts/audit-backlog-labels.ps1'
    & pwsh -NoProfile -File $auditScript -GhCommand $gh -Limit 1 -OutputPath $auditInput *>&1 | Out-Null
    $auditCandidates = Get-Content -Raw $auditInput | ConvertFrom-Json
    $candidateIssues = @($auditCandidates.candidates | ForEach-Object { if ($_ -and $_.PSObject.Properties.Name -contains 'issue') { $_.issue } })
    $resolvedIssues = @($auditCandidates.resolved | ForEach-Object { if ($_ -and $_.PSObject.Properties.Name -contains 'issue') { $_.issue } })
    Assert 'backlog audit input: only unmarked issues are fetched for evaluation' ($LASTEXITCODE -eq 0 -and $candidateIssues -notcontains 2 -and $resolvedIssues -notcontains 2)
    Assert 'backlog audit input: static normalization is not bounded by the LLM limit' (@($auditCandidates.resolved).Count -eq 3)
    Assert 'backlog audit input: classification hints resolve test taxonomy' (@($auditCandidates.resolved | Where-Object { $_.issue -eq 3 }).added -contains 'type:test' -and (@($auditCandidates.resolved | Where-Object { $_.issue -eq 3 }).added -contains 'risk:low'))
    Assert 'backlog audit collector performs no issue-label or comment effects' (@($auditCandidates.resolved).Count -eq 3 -and (Get-Gh).labels.Count -eq 0 -and @((Get-Gh).comments).Count -eq 0)
    Assert 'backlog audit input: blocked marker resolves to factory:blocked' ((@($auditCandidates.resolved | Where-Object { $_.issue -eq 4 }).added) -contains 'factory:blocked')
    Assert 'backlog audit input: rule hits and ambiguity are recorded' ($auditCandidates.classificationMetrics.deterministicRuleHits -eq 3 -and $auditCandidates.classificationMetrics.ambiguousIssues -eq 1 -and $auditCandidates.classificationMetrics.ambiguousIssuesSelectedForReview -eq 1 -and $auditCandidates.classificationMetrics.ruleHits.legacy_blocked_marker -eq 1)
    Assert 'backlog audit input: only ambiguous work is returned to the LLM' (@($auditCandidates.candidates).Count -eq 1 -and $auditCandidates.candidates[0].number -eq 5 -and (Get-Gh).labels.Count -eq 0)
    Assert 'backlog audit input: candidate body is fetched before the LLM step' ($auditCandidates.candidates[0].PSObject.Properties.Name -contains 'body')
    $auditPreparationPath = Join-Path $tmp 'backlog-label-audit-preparation.json'
    $auditApplyScript = Join-Path $scripts 'apply-backlog-label-audit.ps1'
    $prepareAudit = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; OutputPath = $auditPreparationPath; GhCommand = $gh; Prepare = $true }
    $preparation = Get-Content -Raw $auditPreparationPath | ConvertFrom-Json
    Assert 'backlog audit preparation applies deterministic labels and reserves bounded candidates' ($prepareAudit.Code -eq 0 -and $preparation.status -eq 'prepared' -and (Get-Gh).labels -contains 'factory:new' -and (Get-Gh).labels -contains 'factory:blocked' -and (Get-Gh).labels -contains 'factory:auditing')
    Assert 'backlog audit preparation creates one durable reservation marker' (@((Get-Gh).comments | Where-Object { $_ -match 'factory-audit-reservation:5' }).Count -eq 1)
    Assert 'backlog audit preparation ensures taxonomy through its installed sibling script' (@((Get-Gh).created).Count -gt 0)
    $prepareAgain = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; OutputPath = $auditPreparationPath; GhCommand = $gh; Prepare = $true }
    Assert 'backlog audit preparation recognizes static labels and reservation on retry' ($prepareAgain.Code -eq 0 -and @((Get-Gh).comments | Where-Object { $_ -match 'factory-audit-reservation:5' }).Count -eq 1)
    $emptyAuditInput = Join-Path $tmp 'backlog-label-audit-empty.json'
    $emptyAudit = Get-Content -Raw $auditInput | ConvertFrom-Json -AsHashtable
    $emptyAudit.candidates = @(); $emptyAudit.staged = @()
    $emptyAudit | ConvertTo-Json -Depth 10 | Set-Content $emptyAuditInput
    $emptyPrep = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $emptyAuditInput; OutputPath = (Join-Path $tmp 'backlog-label-audit-empty-prep.json'); GhCommand = $gh; Prepare = $true; WorkflowContract = $true }
    $emptySummaryLine = $emptyPrep.Out -split "`r?`n" | Where-Object { $_ -match '^\s*\{"status":"prepared"' } | Select-Object -Last 1
    $emptySummary = $emptySummaryLine | ConvertFrom-Json
    Assert 'backlog audit has typed no-work after deterministic preparation when no candidates remain' ($emptyPrep.Code -eq 0 -and $emptySummary.status -eq 'prepared' -and $emptySummary.candidateCount -eq 0 -and $emptySummary.resolvedCount -eq 3 -and $emptySummary.'$cezar'.action -eq 'no_work')

    $auditProposalPath = Join-Path $tmp 'backlog-label-audit.json'
    $auditApplicationPath = Join-Path $tmp 'backlog-label-audit-application.json'
    @{ considered = @(5); changed = @(@{ issue = 5; added = @('factory:new', 'type:maintenance', 'risk:medium'); reason = 'No objective legacy type marker; routine maintenance classification.' }); skipped = @() } | ConvertTo-Json -Depth 6 | Set-Content $auditProposalPath
    $state = Get-Gh; $state.labels = @($state.labels) + 'factory:ready'; $auditIssue = @($state.issues | Where-Object { $_.number -eq 5 })[0]; $auditIssue.labels = @($auditIssue.labels) + 'factory:ready'; $state | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $staleApply = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $auditProposalPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    Assert 'backlog audit consumer refuses changed live labels' ($staleApply.Code -ne 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -contains 'factory:auditing')
    $state = Get-Gh; $state.labels = @($state.labels | Where-Object { $_ -ne 'factory:ready' }); $auditIssue = @($state.issues | Where-Object { $_.number -eq 5 })[0]; $auditIssue.labels = @($auditIssue.labels | Where-Object { $_ -ne 'factory:ready' }); $state | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $wrongKeyProposalPath = Join-Path $tmp 'backlog-label-audit-wrong-key.json'
    @{ considered = @(5); changed = @(@{ number = 5; added = @('factory:new', 'type:maintenance', 'risk:medium'); reason = 'well-formed classification with wrong issue key' }); skipped = @() } | ConvertTo-Json -Depth 6 | Set-Content $wrongKeyProposalPath
    $wrongKeyApply = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $wrongKeyProposalPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    $candidateIssueState = @((Get-Gh).issues | Where-Object { $_.number -eq 5 })[0]
    Assert 'backlog audit consumer rejects number-keyed outcomes before mutation' ($wrongKeyApply.Code -ne 0 -and $candidateIssueState.labels -contains 'factory:auditing' -and $candidateIssueState.labels -notcontains 'factory:new')
    $noConsideredPath = Join-Path $tmp 'backlog-label-audit-no-considered.json'
    @{ changed = @(@{ issue = 5; added = @('factory:new', 'type:maintenance', 'risk:medium'); reason = 'proposal omitting considered' }) } | ConvertTo-Json -Depth 6 | Set-Content $noConsideredPath
    $noConsideredApply = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $noConsideredPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    $candidateIssueState = @((Get-Gh).issues | Where-Object { $_.number -eq 5 })[0]
    Assert 'backlog audit proposal missing considered fails with a schema message, not a property error' ($noConsideredApply.Code -ne 0 -and $noConsideredApply.Out -match 'backlog-label-audit-proposal\.schema\.json' -and $noConsideredApply.Out -notmatch 'cannot be found on this object' -and $candidateIssueState.labels -contains 'factory:auditing' -and $candidateIssueState.labels -notcontains 'factory:new')
    $badProposalPath = Join-Path $tmp 'backlog-label-audit-invalid.json'
    @{ considered = @(5); changed = @(@{ issue = 5; added = @('factory:new', 'type:maintenance', 'risk:medium', 'factory:done'); reason = 'invalid multiple states' }); skipped = @() } | ConvertTo-Json -Depth 6 | Set-Content $badProposalPath
    $invalidApply = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $badProposalPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    $candidateIssueState = @((Get-Gh).issues | Where-Object { $_.number -eq 5 })[0]
    Assert 'backlog audit consumer rejects unsupported or conflicting proposal before mutation' ($invalidApply.Code -ne 0 -and $candidateIssueState.labels -contains 'factory:auditing' -and $candidateIssueState.labels -notcontains 'factory:new')
    $revisionState = Get-Gh; $revisionIssue = @($revisionState.issues | Where-Object { $_.number -eq 5 })[0]; $preparedRevision = @((Get-Content -Raw $auditPreparationPath | ConvertFrom-Json).receipts | Where-Object { $_.issue -eq 5 })[0].revision
    $revisionIssue.updatedAt = '2026-10-25T12:34:56.0000000Z'; $revisionState | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $staleRevisionApply = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $auditProposalPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    Assert 'backlog audit consumer rejects changed issue revision with unchanged labels' ($staleRevisionApply.Code -ne 0 -and (Get-Gh).labels -contains 'factory:auditing')
    $revisionState = Get-Gh; $revisionIssue = @($revisionState.issues | Where-Object { $_.number -eq 5 })[0]; $revisionIssue.updatedAt = $preparedRevision; $revisionState | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $apply = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $auditProposalPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    Assert 'backlog audit consumer applies and verifies the allowlisted proposal' ($apply.Code -eq 0 -and (Get-Gh).labels -contains 'factory:new' -and (Get-Gh).labels -contains 'type:maintenance' -and (Get-Gh).labels -contains 'risk:medium' -and (Get-Gh).labels -notcontains 'factory:auditing')
    $applyAgain = Run 'apply-backlog-label-audit.ps1' @{ InputPath = $auditInput; PreparationPath = $auditPreparationPath; ProposalPath = $auditProposalPath; OutputPath = $auditApplicationPath; GhCommand = $gh }
    $receipt = Get-Content -Raw $auditApplicationPath | ConvertFrom-Json
    $candidateReceipt = @($receipt.receipts | Where-Object { $_.issue -eq 5 })[0]
    Assert 'backlog audit consumer recognizes an already-applied effect on retry' ($applyAgain.Code -eq 0 -and $candidateReceipt.alreadyApplied -and $candidateReceipt.status -eq 'verified')

    $recoveryOutput = Join-Path $tmp 'audit-reservation-recovery.json'
    $expired = @{ issue = 5; owner = 'test'; createdAt = '2020-01-01T00:00:00Z'; expiresAt = '2020-01-01T01:00:00Z' } | ConvertTo-Json -Compress
    Set-Gh @('factory:auditing') @("<!-- factory-audit-reservation:5 -->`n$expired")
    $recoveryState = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable
    $recoveryState.issueState = 'OPEN'
    $recoveryState.issues = @(@{ number = 5; title = 'Stale audit'; body = 'audit fixture'; updatedAt = '2020-01-01T00:00:00Z'; labels = @(@{ name = 'factory:auditing' }); url = 'https://github.com/x/y/issues/5' })
    $recoveryState | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $recoveryScript = Join-Path $rp '.ai/factory/scripts/recover-audit-reservations.ps1'
    $recoveryLog = & pwsh -NoProfile -File $recoveryScript -GhCommand $gh -OutputPath $recoveryOutput -SkipRunCheck *>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Host "  recovery diagnostic: $recoveryLog" }
    $recovery = Get-Content -Raw $recoveryOutput | ConvertFrom-Json
    Assert 'audit recovery releases expired reservation' ($LASTEXITCODE -eq 0 -and @($recovery.recovered).Count -eq 1 -and (Get-Gh).labels -notcontains 'factory:auditing')
    Assert 'audit recovery leaves an evidence comment' (@((Get-Gh).comments | Where-Object { $_ -match 'factory-audit-recovery:5' }).Count -eq 1)
    # A stale reservation beside a lifecycle state is released too; the state itself is untouched.
    Set-Gh @('factory:auditing', 'factory:ready') @("<!-- factory-audit-reservation:5 -->`n$expired")
    $recoveryState = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable
    $recoveryState.issueState = 'OPEN'
    $recoveryState.issues = @(@{ number = 5; title = 'Stale audit beside a state'; body = 'audit fixture'; updatedAt = '2020-01-01T00:00:00Z'; labels = @(@{ name = 'factory:auditing' }, @{ name = 'factory:ready' }); url = 'https://github.com/x/y/issues/5' })
    $recoveryState | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_GH_STATE
    $recoveryLog = & pwsh -NoProfile -File $recoveryScript -GhCommand $gh -OutputPath $recoveryOutput -SkipRunCheck *>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Host "  recovery diagnostic: $recoveryLog" }
    $recovery = Get-Content -Raw $recoveryOutput | ConvertFrom-Json
    Assert 'audit recovery releases a stale reservation left beside a lifecycle state and keeps the state' ($LASTEXITCODE -eq 0 -and @($recovery.recovered).Count -eq 1 -and $recovery.recovered[0].lifecycleState -eq 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:auditing' -and (Get-Gh).labels -contains 'factory:ready')

    # Project override fully replaces a factory file, and survives re-sync.
    $ovDir = Join-Path $rp '.ai/factory/overrides/policies'
    New-Item -ItemType Directory $ovDir -Force | Out-Null
    Write-Utf8 (Join-Path $ovDir 'retry.yaml') "max_implementation_retries: 5`nmax_review_fix_rounds: 3`n"
    $ra = @{ ProjectPath = $rp; FactoryPath = $factory }
    Assert 'override: update applies override' ((Run 'update.ps1' $ra).Code -eq 0 -and (Get-Content -Raw (Join-Path $rp '.ai/factory/policies/retry.yaml')) -match 'max_review_fix_rounds: 3')
    Assert 'override: diff clean with override' ((Run 'diff.ps1' $ra).Code -eq 0)
    Assert 'override: verify passes' ((Run 'verify.ps1' $ra).Code -eq 0)
    Set-Gh @('factory:review') @('a <!-- factory:review-round -->', 'b <!-- factory:review-round -->')
    Assert 'override: policy override changes behavior (3 rounds allowed)' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:changes-requested')
    Remove-Item (Join-Path $rp '.ai/factory/overrides') -Recurse
    Assert 'override removal restores factory file' ((Run 'update.ps1' $ra).Code -eq 0 -and (Get-Content -Raw (Join-Path $rp '.ai/factory/policies/retry.yaml')) -match 'max_review_fix_rounds: 2')

    # ---- Automation reconciliation against a mock cockpit ------------------
    Write-Host '== automation sync =='
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $log = Join-Path $tmp 'mock.log'; New-Item -ItemType File $log | Out-Null
    $seed = Join-Path $tmp 'seed.json'
    @(
        @{ id = 'u1'; name = 'My own automation'; enabled = $true; revision = 1 },
        @{ id = 'f-old'; name = '[factory] retired-thing'; enabled = $true; revision = 1; kind = 'github'; task = @{ prompt = 'x' } }
    ) | ConvertTo-Json -Depth 5 | Set-Content $seed
    $srv = Start-Process pwsh -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'mock-cezar.ps1'), '-Port', $port, '-LogFile', $log, '-SeedFile', $seed -PassThru -RedirectStandardOutput (Join-Path $tmp 'mock.out') -RedirectStandardError (Join-Path $tmp 'mock.err')
    try {
        $ready = $false
        for ($i = 0; $i -lt 50 -and -not $ready; $i++) { try { Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations" | Out-Null; $ready = $true } catch { Start-Sleep -Milliseconds 200 } }
        Assert 'mock cockpit is up' $ready
        $sync = Join-Path $rp '.ai/factory/scripts/sync-automations.ps1'
        $sa = @{ ProjectPath = $rp; ApiUrl = "http://127.0.0.1:$port" }
        & pwsh -NoProfile -File $sync @sa -DryRun *>&1 | Out-Null
        Assert 'sync dry-run makes no writes' (-not (Select-String -Path $log -Pattern '^(POST|PUT|DELETE)' -Quiet))
        & pwsh -NoProfile -File $sync @sa *>&1 | Out-Null
        $after = (Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations").automations
        $names = @($after | ForEach-Object { $_.name })
        Assert 'sync creates factory automations' (@($names | Where-Object { $_ -like '`[factory`] *' }).Count -ge 5)
        Assert 'sync leaves unmanaged automation untouched' (($after | Where-Object { $_.id -eq 'u1' }).enabled -eq $true)
        Assert 'sync pauses obsolete factory automation' (($after | Where-Object { $_.id -eq 'f-old' }).enabled -eq $false)
        Assert 'sync does not create maintenance (feature off)' ($names -notcontains '[factory] maintenance')
        Assert 'sync creates paused by default' (-not (($after | Where-Object { $_.name -eq '[factory] needs-plan' }).enabled))
        Clear-Content $log
        & pwsh -NoProfile -File $sync @sa *>&1 | Out-Null
        Assert 'second sync is a no-op' (-not (Select-String -Path $log -Pattern '^(POST|PUT|DELETE)' -Quiet))
        & pwsh -NoProfile -File $sync @sa -Prune *>&1 | Out-Null
        Assert 'prune deletes obsolete factory automation' (-not (@((Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations").automations | ForEach-Object { $_.id }) -contains 'f-old'))
        Assert 'sync records factory version in description' ((Invoke-RestMethod "http://127.0.0.1:$port/api/v1/automations/a100").automation.description -match "cezar-factory $([regex]::Escape($curVer))")
        Clear-Content $log
        & pwsh -NoProfile -File (Join-Path $factory 'scripts/sync-automations.ps1') -SourceOnly -FactoryPath $factory -ApiUrl "http://127.0.0.1:$port" -ProjectId 'remote-only' -DryRun *>&1 | Out-String | Set-Variable plainSync
        $plainCode = $LASTEXITCODE
        $godotSync = & pwsh -NoProfile -File (Join-Path $factory 'scripts/sync-automations.ps1') -SourceOnly -FactoryPath $factory -ApiUrl "http://127.0.0.1:$port" -ProjectId 'remote-godot' -ProjectType godot -DryRun *>&1 | Out-String
        Assert 'godot-upgrade automation is skipped for non-Godot remote targets' ($plainSync -notmatch 'godot-upgrade')
        Assert 'godot-upgrade automation is synced to Godot remote targets' ($godotSync -match 'godot-upgrade')
        $global:LASTEXITCODE = $plainCode
        Assert 'source-only sync works without a project checkout' ($LASTEXITCODE -eq 0 -and -not (Select-String -Path $log -Pattern '^(POST|PUT|DELETE)' -Quiet))
        $remoteTargets = Join-Path $tmp 'remote-targets.json'
        @(@{ apiUrl = "http://127.0.0.1:$port"; projectId = 'remote-only' }) | ConvertTo-Json -Depth 4 | Set-Content $remoteTargets
        $remotePush = & pwsh -NoProfile -File (Join-Path $factory 'scripts/push-factory-updates.ps1') -TargetsPath $remoteTargets -SyncAutomations -DryRun -ReportPath (Join-Path $tmp 'remote-push-release-status.jsonl') *>&1 | Out-String
        $remotePushCode = $LASTEXITCODE
        # Show why it failed: this assertion used to discard the output, which hid a Linux-only failure.
        if ($remotePushCode -ne 0) { Write-Host "push-factory-updates exited ${remotePushCode}:`n$remotePush" }
        Assert 'release supports remote-only target registry entries' ($remotePushCode -eq 0)
    }
    finally { if ($srv -and -not $srv.HasExited) { $srv.Kill() } }


# ---- Shared Factory (stable gate, mounted workflows, migration) -------------
Write-Host '== shared factory =='
$pythonRunner = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } elseif (Get-Command python3.12 -ErrorAction SilentlyContinue) { 'python3.12' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { $null }
if ($pythonRunner) {
$pythonArgs = if ($pythonRunner -eq 'py') { @('-3', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v') } else { @('-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v') }
    Push-Location $factory
    try {
        $pythonOutput = & $pythonRunner @pythonArgs *>&1 | Out-String
        $pythonCode = $LASTEXITCODE
        Write-Host $pythonOutput
        Assert 'Python unit tests pass, including Hindsight provenance contracts' ($pythonCode -eq 0)
    }
    finally { Pop-Location }
} else {
    Assert 'Python 3 is available for release controller tests' $false
}
$bazzCompose = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')
Assert 'Cezar loads Factory workflows and skills from the mounted checkout' ($bazzCompose -match 'CEZ_SHARED_WORKFLOWS_DIRS:.*/workflows' -and $bazzCompose -match 'CEZ_SHARED_SKILL_DIRS:.*/skills')
$autodeploy = Get-Content -Raw (Join-Path $factory 'scripts/deploy/factory-autodeploy.sh')
Assert 'autodeploy only fast-forwards, refuses dirty or diverged checkouts, and never resets' ($autodeploy -match 'merge-base --is-ancestor' -and $autodeploy -match 'BLOCKED' -and $autodeploy -notmatch 'reset --hard|git clean|git stash')
Assert 'autodeploy tracks the tested stable branch' ($autodeploy -match 'FACTORY_DEPLOY_BRANCH:-stable')
Assert 'autodeploy retains the journaled activation coordinator for channel-managed installs' ($autodeploy -match 'factory_activation.py')
Assert 'autodeploy enforces exact source SHA, version and mounted content parity using portable shell syntax' ($autodeploy -match 'container_content_digest' -and $autodeploy -match 'host_content_digest' -and $autodeploy -match 'source_sha.*!=.*container_sha' -and $autodeploy -match '\[ -f config/factory-projects\.json \]')
$legacySync = $autodeploy.IndexOf('sync-all-automations.ps1')
$channelActivation = $autodeploy.IndexOf('factory_activation.py')
Assert 'autodeploy routes legacy Cezar installs to paused automation sync and channel installs to journaled activation' ($legacySync -ge 0 -and $channelActivation -ge 0 -and $autodeploy -match 'printenv CEZ_FACTORY_RELEASE_STORE' -and $autodeploy -match 'channels/\$BRANCH\.json')
$cezarDeploy = Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-cezar-runtime.sh')
Assert 'autodeploy rebuilds changed Cezar source and verifies the managed service and Factory API' ($autodeploy -match 'deploy-cezar-runtime\.sh' -and $cezarDeploy -match 'git .*diff --quiet.*-- cezar/' -and $cezarDeploy -match 'systemctl --user restart' -and $cezarDeploy -match 'CEZAR_RELEASE_URL')
$gitMetadataSync = Get-Content -Raw (Join-Path $factory 'scripts/deploy/reconcile-container-git-metadata.sh')
Assert 'autodeploy repairs only root Git metadata after verifying mounted files and preserves linked worktrees' ($autodeploy -match 'reconcile-container-git-metadata\.sh' -and $gitMetadataSync -match 'git .*ls-tree -r -z' -and $gitMetadataSync -match 'git .*read-tree' -and $gitMetadataSync -match 'update-ref refs/heads/stable' -and $gitMetadataSync -match 'task worktrees')
# The deploy shell tests exercise real control flow (idle gate, deferral, recovery). They were once left out of the
# suite and drifted into failure unnoticed, so run them whenever a POSIX bash (not WSL's launcher) is available.
$shellTestBash = @(Get-Command bash -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'System32' }) | Select-Object -First 1
if (-not $shellTestBash -and (Get-Command git -ErrorAction SilentlyContinue)) {
    # Git for Windows ships a POSIX bash that is often not on PATH in a plain PowerShell session.
    $gitBash = Join-Path (Split-Path (Split-Path (Get-Command git).Source -Parent) -Parent) 'bin/bash.exe'
    if (Test-Path $gitBash) { $shellTestBash = [pscustomobject]@{ Source = $gitBash } }
}
# Skipping these silently is how they drifted into failure before, so a missing bash is a failure.
Assert 'a POSIX bash is available for the deploy shell tests' ([bool]$shellTestBash)
if ($shellTestBash) {
    foreach ($shellTest in 'test-factory-autodeploy.sh', 'test-deploy-cezar-runtime.sh', 'test-reconcile-container-git-metadata.sh', 'test-install-boot-order.sh') {
        $shellOutput = & $shellTestBash.Source (Join-Path $factory "tests/$shellTest") 2>&1
        Assert "deploy shell test passes: $shellTest" ($LASTEXITCODE -eq 0)
        if ($LASTEXITCODE -ne 0) { $shellOutput | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" } }
    }
}
$localPromotion = Get-Content -Raw (Join-Path $factory 'scripts/release/factory_local_scheduler.py')
$localPromotionExample = Get-Content -Raw (Join-Path $factory 'config/local-release-scheduler.json.example')
$promotionUnit = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/factory-local-promotion.service')
$promotionModule = Get-Content -Raw (Join-Path $factory 'scripts/release/factory_promotion.py')
Assert 'local scheduler verifies reviewed dev merges without Actions dispatch' ($promotionModule -match 'reviewDecision' -and $promotionModule -match 'APPROVED' -and $localPromotion -match 'review_decision' -and $localPromotion -notmatch 'gh run|workflow_dispatch|actions/' -and $promotionModule -notmatch 'gh run|workflow_dispatch|actions/')
Assert 'local promotion is single-flight and hardware bounded' ($promotionUnit -match 'CPUQuota=200%' -and $promotionUnit -match 'MemoryMax=8G' -and $promotionUnit -match 'FACTORY_GPU_SLOTS=0' -and $promotionUnit -match 'branch dev')
Assert 'local promotion service uses exact-SHA scheduler' ($promotionUnit -match 'factory_local_scheduler.py run')
$promotionPolicy = Get-Content -Raw (Join-Path $factory 'config/promotion-policy.json') | ConvertFrom-Json
Assert 'promotion defaults to autonomous while retaining the controlled posture for a production run' ($promotionPolicy.promotion.mode -eq 'autonomous' -and $promotionPolicy.promotion.modes.controlled.stable -eq 'approval' -and $promotionPolicy.promotion.modes.autonomous.stable -eq 'auto')
Assert 'promotion policy gates stable on canaries and a circuit breaker, and moves stable only through the fast-forward refs API' (@($promotionPolicy.promotion.canaries.items).Count -ge 2 -and $promotionPolicy.promotion.breaker.maxConsecutiveFailures -ge 1 -and $promotionModule -match 'force=false' -and $promotionModule -match 'git/refs/heads')
Assert 'promotion policy runs the full suite as a required check through the container' (@($promotionPolicy.checks | Where-Object { $_.id -eq 'full-suite' -and $_.required -and ($_.command -join ' ') -match 'validate-in-container\.sh' }).Count -eq 1)
Assert 'promotion service passes the scheduler state root, not the release store the scheduler appends to it' ($promotionUnit -match '--store %h/\.local/share/cezar-factory --config' -and $promotionUnit -notmatch '--store \S*release-store')
Assert 'promotion service reads the committed policy and the promoter may use podman exec' ($promotionUnit -match 'promotion-policy\.json' -and $promotionUnit -notmatch '(?m)^NoNewPrivileges=true')
$validateInContainer = Get-Content -Raw (Join-Path $factory 'scripts/release/validate-in-container.sh')
Assert 'container validation runs the suite in a throwaway worktree of the exact SHA and cleans it up' ($validateInContainer -match 'worktree add' -and $validateInContainer -match 'tests/run-tests\.ps1' -and $validateInContainer -match 'worktree remove' -and $validateInContainer -match 'FACTORY_CANDIDATE_SHA')
Assert 'runtime restarts wait for an idle Cezar, defer with exit 25, and cannot starve' ($cezarDeploy -match 'wait_for_idle' -and $cezarDeploy -match 'exit 25' -and $cezarDeploy -match 'MAX_DEFER' -and $autodeploy -match 'runtime_rc.*25|== 25')
$activationSource = Get-Content -Raw (Join-Path $factory 'scripts/release/factory_activation.py')
Assert 'activation retries reads while a restarting Cezar becomes ready instead of failing at a fixed timeout' ($activationSource -match 'ready_seconds' -and $activationSource -match '_transient')
Assert 'local dev promotion example does not run the full suite on every commit' ($localPromotionExample -notmatch 'tests/run-tests\.ps1|release-wide-suite')

$sg = Join-Path $tmp 'shared'
New-Item -ItemType Directory $sg | Out-Null
$sgOrigin = Join-Path $sg 'origin.git'; $sgWork = Join-Path $sg 'work'
& git init -q --bare $sgOrigin
& git clone -q $sgOrigin $sgWork 2>&1 | Out-Null
foreach ($rel in @('scripts/validate-automation-catalog.ps1', 'routing/automation-catalog.json', 'routing/local-jobs.yaml', 'routing/default.yaml') + @(Get-ChildItem (Join-Path $factory 'automations') -Filter *.json | ForEach-Object { "automations/$($_.Name)" })) {
    New-Item -ItemType Directory -Force (Split-Path (Join-Path $sgWork $rel)) | Out-Null
    Copy-Item (Join-Path $factory $rel) (Join-Path $sgWork $rel)
}
$okTests = Join-Path $sg 'ok.ps1'; $badTests = Join-Path $sg 'bad.ps1'
Set-Content $okTests 'exit 0'; Set-Content $badTests 'exit 1'
$promote = Join-Path $scripts 'release/promote-stable.ps1'
Push-Location $sgWork
try {
    & git config user.email t@example.com; & git config user.name t
    & git checkout -q -b main
    & git add -A; & git commit -q -m one
    function Promote([string]$Tests) { & pwsh -NoProfile -File $promote -FactoryPath $sgWork -TestScript $Tests -ReportPath (Join-Path $sg 'report.jsonl') *>&1 | Out-Null; $LASTEXITCODE }
    Assert 'promote: failing tests never create stable' ((Promote $badTests) -ne 0 -and -not (& git ls-remote --heads origin stable))
    Assert 'promote: passing tests push stable' ((Promote $okTests) -eq 0 -and ((& git ls-remote --heads origin stable) -match (& git rev-parse HEAD)))
    $first = (& git rev-parse HEAD)
    Set-Content 'two.txt' 'two'; & git add -A; & git commit -q -m two
    Assert 'promote: failing tests leave stable on the old commit' ((Promote $badTests) -ne 0 -and ((& git ls-remote --heads origin stable) -match $first))
    Assert 'promote: stable fast-forwards on a later pass' ((Promote $okTests) -eq 0 -and ((& git ls-remote --heads origin stable) -match (& git rev-parse HEAD)))
    & git reset -q --hard $first; Set-Content 'diverged.txt' 'x'; & git add -A; & git commit -q -m diverged
    Assert 'promote: refuses to move stable off its history' ((Promote $okTests) -ne 0)
    Set-Content 'two.txt' 'dirty'
    Assert 'promote: refuses an uncommitted tree' ((Promote $okTests) -ne 0)
}
finally { Pop-Location }

$noRegistry = (& pwsh -NoProfile -File (Join-Path $scripts 'sync-all-automations.ps1') -FactoryPath $factory -RegistryPath (Join-Path $sg 'missing.json') *>&1 | Out-String) -replace '\s*\|\s*', ' ' -replace '\s+', ' '
$noRegistryExit = $LASTEXITCODE
Assert 'sync-all requires explicit target configuration and makes no synchronization' ($noRegistryExit -ne 0 -and $noRegistry -match 'Needs target configuration' -and $noRegistry -match 'nothing was synchronized')
$emptyTargetRegistry = Join-Path $sg 'empty-target-registry.json'
[IO.File]::WriteAllText($emptyTargetRegistry, '[]', [Text.UTF8Encoding]::new($false))
$emptyTargets = & pwsh -NoProfile -File (Join-Path $scripts 'sync-all-automations.ps1') -FactoryPath $factory -RegistryPath $emptyTargetRegistry *>&1 | Out-String
$emptyTargetsExit = $LASTEXITCODE
Assert 'sync-all refuses an empty target registry before contacting projects' ($emptyTargetsExit -ne 0 -and $emptyTargets -match 'Needs target configuration')
$missingUpdateTargets = Join-Path $sg 'missing-update-targets.json'
$missingUpdateReport = Join-Path $tmp 'missing-update-target-report.jsonl'
$noUpdateTarget = & pwsh -NoProfile -File (Join-Path $scripts 'push-factory-updates.ps1') -FactoryPath $factory -TargetsPath $missingUpdateTargets -SyncAutomations -DryRun -ReportPath $missingUpdateReport *>&1 | Out-String
$noUpdateTargetExit = $LASTEXITCODE
Assert 'Factory update requires an explicit target and writes no release receipt' ($noUpdateTargetExit -ne 0 -and $noUpdateTarget -match 'Needs target configuration' -and -not (Test-Path $missingUpdateReport))
$sharedModeProject = Join-Path $sg 'shared-mode-target'
New-Item -ItemType Directory -Path $sharedModeProject -Force | Out-Null
$sharedModeSentinel = Join-Path $sharedModeProject 'keep.txt'
[IO.File]::WriteAllText($sharedModeSentinel, 'unchanged')
$sharedModeTargets = Join-Path $sg 'shared-mode-targets.json'
[IO.File]::WriteAllText($sharedModeTargets, (@([pscustomobject]@{ projectId = 'shared'; projectPath = $sharedModeProject; mode = 'shared'; apiUrl = 'http://127.0.0.1:1' }) | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$sharedModePush = & pwsh -NoProfile -File (Join-Path $scripts 'push-factory-updates.ps1') -FactoryPath $factory -TargetsPath $sharedModeTargets -ReportPath (Join-Path $sg 'shared-mode-report.jsonl') *>&1 | Out-String
$sharedModePushExit = $LASTEXITCODE
Assert 'shared-mode targets refuse managed-file pushes and leave the project unchanged' ($sharedModePushExit -ne 0 -and $sharedModePush -match 'requires -SyncAutomations' -and (Get-Content -Raw $sharedModeSentinel) -eq 'unchanged' -and -not (Test-Path (Join-Path $sharedModeProject '.ai/factory/factory.config.yaml')))

$targetResolutionPaths = @('scripts/sync-all-automations.ps1', 'scripts/push-factory-updates.ps1', 'scripts/onboard-project.ps1', 'scripts/factory-preflight.ps1')
$diskDiscoveryPattern = '(?i)\bGet-ChildItem\b|\bGet-PSDrive\b|\bWin32_LogicalDisk\b|\[IO\.Directory\]::(?:GetLogicalDrives|EnumerateDirectories|GetDirectories)'
foreach ($relative in $targetResolutionPaths) {
    $source = Get-Content -Raw (Join-Path $factory $relative)
    Assert "target resolution does not scan disks ($relative)" ($source -notmatch $diskDiscoveryPattern)
}

$runtimeBoundaryPaths = @('scripts/verify.ps1', 'tests/run-tests.ps1')
foreach ($relative in $runtimeBoundaryPaths) {
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $factory $relative), [ref]$tokens, [ref]$parseErrors)
    $commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
    $liveHostCalls = @($commands | Where-Object { $_.GetCommandName() -in @('ssh', 'ssh.exe', 'podman', 'podman.exe') })
    $liveDeployCalls = @($commands | Where-Object {
        $commandName = $_.GetCommandName()
        $_.Extent.Text -match '(?i)scripts[\\/]deploy[\\/](?:deploy-bazzite|factory-autodeploy|deploy-cezar-runtime)\.(?:sh|ps1|bat)' -and
        $commandName -notin @('Get-Content', 'Assert', 'Join-Path')
    })
    Assert "verification/test entry point has no live host or deployment invocation ($relative)" ($parseErrors.Count -eq 0 -and $liveHostCalls.Count -eq 0 -and $liveDeployCalls.Count -eq 0)
}

$mp = Join-Path $tmp 'migrate-project'
Copy-Item (Join-Path $PSScriptRoot 'fixtures/godot-project') $mp -Recurse
$mcfg = Join-Path $mp '.ai/factory/factory.config.yaml'
[IO.File]::WriteAllText($mcfg, [regex]::Replace([IO.File]::ReadAllText($mcfg), '(?m)^(\s*version:\s*)"\d+\.\d+\.\d+"', "`${1}`"$curVer`""), [Text.UTF8Encoding]::new($false))
Assert 'migrate: fixture installs' ((Run 'install.ps1' @{ ProjectPath = $mp; FactoryPath = $factory }).Code -eq 0 -and (Test-Path (Join-Path $mp '.ai/cezar/workflows/factory-plan.yaml')))
$r = Run 'migrate-to-shared.ps1' @{ ProjectPath = $mp; ProjectId = 'missing'; AuditReceiptPath = (Join-Path $tmp 'missing-audit.json'); FactoryPath = $factory; ReviewArtifactRoot = (Join-Path $tmp 'migration-review') }
Assert 'migrate: missing audit receipt fails before changing the target' ($r.Code -ne 0 -and (Test-Path (Join-Path $mp '.ai/cezar/workflows/factory-plan.yaml')) -and (Test-Path $mcfg))

# ---- Read-only shadow audit ---------------------------------------------
Write-Host '== shadow audit =='
$auditRoot = Join-Path $tmp 'shadow-audit'
New-Item -ItemType Directory -Path $auditRoot -Force | Out-Null
$auditSourceRel = 'skills/factory-work-backlog/SKILL.md'
$auditTargetRel = '.ai/skills/factory-work-backlog/SKILL.md'
$auditSource = Join-Path $factory $auditSourceRel
$auditSharedContent = New-ManagedContent $auditSource $auditSourceRel $curVer
function New-AuditProject([string]$Name, [string]$Content, [string]$SourceRel = 'skills/factory-work-backlog/SKILL.md') {
    $root = Join-Path $auditRoot $Name
    $filePath = Join-Path $root $auditTargetRel
    New-Item -ItemType Directory -Path (Split-Path -Parent $filePath) -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root '.ai/factory') -Force | Out-Null
    [IO.File]::WriteAllText($filePath, $Content, [Text.UTF8Encoding]::new($false))
    $hash = Get-FileTextHash $filePath
    $manifest = [ordered]@{ factory_version = $curVer; files = @([ordered]@{ path = $auditTargetRel; sha256 = $hash }) } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $root '.ai/factory/manifest.json'), $manifest, [Text.UTF8Encoding]::new($false))
    $root
}
function Invoke-ShadowAudit([string]$Name, $Targets, [string]$RegistryOverride = '') {
    $registryPath = if ($RegistryOverride) { $RegistryOverride } else { Join-Path $auditRoot "$Name-targets.json" }
    if ($Targets) { [IO.File]::WriteAllText($registryPath, ([ordered]@{ targets = @($Targets) } | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false)) }
    $receiptPath = Join-Path $auditRoot "$Name-receipt.json"
    $args = @{ RepositoryRoot = $factory; TargetsPath = $registryPath; ReceiptPath = $receiptPath }
    $run = Run 'audit-shadow-copies.ps1' $args
    $receipt = if (Test-Path -LiteralPath $receiptPath) { Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json } else { $null }
    [pscustomobject]@{ Run = $run; Receipt = $receipt; ReceiptPath = $receiptPath }
}
$auditCleanProject = New-AuditProject 'clean' $auditSharedContent
$auditClean = Invoke-ShadowAudit 'clean' @([pscustomobject]@{ projectId = 'clean'; projectPath = $auditCleanProject })
Assert 'shadow audit: identical installed copy is classified as shadowed and path-bound' ($auditClean.Run.Code -eq 0 -and $auditClean.Receipt.targets[0].effectiveSource -eq 'installed' -and $auditClean.Receipt.targets[0].shadowConflict -eq 'identical' -and $auditClean.Receipt.targets[0].migrationStatus -eq 'shadowed' -and $auditClean.Receipt.targets[0].projectPathHash -match '^[a-f0-9]{64}$' -and (Test-Json -Json (Get-Content -Raw $auditClean.ReceiptPath) -SchemaFile (Join-Path $factory 'schemas/shadow-audit-receipt.schema.json')))
Assert 'shadow audit retirement gate stays closed while an installed copy is shadowed' (-not $auditClean.Receipt.legacyPushRetirementReady)
$auditChangedProject = New-AuditProject 'changed' $auditSharedContent
Add-Content (Join-Path $auditChangedProject $auditTargetRel) 'local edit'
$auditChanged = Invoke-ShadowAudit 'changed' @([pscustomobject]@{ projectId = 'changed'; projectPath = $auditChangedProject })
Assert 'shadow audit: edited managed file is classified modified' ($auditChanged.Run.Code -eq 0 -and $auditChanged.Receipt.targets[0].migrationStatus -eq 'modified' -and $auditChanged.Receipt.targets[0].shadowConflict -eq 'modified')
$auditOverrideProject = New-AuditProject 'override' (New-ManagedContent $auditSource 'overrides/skills/factory-work-backlog/SKILL.md' $curVer) 'overrides/skills/factory-work-backlog/SKILL.md'
$auditOverridePath = Join-Path $auditOverrideProject $auditTargetRel
$auditOverrideBefore = (Get-FileTextHash $auditOverridePath)
$auditOverride = Invoke-ShadowAudit 'override' @([pscustomobject]@{ projectId = 'override'; projectPath = $auditOverrideProject })
Assert 'shadow audit: override is identified and preserved' ($auditOverride.Run.Code -eq 0 -and $auditOverride.Receipt.targets[0].effectiveSource -eq 'override' -and $auditOverride.Receipt.targets[0].migrationStatus -eq 'shadowed' -and (Get-FileTextHash $auditOverridePath) -eq $auditOverrideBefore)
$auditMissingProject = Join-Path $auditRoot 'missing-manifest'; New-Item -ItemType Directory -Path $auditMissingProject -Force | Out-Null
$auditMissing = Invoke-ShadowAudit 'missing-manifest' @([pscustomobject]@{ projectId = 'missing'; projectPath = $auditMissingProject })
Assert 'shadow audit: missing manifest is not-installed' ($auditMissing.Run.Code -eq 0 -and $auditMissing.Receipt.targets[0].migrationStatus -eq 'not-installed')
$auditSharedProject = Join-Path $auditRoot 'shared'; New-Item -ItemType Directory -Path $auditSharedProject -Force | Out-Null
$auditShared = Invoke-ShadowAudit 'shared' @([pscustomobject]@{ projectId = 'shared'; projectPath = $auditSharedProject; mode = 'shared' })
Assert 'shadow audit: a shared target with no installed manifest stays shared' ($auditShared.Run.Code -eq 0 -and $auditShared.Receipt.targets[0].effectiveSource -eq 'shared' -and $auditShared.Receipt.targets[0].migrationStatus -eq 'shared')
Assert 'shadow audit retirement gate opens only when every registered target is shared or migrated' ($auditShared.Receipt.legacyPushRetirementReady)
$auditMixed = Invoke-ShadowAudit 'mixed' @([pscustomobject]@{ projectId = 'shared'; projectPath = $auditSharedProject; mode = 'shared' }, [pscustomobject]@{ projectId = 'clean'; projectPath = $auditCleanProject })
Assert 'shadow audit retirement gate stays closed when any registered target is still shadowed' ($auditMixed.Run.Code -eq 0 -and -not $auditMixed.Receipt.legacyPushRetirementReady -and $auditMixed.Receipt.targets.Count -eq 2)
$auditUnreachable = Invoke-ShadowAudit 'unreachable' @([pscustomobject]@{ projectId = 'unreachable'; projectPath = (Join-Path $auditRoot 'absent') })
Assert 'shadow audit: unreachable registered path is reported without path discovery' ($auditUnreachable.Run.Code -eq 0 -and $auditUnreachable.Receipt.targets[0].migrationStatus -eq 'unreachable')
$auditRemote = Invoke-ShadowAudit 'remote' @([pscustomobject]@{ projectId = 'remote'; mode = 'shared' })
Assert 'shadow audit: remote-only target remains unknown' ($auditRemote.Run.Code -eq 0 -and $auditRemote.Receipt.targets[0].effectiveSource -eq 'unknown' -and $auditRemote.Receipt.targets[0].migrationStatus -eq 'unknown')
Assert 'shadow audit retirement gate stays closed for unknown remote-only targets' (-not $auditRemote.Receipt.legacyPushRetirementReady)
$auditNoRegistry = Invoke-ShadowAudit 'no-registry' $null (Join-Path $auditRoot 'not-configured.json')
Assert 'shadow audit: missing registry requests target configuration and writes a valid receipt' ($auditNoRegistry.Run.Code -eq 0 -and $auditNoRegistry.Receipt.status -eq 'needs-target-configuration' -and (Test-Json -Json (Get-Content -Raw $auditNoRegistry.ReceiptPath) -SchemaFile (Join-Path $factory 'schemas/shadow-audit-receipt.schema.json')))
Assert 'legacy push remains installed while any registered target is unverified' ((Get-Content -Raw (Join-Path $factory 'scripts/push-factory-updates.ps1')) -match 'Deprecated' -and -not $auditNoRegistry.Receipt.legacyPushRetirementReady)

Write-Host '== shadow migration =='
$migrationReviewRoot = Join-Path $auditRoot 'migration-review'
$migrationPlanRun = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditCleanProject; ProjectId = 'clean'; AuditReceiptPath = $auditClean.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot }
$migrationPlan = $migrationPlanRun.Out | ConvertFrom-Json
Assert 'migration dry-run plans only receipt-approved identical files and leaves target intact' ($migrationPlanRun.Code -eq 0 -and $migrationPlan.status -eq 'ready' -and $migrationPlan.removable.Count -eq 1 -and (Test-Path (Join-Path $auditCleanProject $auditTargetRel)))
$migrationPathMismatch = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditChangedProject; ProjectId = 'clean'; AuditReceiptPath = $auditClean.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot }
Assert 'migration refuses a receipt paired with a different checkout path' ($migrationPathMismatch.Code -ne 0)
$migrationMissingManifest = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditMissingProject; ProjectId = 'missing'; AuditReceiptPath = $auditMissing.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot }
Assert 'migration refuses a target without a manifest' ($migrationMissingManifest.Code -ne 0)
$migrationModifiedRun = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditChangedProject; ProjectId = 'changed'; AuditReceiptPath = $auditChanged.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot }
$migrationModified = $migrationModifiedRun.Out | ConvertFrom-Json
Assert 'migration keeps locally modified files and writes a review diff' ($migrationModifiedRun.Code -eq 0 -and $migrationModified.status -eq 'no-safe-files' -and $migrationModified.retained -eq 1 -and $migrationModified.reviewDiffs.Count -eq 1 -and (Test-Path $migrationModified.reviewDiffs[0].diffPath) -and (Test-Path (Join-Path $auditChangedProject $auditTargetRel)))
$migrationOverrideRun = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditOverrideProject; ProjectId = 'override'; AuditReceiptPath = $auditOverride.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot }
$migrationOverride = $migrationOverrideRun.Out | ConvertFrom-Json
Assert 'migration retains namespaced overrides' ($migrationOverrideRun.Code -eq 0 -and $migrationOverride.status -eq 'no-safe-files' -and $migrationOverride.retained -eq 1 -and (Get-FileTextHash $auditOverridePath) -eq $auditOverrideBefore)
$migrationUnknownRun = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditRemote.ReceiptPath; ProjectId = 'remote'; AuditReceiptPath = $auditRemote.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot }
Assert 'migration refuses remote-only targets' ($migrationUnknownRun.Code -ne 0)

# Exercise the mutation path only against a local bare remote and a fake gh executable.
$migrationOrigin = Join-Path $auditRoot 'migration-origin.git'
& git init -q --bare $migrationOrigin
& git -C $auditCleanProject init -q -b dev
& git -C $auditCleanProject config user.email 'factory-test@example.invalid'
& git -C $auditCleanProject config user.name 'Factory Test'
New-Item -ItemType Directory -Path (Join-Path $auditCleanProject '.ai/factory') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $auditCleanProject '.ai/factory/factory.config.yaml'), "factory:`n  source: installed`n", [Text.UTF8Encoding]::new($false))
& git -C $auditCleanProject add -A
& git -C $auditCleanProject commit -q -m 'Fixture base'
& git -C $auditCleanProject remote add origin $migrationOrigin
& git -C $auditCleanProject push -q -u origin dev
if ($IsWindows) {
    $fakeGh = Join-Path $auditRoot 'fake-gh.cmd'
    $fakeGhBody = @(
        '@echo off',
        'if %FAKE_GH_FAIL%==1 (echo simulated failure& exit /b 1)',
        'if %1==pr if %2==create (echo https://github.com/example/project/pull/1& exit /b 0)',
        'exit /b 2'
    ) -join "`r`n"
    [IO.File]::WriteAllText($fakeGh, $fakeGhBody, [Text.Encoding]::ASCII)
} else {
    # The Linux promotion container runs this suite too; a .cmd file cannot execute there.
    $fakeGh = Join-Path $auditRoot 'fake-gh.sh'
    $fakeGhBody = @(
        '#!/bin/sh',
        'if [ "$FAKE_GH_FAIL" = "1" ]; then echo "simulated failure"; exit 1; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo https://github.com/example/project/pull/1; exit 0; fi',
        'exit 2'
    ) -join "`n"
    [IO.File]::WriteAllText($fakeGh, $fakeGhBody + "`n", [Text.UTF8Encoding]::new($false))
    & chmod +x $fakeGh
}
$env:FAKE_GH_FAIL = '0'
$migrationPrRun = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditCleanProject; ProjectId = 'clean'; AuditReceiptPath = $auditClean.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot; GhCommand = $fakeGh; CreatePullRequest = $true }
$migrationPr = $migrationPrRun.Out | ConvertFrom-Json
$baseTargetHash = Get-FileTextHash (Join-Path $auditCleanProject $auditTargetRel)
Assert 'migration PR uses a separate branch and leaves the original checkout clean' ($migrationPrRun.Code -eq 0 -and $migrationPr.status -eq 'pr-open' -and $migrationPr.pullRequest -eq 'https://github.com/example/project/pull/1' -and (Test-Path (Join-Path $auditCleanProject $auditTargetRel)) -and -not (git -C $auditCleanProject status --porcelain))
$migratedTreeEntry = (& git -C $auditCleanProject ls-tree $migrationPr.branch -- $auditTargetRel | Out-String).Trim()
$backoutJson = (& git -C $auditCleanProject show "$($migrationPr.branch):.ai/factory/migration-backout.json" | Out-String)
$backoutValid = $false
try { $backoutValid = Test-Json -Json $backoutJson -SchemaFile (Join-Path $factory 'schemas/shadow-migration-backout.schema.json') } catch { }
Assert 'migration branch removes only selected files and carries a valid pre-deletion backout record' (-not $migratedTreeEntry -and $backoutValid -and $migrationPr.removedFiles.Count -eq 1)
$restoreWorktree = Join-Path $auditRoot 'migration-restore-worktree'
& git -C $auditCleanProject worktree add -q --detach $restoreWorktree $migrationPr.branch
$backout = $backoutJson | ConvertFrom-Json
& git -C $restoreWorktree restore --source $backout.baseSha -- $auditTargetRel
$restoredHash = Get-FileTextHash (Join-Path $restoreWorktree $auditTargetRel)
& git -C $auditCleanProject worktree remove --force $restoreWorktree
Assert 'migration backout command source restores the exact removed file hash' ($restoredHash -eq $baseTargetHash)
$dirtyMarker = Join-Path $auditCleanProject 'untracked-local-edit.txt'
[IO.File]::WriteAllText($dirtyMarker, 'keep me', [Text.UTF8Encoding]::new($false))
$dirtyMigration = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditCleanProject; ProjectId = 'clean'; AuditReceiptPath = $auditClean.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot; GhCommand = $fakeGh; CreatePullRequest = $true }
Assert 'migration refuses a dirty checkout without changing its managed files' ($dirtyMigration.Code -ne 0 -and (Test-Path $dirtyMarker) -and (Test-Path (Join-Path $auditCleanProject $auditTargetRel)))
Remove-Item -LiteralPath $dirtyMarker -Force
$env:FAKE_GH_FAIL = '1'
$failedPrMigration = Run 'migrate-to-shared.ps1' @{ ProjectPath = $auditCleanProject; ProjectId = 'clean'; AuditReceiptPath = $auditClean.ReceiptPath; FactoryPath = $factory; ReviewArtifactRoot = $migrationReviewRoot; GhCommand = $fakeGh; CreatePullRequest = $true }
Remove-Item Env:FAKE_GH_FAIL -ErrorAction SilentlyContinue
Assert 'migration PR failure leaves the original checkout unchanged' ($failedPrMigration.Code -ne 0 -and (Test-Path (Join-Path $auditCleanProject $auditTargetRel)) -and -not (git -C $auditCleanProject status --porcelain))
$migrationWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/migrate-to-shared.yaml')
Assert 'migration workflow owns the audit and migration script command steps' ($migrationWorkflow -match 'command:.*audit-shadow-copies\.ps1' -and $migrationWorkflow -match 'command:.*migrate-to-shared\.ps1' -and $migrationWorkflow -match 'CreatePullRequest')

# ---- Godot upgrade -------------------------------------------------------
Write-Host '== godot upgrade =='
$godotDockerfile = Get-Content -Raw (Join-Path $factory 'cezar/Dockerfile')
Assert 'Cezar image maps GODOT_BIN to the version selector' ($godotDockerfile -match 'GODOT_BIN=/usr/local/bin/godot' -and $godotDockerfile -match 'godot-select\.sh' -and $godotDockerfile -match 'GODOT_VERSIONS_DIR')
Assert 'Godot versions live on a persistent volume in both compose files' ((Get-Content -Raw (Join-Path $factory 'cezar/compose.yaml')) -match 'godot-versions:/opt/godot-versions' -and (Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')) -match 'godot-versions:/opt/godot-versions')
Assert 'godot-upgrade automation is gated to Godot projects' ((Get-Content -Raw (Join-Path $factory 'automations/godot-upgrade.json')) -match '"projectType":\s*"godot"')

$gd = Join-Path $tmp 'godot'
New-Item -ItemType Directory $gd | Out-Null
$origin = Join-Path $gd 'origin.git'
$work = Join-Path $gd 'work'
& git init -q --bare $origin
& git clone -q $origin $work 2>&1 | Out-Null
Push-Location $work
try {
    & git config user.email t@example.com; & git config user.name t
    & git checkout -q -b main
    New-Item -ItemType Directory -Force '.ai/factory' | Out-Null
    Set-Content '.ai/factory/factory.config.yaml' "godot:`n  testCommand: `"exit 0`"`n"
    Set-Content '.godot-version' '4.7-stable'
    & git add -A; & git commit -q -m init; & git push -q -u origin main 2>&1 | Out-Null
    & git remote set-head origin main 2>&1 | Out-Null
    $installer = Join-Path $gd 'fake-install.ps1'
    Set-Content $installer 'Write-Output "/fake/$($args[0])/godot"'
    $up = Join-Path $scripts 'godot-upgrade.ps1'
    function GodotStep([string]$Step, [string[]]$More = @()) {
        $out = & pwsh -NoProfile -File $up -Step $Step -InstallCommand $installer @More 2>&1 | Out-String
        [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
    }

    $r = GodotStep check @('-LatestTag', '4.7-stable')
    Assert 'godot check: same version is a no-op' ($r.Code -eq 0 -and (Get-Content -Raw .factory/godot-upgrade.json | ConvertFrom-Json).status -eq 'none')
    $r = GodotStep check @('-LatestTag', '4.8-rc1')
    Assert 'godot check: prerelease is ignored' ((Get-Content -Raw .factory/godot-upgrade.json | ConvertFrom-Json).status -eq 'none')
    $r = GodotStep check @('-LatestTag', '4.8-stable')
    Assert 'godot check: newer stable is an upgrade' ((Get-Content -Raw .factory/godot-upgrade.json | ConvertFrom-Json).status -eq 'upgrade')
    $r = GodotStep stage
    Assert 'godot stage installs the target version' ($r.Code -eq 0 -and (Get-Content -Raw .factory/godot-upgrade.json | ConvertFrom-Json).godotBin -eq '/fake/4.8-stable/godot')
    $r = GodotStep apply
    Assert 'godot apply pins the version on a pushed branch' ($r.Code -eq 0 -and (Get-Content -Raw .godot-version).Trim() -eq '4.8-stable' -and (& git ls-remote --heads origin factory/godot-4.8))
    $r = GodotStep test @('-AllowFailure')
    Assert 'godot test passes with the project command' ($r.Code -eq 0 -and (Get-Content -Raw .factory/godot-test.json | ConvertFrom-Json).passed)
    Set-Content '.ai/factory/factory.config.yaml' "godot:`n  testCommand: `"exit 3`"`n"
    $r = GodotStep test @('-AllowFailure')
    Assert 'godot test -AllowFailure records a failure without failing the step' ($r.Code -eq 0 -and -not (Get-Content -Raw .factory/godot-test.json | ConvertFrom-Json).passed)
    $r = GodotStep test
    Assert 'godot test fails the step when tests fail (drives the fix retry)' ($r.Code -ne 0)
    $r = GodotStep publish
    Assert 'godot publish refuses when tests failed' ($r.Code -ne 0)
    Set-Content '.ai/factory/factory.config.yaml' "godot:`n  testCommand: `"exit 0`"`n"
    Set-Content 'fix.gd' 'extends Node'
    GodotStep test | Out-Null

    $ghState = Join-Path $gd 'gh.json'
    Set-Content $ghState '{"labels":[],"comments":[],"issues":[]}'
    $env:FAKE_GH_STATE = $ghState
    $fakePr = Join-Path $gd 'fake-gh-pr.ps1'
    Set-Content $fakePr @'
$a = @($args)
if ($a[0] -eq 'pr' -and $a[1] -eq 'create') { 'https://github.com/x/y/pull/7'; exit 0 }
if ($a[0] -eq 'pr' -and $a[1] -eq 'merge') { exit 0 }
Write-Error "unsupported $($a -join ' ')"; exit 2
'@
    $r = GodotStep publish @('-GhCommand', $fakePr)
    $published = Get-Content -Raw .factory/godot-upgrade-result.json | ConvertFrom-Json
    Assert 'godot publish opens a PR with auto-merge and commits the fixes' ($r.Code -eq 0 -and $published.pr -match '/pull/7' -and $published.autoMerge -and ((& git show --stat --format=%s HEAD) -join ' ') -match 'Adapt to Godot 4.8-stable')
    Remove-Item Env:FAKE_GH_STATE -ErrorAction SilentlyContinue
    $r = GodotStep check @('-LatestTag', '4.8-stable')
    Assert 'godot check: an existing upgrade branch suppresses re-attempts' ((Get-Content -Raw .factory/godot-upgrade.json | ConvertFrom-Json).status -eq 'none')
}
finally { Pop-Location }
}
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host '== project validation adapters =='
$adapterOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'validation-adapters.ps1') 2>&1 | Out-String
Write-Host $adapterOutput
Assert 'configured project validation adapters pass fixture cases' ($LASTEXITCODE -eq 0)

Write-Host '== change impact collector =='
$impactOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'collect-impact.ps1') 2>&1 | Out-String
Write-Host $impactOutput
Assert 'change impact collector handles merge-base diffs, ownership, renames and invalid inputs' ($LASTEXITCODE -eq 0)

Write-Host '== Godot dependency graph =='
$godotImpactOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'godot-impact.ps1') 2>&1 | Out-String
Write-Host $godotImpactOutput
Assert 'Godot dependency graph fixtures pass' ($LASTEXITCODE -eq 0)

Write-Host '== bounded failure audit =='
$failureAuditOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'failure-audit-bounds.ps1') 2>&1 | Out-String
Write-Host $failureAuditOutput
Assert 'failure collector obeys identity and read budgets' ($LASTEXITCODE -eq 0)

Write-Host '== failure summary =='
$failureSummaryOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'failure-summary.ps1') 2>&1 | Out-String
Write-Host $failureSummaryOutput
Assert 'failure summary dedups, caps, redacts and orders deterministically' ($LASTEXITCODE -eq 0)

Write-Host '== failure audit publication =='
$publisherOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'failure-audit-publisher.ps1') 2>&1 | Out-String
Write-Host $publisherOutput
Assert 'failure publisher is idempotent, bounded, and fail-closed' ($LASTEXITCODE -eq 0)

Write-Host '== health report =='
$healthOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'health-report.ps1') 2>&1 | Out-String
Write-Host $healthOutput
Assert 'health report summarizes artifacts and tolerates missing inputs' ($LASTEXITCODE -eq 0)
$healthWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/health.yaml')
Assert 'health workflow runs no agent and its startup preflights every script it runs' ($healthWorkflow -notmatch '(?m)^\s+(skill|prompt):' -and @('audit-factory-failures','publish-failure-audit','collect-backlog-snapshot','reconcile-backlog','write-health-report' | Where-Object { $healthWorkflow -notmatch "-RequiredScripts [^\r\n]*$_\.ps1" }).Count -eq 0)
Assert 'retired failure-audit, backlog-reconciliation, and dead skills are gone' (-not (Test-Path (Join-Path $factory 'workflows/failure-audit.yaml')) -and -not (Test-Path (Join-Path $factory 'workflows/backlog-reconciliation.yaml')) -and -not (Test-Path (Join-Path $factory 'skills/factory-failure-audit')) -and -not (Test-Path (Join-Path $factory 'skills/factory-intake')) -and -not (Test-Path (Join-Path $factory 'skills/factory-implement-prepare')))
Write-Host '== governance guard =='
$govOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'protect-governance.ps1') 2>&1 | Out-String
Write-Host $govOutput
Assert 'governance guard blocks policy, baseline, check-selection and ledger-evidence changes and rejects forged waivers' ($LASTEXITCODE -eq 0)
$govMissing = @('implement', 'fix-review' | Where-Object {
    $wf = Get-Content -Raw (Join-Path $factory "workflows/$_.yaml")
    $at = $wf.IndexOf('protect-governance.ps1', $wf.IndexOf('id: protect-governance'))
    ($wf -notmatch '-RequiredScripts [^\r\n]*factory/protect-governance\.ps1') -or $at -lt 0 -or $at -gt $wf.IndexOf('id: targeted-tests')
})
Assert "implement and fix-review run the governance guard before targeted tests ($($govMissing -join ', '))" ($govMissing.Count -eq 0)
Write-Host '== verification query layer =='
$vqOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verification-query.ps1') 2>&1 | Out-String
Write-Host $vqOutput
Assert 'verification query layer: pagination, redaction, ordering, oversized artifacts, byte-identical output and schema validation' ($LASTEXITCODE -eq 0)
Write-Host '== model endpoint preflight =='
$probeOutput = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'model-probe.ps1') 2>&1 | Out-String
Write-Host $probeOutput
Assert 'model probe fails fast on a host that is up but not generating, retries transients, and never leaks the key' ($LASTEXITCODE -eq 0)
$agentWorkflows = @('implement', 'investigate', 'plan', 'review', 'fix-review', 'maintenance', 'environment-analysis', 'godot-upgrade')
$unprobed = @($agentWorkflows | Where-Object {
    $wf = Get-Content -Raw (Join-Path $factory "workflows/$_.yaml")
    # The probe must run after startup and before the first agent step, and startup must preflight the script.
    $probeAt = $wf.IndexOf('probe-model-endpoint.ps1', $wf.IndexOf('id: model-check'))
    $agentAt = [regex]::Match($wf, '(?m)^\s+(skill|prompt):').Index
    ($wf -notmatch 'id: model-check') -or ($wf -notmatch '-RequiredScripts [^\r\n]*probe-model-endpoint\.ps1') -or $probeAt -lt 0 -or $probeAt -gt $agentAt
})
Assert "every agent workflow probes the model endpoint before its first agent step ($($unprobed -join ', '))" ($unprobed.Count -eq 0)
$maintenanceText = Get-Content -Raw (Join-Path $factory 'workflows/maintenance.yaml')
Assert 'maintenance runs its watchdog and housekeeping before the model probe, so a model outage cannot disable the stuck-run backstop' ($maintenanceText.IndexOf('id: watchdog') -ge 0 -and $maintenanceText.IndexOf('id: watchdog') -lt $maintenanceText.IndexOf('id: model-check') -and $maintenanceText.IndexOf('id: intake-route') -lt $maintenanceText.IndexOf('id: model-check'))
$promScrape = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/prometheus.yml')
$promAlerts = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/prometheus-alerts.yml')
$promCompose = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')
$deployBazzite = Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')
Assert 'the authenticated vLLM scrape has its token mounted and rendered by the deploy, so Prometheus never loses a credentials file' ($promScrape -match 'credentials_file: /etc/prometheus/vllm-token' -and $promCompose -match 'prometheus-vllm-token\.generated:/etc/prometheus/vllm-token' -and $deployBazzite -match 'prometheus-vllm-token\.generated' -and $deployBazzite -match 'vllm_scrape_key:-unset')
Assert 'model-host alerts cover running-but-not-generating, queue backlog, KV saturation, preemption, and missing metrics' (@('ModelHostNotGenerating', 'ModelHostQueueBacklog', 'ModelHostKvCacheSaturated', 'ModelHostPreempting', 'ModelHostMetricsMissing' | Where-Object { $promAlerts -notmatch "alert: $_" }).Count -eq 0 -and $promAlerts -match 'vllm:generation_tokens_total')
$standaloneProm = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/standalone/prometheus.yml')
$standaloneUnit = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/standalone/factory-prometheus.container.template')
$standaloneDeploy = Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-prometheus-standalone.sh')
Assert 'standalone Prometheus scrapes only targets that really export metrics (not Cezar, whose /metrics is the HTML shell), with the model-host bearer token' ($standaloneProm -notmatch '(?m)^\s+- job_name: cezar' -and $standaloneProm -match 'job_name: hindsight' -and $standaloneProm -match 'credentials_file: /etc/prometheus/vllm-token' -and @('openhands', 'grafana', 'node-exporter', 'cadvisor', 'vault', 'langfuse' | Where-Object { $standaloneProm -match "job_name: $_" }).Count -eq 0)
Assert 'standalone Prometheus unit starts at boot, restarts on failure, and listens on loopback only' ($standaloneUnit -match '(?m)^WantedBy=default\.target' -and $standaloneUnit -match '(?m)^Restart=always' -and $standaloneUnit -match 'web\.listen-address=127\.0\.0\.1:9090' -and $standaloneUnit -match '(?m)^Network=host')
Assert 'standalone Prometheus deploy validates with promtool, guards the compose-era container, and refuses to claim boot persistence without linger' ($standaloneDeploy -match 'promtool' -and $standaloneDeploy -match 'check config' -and $standaloneDeploy -match 'update --restart=no cezar-factory-prometheus' -and $standaloneDeploy -match 'Linger' -and $standaloneDeploy -match 'validate-only')
$blackboxCfg = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/standalone/blackbox.yml')
$blackboxUnit = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/standalone/factory-blackbox.container.template')
Assert 'liveness probes check the response body, so the cockpit HTML-200 catch-all cannot read as healthy' ($blackboxCfg -match 'cezar_health' -and $blackboxCfg -match "fail_if_body_not_matches_regexp:\s+- '\^\\{`"version`":'" -and $blackboxCfg -match 'application/json' -and $blackboxCfg -match 'litellm_ready' -and $blackboxCfg -match 'readiness' -and $blackboxCfg -match 'db.*connected')
Assert 'Prometheus probes Cezar and LiteLLM through the blackbox exporter and alerts on failure, slowness, and silence' ($standaloneProm -match 'job_name: liveness-cezar' -and $standaloneProm -match 'job_name: liveness-litellm' -and $standaloneProm -match '127\.0\.0\.1:9115' -and $standaloneProm -match 'api/v1/health' -and $standaloneProm -match 'health/readiness' -and @('FactoryEndpointDown', 'FactoryEndpointSlow', 'FactoryLivenessProbeMissing' | Where-Object { $promAlerts -notmatch "alert: $_" }).Count -eq 0)
Assert 'the blackbox exporter is a boot-persistent loopback unit that Prometheus starts after, and the deploy validates it' ($blackboxUnit -match '(?m)^WantedBy=default\.target' -and $blackboxUnit -match '(?m)^Restart=always' -and $blackboxUnit -match 'web\.listen-address=127\.0\.0\.1:9115' -and $standaloneUnit -match 'After=[^\r\n]*factory-blackbox\.service' -and $standaloneDeploy -match 'config\.check' -and $standaloneDeploy -match 'probe_success')
# ---- Reviewed baseline promotion and anti-weakening guard (hermetic: temp dirs only) ----
Write-Host '== baseline promotion =='
$bpRoot = Join-Path ([IO.Path]::GetTempPath()) "bp-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $bpRoot | Out-Null
try {
    $bpPolicy = Join-Path $bpRoot 'policy.json'
    '{"version":1,"permittedApprovers":["alice"],"auditLog":"audit.jsonl","protectedPaths":["policy.json","audit.jsonl"],"baselinePaths":["baselines/*.json"],"mandatoryChecks":["tests"],"thresholdFloors":{"coverage":70}}' | Set-Content $bpPolicy
    $bpCand = Join-Path $bpRoot 'cand.json'
    '{"thresholds":{"coverage":80},"checks":{"tests":{"mandatory":true,"level":"error"}}}' | Set-Content $bpCand
    $bpBase = Join-Path $bpRoot 'baseline.json'; '{"thresholds":{"coverage":80}}' | Set-Content $bpBase
    $bpAudit = Join-Path $bpRoot 'audit.jsonl'
    $baseDigest = (Get-FileHash $bpBase -Algorithm SHA256).Hash
    function New-Review([string]$Name, $Data) { $p = Join-Path $bpRoot $Name; if ($null -ne $Data) { $Data | ConvertTo-Json | Set-Content $p }; $p }
    function Promote($Rev) { Run 'promote-baseline.ps1' @{ Candidate = $bpCand; Baseline = $bpBase; Review = $Rev; Policy = $bpPolicy; AuditLog = $bpAudit } }
    $good = @{ approver = 'alice'; changeAuthor = 'agent'; reviewRef = 'pr#1-review'; sourceRun = 'run-1' }
    $rUnrev = Promote (Join-Path $bpRoot 'missing-review.json')
    $rSelf = Promote (New-Review 'self.json' @{ approver = 'alice'; changeAuthor = 'Alice'; reviewRef = 'x'; sourceRun = 'r' })
    $rUnperm = Promote (New-Review 'unperm.json' @{ approver = 'mallory'; changeAuthor = 'agent'; reviewRef = 'x'; sourceRun = 'r' })
    $rNoRef = Promote (New-Review 'noref.json' @{ approver = 'alice'; changeAuthor = 'agent'; sourceRun = 'r' })
    Assert 'unreviewed, self-approved, unpermitted and ref-less promotions are rejected' ($rUnrev.Code -eq 1 -and $rSelf.Code -eq 1 -and $rUnperm.Code -eq 1 -and $rNoRef.Code -eq 1)
    Assert 'rejected promotions change neither baseline nor audit log' ((Get-FileHash $bpBase -Algorithm SHA256).Hash -eq $baseDigest -and -not (Test-Path $bpAudit))
    $rOk = Promote (New-Review 'good.json' $good)
    $auditLines = @(Get-Content $bpAudit)
    $auditEntry = if ($auditLines.Count) { $auditLines[0] | ConvertFrom-Json } else { $null }
    Assert 'reviewed promotion updates the baseline and writes exactly one audit entry' ($rOk.Code -eq 0 -and $auditLines.Count -eq 1 -and (Get-Content -Raw $bpBase) -eq (Get-Content -Raw $bpCand) -and $auditEntry.approver -eq 'alice' -and $auditEntry.reviewRef -eq 'pr#1-review' -and $auditEntry.sourceRun -eq 'run-1' -and $auditEntry.baselineBeforeDigest -eq $baseDigest.ToLower() -and $auditEntry.baselineAfterDigest -eq (Get-FileHash $bpCand -Algorithm SHA256).Hash.ToLower() -and $auditEntry.timestamp)

    # Weakening guard over base/head directories.
    function New-Tree([string]$Name) {
        $d = Join-Path $bpRoot $Name; New-Item -ItemType Directory -Force (Join-Path $d 'baselines') | Out-Null
        Copy-Item $bpPolicy (Join-Path $d 'policy.json'); '' | Set-Content (Join-Path $d 'audit.jsonl') -NoNewline
        '{"thresholds":{"coverage":80},"checks":{"tests":{"mandatory":true,"level":"error"}},"suppressions":[]}' | Set-Content (Join-Path $d 'rules.json')
        '{"thresholds":{"coverage":80}}' | Set-Content (Join-Path $d 'baselines/main.json')
        $d
    }
    function Guard($Head) { Run 'check-weakening.ps1' @{ BaseDir = $bpGuardBase; HeadDir = $Head; Policy = 'policy.json' } }
    $bpGuardBase = New-Tree 'base'
    $h0 = New-Tree 'h-same'; $g0 = Guard $h0
    Assert 'guard passes an unchanged tree' ($g0.Code -eq 0)
    $h1 = New-Tree 'h-lower'; '{"thresholds":{"coverage":50},"checks":{"tests":{"mandatory":true,"level":"error"}},"suppressions":[]}' | Set-Content (Join-Path $h1 'rules.json'); $g1 = Guard $h1
    Assert 'guard fails a lowered threshold and names it' ($g1.Code -eq 1 -and $g1.Out -match 'rules\.json/thresholds/coverage: threshold lowered from 80 to 50')
    $h2 = New-Tree 'h-rmcheck'; '{"thresholds":{"coverage":80},"checks":{},"suppressions":[]}' | Set-Content (Join-Path $h2 'rules.json'); $g2 = Guard $h2
    Assert 'guard fails removal of a mandatory check' ($g2.Code -eq 1 -and $g2.Out -match 'tests: mandatory check removed')
    $h2b = New-Tree 'h-downgrade'; '{"thresholds":{"coverage":80},"checks":{"tests":{"mandatory":true,"level":"warn"}},"suppressions":[]}' | Set-Content (Join-Path $h2b 'rules.json'); $g2b = Guard $h2b
    Assert 'guard fails a downgraded check level' ($g2b.Code -eq 1 -and $g2b.Out -match "downgraded from 'error' to 'warn'")
    $h3 = New-Tree 'h-suppress'; '{"thresholds":{"coverage":80},"checks":{"tests":{"mandatory":true,"level":"error"}},"suppressions":["tests/flaky"]}' | Set-Content (Join-Path $h3 'rules.json'); $g3 = Guard $h3
    Assert 'guard fails an added suppression' ($g3.Code -eq 1 -and $g3.Out -match 'suppression added')
    $h4 = New-Tree 'h-policy'; '{"version":1,"permittedApprovers":["agent"],"auditLog":"audit.jsonl","protectedPaths":[],"baselinePaths":[]}' | Set-Content (Join-Path $h4 'policy.json'); $g4 = Guard $h4
    Assert 'guard fails an edit to a protected path (the policy itself)' ($g4.Code -eq 1 -and $g4.Out -match 'policy\.json: protected path edited')
    $h5 = New-Tree 'h-baseline'; '{"thresholds":{"coverage":10}}' | Set-Content (Join-Path $h5 'baselines/main.json'); $g5 = Guard $h5
    Assert 'guard fails a baseline edit without an authorized promotion' ($g5.Code -eq 1 -and $g5.Out -match 'baseline edited without an authorized promotion')
    $h6 = New-Tree 'h-corrupt'; '{not json' | Set-Content (Join-Path $h6 'rules.json'); $g6 = Guard $h6
    Assert 'guard fails closed on an unparseable changed file' ($g6.Code -eq 2)

    # Authorized promotion: baseline plus matching audit entry (produced by the real promote script).
    $h7 = New-Tree 'h-promoted'
    $null = Run 'promote-baseline.ps1' @{ Candidate = $bpCand; Baseline = (Join-Path $h7 'baselines/main.json'); Review = (Join-Path $bpRoot 'good.json'); Policy = $bpPolicy; AuditLog = (Join-Path $h7 'audit.jsonl') }
    $g7 = Guard $h7
    Assert 'guard accepts a reviewed promotion (baseline change plus matching audit entry)' ($g7.Code -eq 0)
    $h8 = New-Tree 'h-audit-rewrite'; Copy-Item (Join-Path $h7 'audit.jsonl') (Join-Path $h8 'audit.jsonl'); Copy-Item (Join-Path $h7 'baselines/main.json') (Join-Path $h8 'baselines/main.json')
    $bpGuardBase = $h7
    $h9 = New-Tree 'h-audit-tamper'; Copy-Item (Join-Path $h7 'baselines/main.json') (Join-Path $h9 'baselines/main.json')
    ((Get-Content -Raw (Join-Path $h7 'audit.jsonl')) -replace 'alice', 'agent') | Set-Content (Join-Path $h9 'audit.jsonl') -NoNewline
    $g9 = Guard $h9
    Assert 'guard fails a rewritten audit entry' ($g9.Code -eq 1 -and $g9.Out -match 'removed or rewritten')
    $h10 = New-Tree 'h-audit-empty'; Copy-Item (Join-Path $h7 'baselines/main.json') (Join-Path $h10 'baselines/main.json')
    $g10 = Guard $h10
    Assert 'guard fails removal of all audit entries' ($g10.Code -eq 1 -and $g10.Out -match 'removed or rewritten')
}
finally { Remove-Item -LiteralPath $bpRoot -Recurse -Force -ErrorAction SilentlyContinue }
$implementText = Get-Content -Raw (Join-Path $factory 'workflows/implement.yaml')
Assert 'implement workflow runs the weakening guard from a command step after its changes' ($implementText -match 'id: weakening-guard' -and $implementText -match 'check-weakening\.ps1' -and $implementText.IndexOf('id: weakening-guard') -gt $implementText.IndexOf('id: implement'))
Assert 'baseline promotion assets exist' (@(@('policies/baseline-promotion.json', 'schemas/baseline-promotion.schema.json', 'schemas/promotion-audit-entry.schema.json', 'scripts/promote-baseline.ps1', 'scripts/check-weakening.ps1', 'docs/baseline-promotion.md') | Where-Object { -not (Test-Path (Join-Path $factory $_)) }).Count -eq 0)

# ---- Event retention prune -------------------------------------------------
Write-Host '== event retention =='
$pruneDir = Join-Path ([IO.Path]::GetTempPath()) ("prune-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $pruneDir | Out-Null
$pruneNow = '2026-06-30T00:00:00Z'
$pruneOld = '{"id":1,"timestamp":"2026-01-01T00:00:00Z"}'
$pruneNew = '{"id":2,"timestamp":"2026-06-29T00:00:00Z"}'
$pruneBad = '{"id":3,"timestamp":"not-a-date"}'
$pruneFile = Join-Path $pruneDir 'events.jsonl'
[IO.File]::WriteAllText($pruneFile, "$pruneOld`n$pruneNew`n$pruneBad`n")
$prunePolicy = Join-Path $pruneDir 'retention.yaml'
[IO.File]::WriteAllText($prunePolicy, "event_retention_days: 30`n")
$pr = Run 'prune-events.ps1' @{ EventsPath = $pruneFile; PolicyPath = $prunePolicy; Now = $pruneNow }
$prLogs = @($pr.Out -split "`r?`n" | Where-Object { $_ -match '^\{.*\}$' })
Assert 'prune removes only old events and keeps newer and unparseable ones byte-for-byte' ($pr.Code -eq 0 -and ([IO.File]::ReadAllText($pruneFile) -ceq "$pruneNew`n$pruneBad`n"))
$prLog = if ($prLogs.Count -eq 1) { $prLogs[0] | ConvertFrom-Json } else { $null }
Assert 'prune emits exactly one structured log line with retention, cutoff, removed, and kept' ($prLogs.Count -eq 1 -and $prLog.retention_days -eq 30 -and $prLog.removed -eq 1 -and $prLog.kept -eq 2 -and $prLog.cutoff)
foreach ($badRetention in 'abc', '0', '-5', '1.5', '') {
    [IO.File]::WriteAllText($prunePolicy, "event_retention_days: $badRetention`n")
    [IO.File]::WriteAllText($pruneFile, "$pruneOld`n$pruneNew`n")
    $pr = Run 'prune-events.ps1' @{ EventsPath = $pruneFile; PolicyPath = $prunePolicy; Now = $pruneNow }
    Assert "invalid retention '$badRetention' is rejected without touching events" ($pr.Code -ne 0 -and $pr.Out -match 'event_retention_days' -and ([IO.File]::ReadAllText($pruneFile) -ceq "$pruneOld`n$pruneNew`n"))
}
[IO.File]::WriteAllText($prunePolicy, "# no setting`n")
$pr = Run 'prune-events.ps1' @{ EventsPath = $pruneFile; PolicyPath = $prunePolicy; Now = $pruneNow }
Assert 'missing retention is rejected' ($pr.Code -ne 0)
$shipped = Run 'prune-events.ps1' @{ EventsPath = $pruneFile; Now = $pruneNow }
Assert 'the shipped retention policy is valid' ($shipped.Code -eq 0)
Remove-Item -Recurse -Force $pruneDir

if ($script:fail) { Write-Host "FAILED: $script:fail assertion(s)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASSED' -ForegroundColor Green
