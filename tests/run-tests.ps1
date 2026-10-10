#!/usr/bin/env pwsh
# Factory self-test: static checks plus install/update/diff/verify scenarios against fixture projects.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scripts = Join-Path $factory 'scripts'
. (Join-Path $scripts 'lib.ps1')

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
    New-Item -ItemType Directory $To | Out-Null
    Get-ChildItem $From -Force | Where-Object { $_.Name -notin '.git', 'tests', 'cezar', 'node_modules', '.factory' } | Copy-Item -Destination $To -Recurse
}

# ---- Static checks -------------------------------------------------------
Write-Host '== static =='
$curVer = Get-FactoryVersion $factory
$required = 'README.md', 'VERSION', 'CHANGELOG.md', 'AGENTS.md', 'policies/labels.yaml', 'policies/retry.yaml', 'policies/risk.yaml',
'policies/definition-of-ready.md', 'policies/definition-of-done.md', 'policies/escalation.md',
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
'docs/langfuse-live-evidence.md',
'integrations/openhands/job-request.schema.json', 'integrations/openhands/job-result.schema.json',
'scripts/openhands/validate-job.ps1', 'scripts/openhands/run-job.py', 'tests/fixtures/openhands-job-request.json', 'tests/fixtures/openhands-failure-request.json', 'docs/operations-readiness.md',
'docs/local-coding-tool-evaluation.md',
'docs/routing-evaluation.md',
'docs/pilot-loop-evidence.md',
'docs/gpu-exporter-evaluation.md',
'scripts/deploy/deploy-vllm-mac.sh', 'scripts/deploy/validate-deployment.sh',
'scripts/deploy/vllm-trusted-proxy.py', 'scripts/deploy/deploy-vllm-trusted-proxy-mac.sh', 'scripts/deploy/validate-vllm-trusted-proxy-mac.sh',
'scripts/deploy/rotate-cezar-github-token.bat', 'docs/credential-rotation.md',
'routing/automation-catalog.json', 'schemas/automation-catalog.schema.json', 'schemas/memory-recall.schema.json', 'schemas/memory-candidate.schema.json',
'scripts/validate-automation-catalog.ps1', 'scripts/reconcile-backlog.ps1', 'scripts/lease.ps1', 'scripts/hindsight/client.py', 'scripts/hindsight/recall.ps1', 'scripts/hindsight/retain.ps1',
'scripts/record-local-evaluation.ps1', 'scripts/evaluate-local-promotion.ps1', 'scripts/audit-backlog-labels.ps1', 'scripts/push-factory-updates.ps1', 'scripts/onboard-project.ps1', 'scripts/force-update.ps1', 'scripts/update-github-lifecycle.ps1', 'scripts/refresh-stale-workable.ps1', 'scripts/maintain-repository.ps1', 'config/factory-projects.json.example', 'skills/factory-release/SKILL.md', 'schemas/local-evaluation.schema.json', 'docs/local-model-evaluation.md',
'docs/execution-inventory.md', 'docs/backlog-reconciler.md', 'docs/factory-automation-status.md', 'docs/workflow-map.md', 'skills/factory-work-backlog/SKILL.md', 'skills/factory-backlog-label-audit/SKILL.md', 'workflows/maintenance.yaml', 'automations/maintenance.json',
'workflows/godot-upgrade.yaml', 'automations/godot-upgrade.json', 'skills/factory-godot-upgrade/SKILL.md', 'scripts/godot-upgrade.ps1', 'cezar/godot-install.sh', 'cezar/godot-select.sh',
'scripts/release/promote-stable.ps1', 'scripts/sync-all-automations.ps1', 'scripts/migrate-to-shared.ps1', 'scripts/deploy/factory-autodeploy.sh', 'integrations/bazzite/factory-autodeploy.service', 'integrations/bazzite/factory-autodeploy.timer', 'docs/shared-factory.md'
foreach ($f in $required) { Assert "exists $f" (Test-Path (Join-Path $factory $f)) }
Assert 'automation catalog validates' ((Run 'validate-automation-catalog.ps1' @{}).Code -eq 0)
$catalog = Get-Content -Raw (Join-Path $factory 'routing/automation-catalog.json') | ConvertFrom-Json
Assert 'implementation and fix-review use the configured gateway model' ($catalog.automationProfiles.'factory-implement'.runner -eq 'codex' -and $catalog.automationProfiles.'factory-implement'.model -eq 'factory-gateway/factory-code' -and $catalog.automationProfiles.'factory-fix-review'.model -eq 'factory-gateway/factory-code')
Assert 'complexity routes small and medium implementation through the gateway' ($catalog.automationProfiles.'factory-implement'.complexityVariants.'complexity:small'.model -eq 'factory-gateway/factory-code' -and $catalog.automationProfiles.'factory-implement'.complexityVariants.'complexity:medium'.model -eq 'factory-gateway/factory-code' -and $catalog.automationProfiles.'factory-implement'.complexityVariants.'complexity:large'.model -eq 'gpt-6.1-sol')
Assert 'planning routes every complexity tier to Claude Sonnet' ($catalog.automationProfiles.'factory-plan'.runner -eq 'claude' -and $catalog.automationProfiles.'factory-plan'.model -eq 'sonnet' -and $catalog.automationProfiles.'factory-plan'.complexityVariants.'complexity:small'.runner -eq 'claude' -and $catalog.automationProfiles.'factory-plan'.complexityVariants.'complexity:medium'.model -eq 'sonnet' -and $catalog.automationProfiles.'factory-plan'.complexityVariants.'complexity:large'.model -eq 'sonnet')
Assert 'maintenance is pinned to the Factory gateway code model' ($catalog.automationProfiles.'factory-maintenance'.runner -eq 'codex' -and $catalog.automationProfiles.'factory-maintenance'.model -eq 'factory-gateway/factory-code')
$backlogAuditSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-backlog-label-audit/SKILL.md')
Assert 'backlog audit requires the stable Cezar candidate script' ($backlogAuditSkill -match 'installed audit script' -and $backlogAuditSkill -match '/projects/cezar-factory/scripts/audit-backlog-labels\.ps1' -and $backlogAuditSkill -match 'Do not call `gh issue list`')
Assert 'backlog audit rejects unlabeled skips' ($backlogAuditSkill -match 'A skipped issue without one of these durable closing labels is an audit failure')
$planWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/plan.yaml')
$investigateWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/investigate.yaml')
$implementWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/implement.yaml')
$implementSkill = Get-Content -Raw (Join-Path $factory 'skills/factory-implement/SKILL.md')
$prepareScript = Get-Content -Raw (Join-Path $factory 'scripts/prepare-implementation.ps1')
$startupScript = Get-Content -Raw (Join-Path $factory 'scripts/factory-startup.ps1')
$routeState = Get-Content -Raw (Join-Path $factory 'scripts/route-state.ps1')
Assert 'isolated-worktree workflows use the registered Factory runtime' ($planWorkflow -match '\$FACTORY_RUNTIME_ROOT/scripts/(hindsight/recall|validate-result|route-state)' -and $investigateWorkflow -match '\$FACTORY_RUNTIME_ROOT/scripts/(hindsight/recall|validate-result|route-state)' -and $planWorkflow -notmatch '\.ai/factory/scripts' -and $investigateWorkflow -notmatch '\.ai/factory/scripts')
Assert 'implement workflow prepares context before implementation' ($implementWorkflow -match 'id: prepare' -and $implementWorkflow -match 'prepare-implementation\.ps1 -Task' -and $implementWorkflow -match 'route-state\.ps1 -Event start -Task' -and $implementWorkflow -match 'implementation-context\.json')
Assert 'implementation preparation fetches issue and captures environment' ($implementWorkflow -match 'prepare-implementation\.ps1' -and $prepareScript -match 'gh.*issue.*view' -and $prepareScript -match 'comments' -and $prepareScript -match 'toolingFiles' -and $prepareScript -match 'AGENTS\.md')
Assert 'every workflow starts with shared startup preflight' (($startupScript -match 'RUNTIME_ROOT_INVALID' -and $startupScript -match 'REQUIRED_SCRIPT_MISSING' -and $startupScript -match 'GH_MISSING') -and @('failure-audit','fix-review','implement','intake','investigate','maintenance','plan','review' | ForEach-Object { (Get-Content -Raw (Join-Path $factory "workflows/$_.yaml")) -match 'id: startup' } | Where-Object { -not $_ }).Count -eq 0)
Assert 'startup normalizes comma-delimited required scripts from workflow commands' ($startupScript -match "-split ','" -and $startupScript -match 'requiredScripts = @\(\$RequiredScripts\)')
Assert 'release records force-refresh requirement for blocked managed updates' ((Get-Content -Raw (Join-Path $factory 'scripts/push-factory-updates.ps1')) -match 'forceRefreshRequired' -and (Get-Content -Raw (Join-Path $factory 'scripts/push-factory-updates.ps1')) -match 'release-status\.jsonl')
$onboardScript = Get-Content -Raw (Join-Path $factory 'scripts/onboard-project.ps1')
Assert 'new-project onboarding creates dev from the default branch' ($onboardScript -match 'git/ref/heads/dev' -and $onboardScript -match 'refs/heads/dev' -and $onboardScript -match 'defaultBranchRef')
Assert 'new-project onboarding is bounded and release-gated' ($onboardScript -match 'SeedOpenIssues' -and $onboardScript -match 'DryRun' -and $onboardScript -match 'never merges|never.*enables live automations|never.*dispatches')
$maintenanceWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/maintenance.yaml')
Assert 'maintenance workflow does not select or route intake work' ($maintenanceWorkflow -notmatch 'select-intake-issue|classify-intake|route-intake')
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
foreach ($sk in Get-ChildItem (Join-Path $factory 'skills') -Directory | Where-Object { $_.Name -notin 'interactive-github-backlog', 'factory-work-backlog', 'factory-release', 'factory-finish-release', 'factory-cezar-skill-operations' }) {
    foreach ($line in Get-Content (Join-Path $sk.FullName 'SKILL.md')) {
        if ($line -match '(pwsh|powershell)\s+.*\.ps1' -and $line -notmatch '(?i)\b(not|never|must not|do not)\b') { $scriptOwnershipViolations += "$($sk.Name): $($line.Trim())" }
    }
}
Assert "workflows own scripts: no prompt or skill tells the model to run one ($($scriptOwnershipViolations -join ' | '))" ($scriptOwnershipViolations.Count -eq 0)
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
Assert 'remote validation reads named Podman connection from topology' ($remoteScript -match 'FACTORY_CONTROL_PLANE_PODMAN_CONNECTION' -and $remoteScript -match 'FACTORY_CONTROL_PLANE_HEALTH_BASE_URL')
Assert 'control-plane deployment targets named Podman connection' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'FACTORY_CONTROL_PLANE_PODMAN_CONNECTION' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'podman --connection')
Assert 'control-plane validation supports topology health URL' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-deployment.sh')) -match 'base_url' -and (Get-Content -Raw (Join-Path $factory 'config/server-topology.env.example')) -match 'FACTORY_CONTROL_PLANE_HEALTH_BASE_URL')
Assert 'Bazzite validation uses LiteLLM master key for gateway health' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-deployment.sh')) -match 'litellm_api_key' -and (Get-Content -Raw (Join-Path $factory 'scripts/deploy/validate-deployment.sh')) -match '4001/health')
Assert 'LiteLLM config mount is SELinux-safe' ((Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')) -match 'litellm-config\.yaml:/app/config\.yaml:ro,Z')
Assert 'Bazzite preflight rejects example registry' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'registry\\.example')
Assert 'Bazzite preflight requires OpenHands auth' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'OPENHANDS_SESSION_API_KEY')
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
Assert 'LiteLLM live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/litellm-live-evidence.md'))
Assert 'LiteLLM bypasses proxy for private vLLM hop from topology' ((Get-Content -Raw (Join-Path $factory 'scripts/deploy/deploy-bazzite.sh')) -match 'FACTORY_VLLM_METRICS_TARGET.*127\.0\.0\.1,localhost' -and (Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')) -match 'NO_PROXY: \$\{NO_PROXY\}')
Assert 'Hindsight deployment uses pinned official image and bounded retain budget' ($bazziteEnv -match 'HINDSIGHT_IMAGE=ghcr\.io/vectorize-io/hindsight:0\.10\.0' -and $bazziteEnv -match '(?m)^HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=12000')
Assert 'Hindsight live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/hindsight-live-evidence.md'))
Assert 'Observability live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/observability-live-evidence.md'))
Assert 'Local utility live evidence exists' (Test-Path (Join-Path $factory 'docs/local-utility-live-evidence.md'))
Assert 'Langfuse live deployment evidence exists' (Test-Path (Join-Path $factory 'docs/langfuse-live-evidence.md'))
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
foreach ($f in Get-ChildItem (Join-Path $factory 'schemas') -Filter *.json) {
    $ok = $true; try { Get-Content -Raw $f.FullName | ConvertFrom-Json | Out-Null } catch { $ok = $false }
    Assert "valid JSON schemas/$($f.Name)" $ok
}
foreach ($f in Get-ChildItem $factory -Recurse -Include *.yaml -File | Where-Object { $_.FullName -notmatch 'tests|node_modules' }) {
    $t = Get-Content -Raw $f.FullName
    Assert "yaml sane $($f.Name)" (-not $t.Contains("`t") -and $t.Trim().Length -gt 0)
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

# ---- Scenarios -----------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) "factory-tests-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory $tmp | Out-Null
try {
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
    function Set-Gh($Labels, $Comments = @()) { @{ labels = @($Labels); comments = @($Comments) } | ConvertTo-Json -Depth 5 | Set-Content $env:FAKE_GH_STATE }
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
    function Invoke-Route([string]$Event, $Obj, [int]$Issue = 0) {
        $f = Join-Path $tmp 'route-result.json'; if ($Obj) { ($Obj | ConvertTo-Json -Depth 5) | Set-Content $f }
        $global:LASTEXITCODE = 0
        $a = @{ Event = $Event; GhCommand = $gh; ProjectPath = $rp }
        if ($Obj) { $a.Path = $f } else { $a.Issue = $Issue }
        try { & pwsh -NoProfile -File $route @a *>&1 | Out-Null } catch { $global:LASTEXITCODE = 1 }
        $global:LASTEXITCODE
    }
    $plan = @{ issue = 7; objective = 'o'; acceptanceCriteria = 'a'; nonGoals = 'n'; risks = 'r'; dependencies = 'd'; suggestedWorkBreakdown = '1. do'; requiredProjectSkills = @('s'); unresolvedQuestions = ''; complexity = 'complexity:medium'; readyNotReadyStatus = 'ready' }
    $intake = @{ issue = 7; type = 'type:bug'; risk = 'risk:low'; summary = 'clear bug'; unresolvedQuestions = '' }
    Assert 'validate: good intake passes' ((Test-Validate 'intake' $intake) -eq 0)
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
    $impl = @{ issue = 7; status = 'success'; summary = 's'; filesChanged = @('a.gd'); testsRun = @('t'); testResult = 'pass'; acceptanceCriteriaStatus = 'met'; documentationUpdated = $true; knownConcerns = ''; followUpSuggestions = ''; durableKnowledgeCandidates = ''; pr = 'https://x/pr/1' }
    Assert 'validate: good implementation passes' ((Test-Validate 'implementation' $impl) -eq 0)
    Assert 'validate: implementation with no documentation change passes' ((Test-Validate 'implementation' (With $impl @{ documentationUpdated = $false })) -eq 0)
    $noPr = $impl.Clone(); $noPr.Remove('pr')
    Assert 'validate: success without PR fails' ((Test-Validate 'implementation' $noPr) -ne 0)
    $rev = @{ issue = 7; approvalChangeRequestStatus = 'change-request'; blockingFindings = ''; nonBlockingFindings = ''; acceptanceCriteriaVerification = 'v'; testAdequacy = 't'; riskObservations = 'r' }
    Assert 'validate: change-request without findings fails' ((Test-Validate 'review' $rev) -ne 0)
    Assert 'validate: change-request with findings passes' ((Test-Validate 'review' (With $rev @{ blockingFindings = 'bug at x' })) -eq 0)
    $inv = @{ issue = 7; failureClassification = 'flaky-test'; evidence = 'e'; attemptsReviewed = 'a'; rootCauseHypothesis = 'h'; confidence = 'high'; recommendedAction = 'retry'; automaticRetryAppropriate = $true }
    Assert 'validate: good investigation passes' ((Test-Validate 'investigation' $inv) -eq 0)
    Assert 'validate: unknown classification fails' ((Test-Validate 'investigation' (With $inv @{ failureClassification = 'gremlins' })) -ne 0)

    Set-Gh @('factory:needs-plan', 'type:bug')
    Assert 'route: plan ready -> factory:ready' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:needs-plan' -and (Get-Gh).labels -contains 'type:bug' -and (Get-Gh).labels -contains 'complexity:medium')
    Assert 'route: plan posted as comment' (@((Get-Gh).comments).Count -eq 1)
    Set-Gh @('factory:needs-plan', 'risk:high')
    Assert 'route: risk:high plan held for approval' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:needs-plan')
    Assert 'route: not-ready -> needs-help' ((Invoke-Route 'plan-result' (With $plan @{ readyNotReadyStatus = 'not-ready'; unresolvedQuestions = 'q' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
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
    Assert 'route: review approval -> human-review' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval' })) -eq 0 -and (Get-Gh).labels -contains 'factory:human-review')
    Set-Gh @('factory:review', 'risk:low')
    Assert 'route: low-risk approval -> done and auto-merge' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval'; pr = 'https://x/pr/1' })) -eq 0 -and (Get-Gh).labels -contains 'factory:done' -and (Get-Gh).prMerged)
    Set-Gh @('factory:review')
    $chg = With $rev @{ blockingFindings = 'bug' }
    Assert 'route: review change-request -> changes-requested' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:changes-requested')
    Set-Gh @('factory:review') @('x <!-- factory:review-round -->', 'y <!-- factory:review-round -->')
    Assert 'route: review round limit escalates to needs-help' ((Invoke-Route 'review-result' $chg) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help' -and (@((Get-Gh).comments)[-1] -match 'Recommended human decision'))
    Set-Gh @('factory:investigate')
    Assert 'route: investigate retry -> ready' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:ready')
    Set-Gh @('factory:investigate') @('<!-- factory:investigate-retry -->')
    Assert 'route: second investigation escalates' ((Invoke-Route 'investigate-result' $inv) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
    Set-Gh @('factory:investigate')
    Assert 'route: low-confidence investigation escalates' ((Invoke-Route 'investigate-result' (With $inv @{ confidence = 'low' })) -eq 0 -and (Get-Gh).labels -contains 'factory:needs-help')
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
    Assert 'route: decomposed -> human-review' ((Invoke-Route 'plan-result' $dec) -eq 0 -and (Get-Gh).labels -contains 'factory:human-review')
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
    Assert 'labels: type, risk and agent labels created' ($created -contains 'type:bug' -and $created -contains 'risk:high' -and $created -contains 'agent:either')
    Assert 'labels: dry-run creates nothing' ((& { Set-Gh @(); & pwsh -NoProfile -File $labelScript -GhCommand $gh -DryRun *>&1 | Out-Null; @((Get-Gh).created).Count -eq 0 }))

    $auditInput = Join-Path $tmp 'backlog-label-audit-input.json'
    @{ labels = @(); comments = @(); created = @(); issues = @(
        @{ number = 3; title = 'Unmarked test'; labels = @(@{ name = 'test' }) },
        @{ number = 2; title = 'Already audited'; labels = @(@{ name = 'factory:needs-help' }) },
        @{ number = 1; title = 'Unmarked docs'; labels = @(@{ name = 'documentation' }) },
        @{ number = 4; title = 'Blocked legacy work'; labels = @(@{ name = 'blocker' }) },
        @{ number = 5; title = 'Ambiguous legacy work'; labels = @(@{ name = 'question' }) }
    ) } | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
    $auditScript = Join-Path $rp '.ai/factory/scripts/audit-backlog-labels.ps1'
    & pwsh -NoProfile -File $auditScript -GhCommand $gh -Limit 1 -OutputPath $auditInput *>&1 | Out-Null
    $auditCandidates = Get-Content -Raw $auditInput | ConvertFrom-Json
    $candidateIssues = @($auditCandidates.candidates | ForEach-Object { if ($_ -and $_.PSObject.Properties.Name -contains 'issue') { $_.issue } })
    $resolvedIssues = @($auditCandidates.resolved | ForEach-Object { if ($_ -and $_.PSObject.Properties.Name -contains 'issue') { $_.issue } })
    Assert 'backlog audit input: only unmarked issues are fetched for evaluation' ($LASTEXITCODE -eq 0 -and $candidateIssues -notcontains 2 -and $resolvedIssues -notcontains 2)
    Assert 'backlog audit input: static normalization is not bounded by the LLM limit' (@($auditCandidates.resolved).Count -eq 3)
    Assert 'backlog audit input: classification hints resolve test taxonomy' (@($auditCandidates.resolved | Where-Object { $_.issue -eq 3 }).added -contains 'type:test' -and (@($auditCandidates.resolved | Where-Object { $_.issue -eq 3 }).added -contains 'risk:low'))
    Assert 'backlog audit input: clear markers resolve without human escalation' (@($auditCandidates.resolved).Count -eq 3 -and (Get-Gh).labels -contains 'factory:new' -and (Get-Gh).labels -notcontains 'factory:needs-help')
    Assert 'backlog audit input: blocked marker resolves to factory:blocked' ((@($auditCandidates.resolved | Where-Object { $_.issue -eq 4 }).added) -contains 'factory:blocked')
    Assert 'backlog audit input: only ambiguous work is returned to the LLM' (@($auditCandidates.candidates).Count -eq 1 -and $auditCandidates.candidates[0].number -eq 5 -and (Get-Gh).labels -contains 'factory:auditing')
    Assert 'backlog audit input: candidate body is fetched before the LLM step' ($auditCandidates.candidates[0].PSObject.Properties.Name -contains 'body')
    Assert 'backlog audit input: label setup uses the installed sibling script' (@((Get-Gh).created).Count -gt 0)

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
        & pwsh -NoProfile -File (Join-Path $factory 'scripts/push-factory-updates.ps1') -TargetsPath $remoteTargets -SyncAutomations -DryRun *>&1 | Out-Null
        Assert 'release supports remote-only target registry entries' ($LASTEXITCODE -eq 0)
    }
    finally { if ($srv -and -not $srv.HasExited) { $srv.Kill() } }


# ---- Shared Factory (stable gate, mounted workflows, migration) -------------
Write-Host '== shared factory =='
$bazzCompose = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/compose.yaml')
Assert 'Cezar loads Factory workflows and skills from the mounted checkout' ($bazzCompose -match 'CEZ_SHARED_WORKFLOWS_DIRS:.*/workflows' -and $bazzCompose -match 'CEZ_SHARED_SKILL_DIRS:.*/skills')
$autodeploy = Get-Content -Raw (Join-Path $factory 'scripts/deploy/factory-autodeploy.sh')
Assert 'autodeploy only fast-forwards, refuses dirty or diverged checkouts, and never resets' ($autodeploy -match 'merge-base --is-ancestor' -and $autodeploy -match 'BLOCKED' -and $autodeploy -notmatch 'reset --hard|git clean|git stash')
Assert 'autodeploy tracks the tested stable branch' ($autodeploy -match 'FACTORY_DEPLOY_BRANCH:-stable')

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

$noRegistry = & pwsh -NoProfile -File (Join-Path $scripts 'sync-all-automations.ps1') -FactoryPath $factory -RegistryPath (Join-Path $sg 'missing.json') *>&1 | Out-String
Assert 'sync-all refuses to run without a target registry' ($LASTEXITCODE -ne 0 -and $noRegistry -match 'No target registry')

$mp = Join-Path $tmp 'migrate-project'
Copy-Item (Join-Path $PSScriptRoot 'fixtures/godot-project') $mp -Recurse
$mcfg = Join-Path $mp '.ai/factory/factory.config.yaml'
[IO.File]::WriteAllText($mcfg, [regex]::Replace([IO.File]::ReadAllText($mcfg), '(?m)^(\s*version:\s*)"\d+\.\d+\.\d+"', "`${1}`"$curVer`""), [Text.UTF8Encoding]::new($false))
Assert 'migrate: fixture installs' ((Run 'install.ps1' @{ ProjectPath = $mp; FactoryPath = $factory }).Code -eq 0 -and (Test-Path (Join-Path $mp '.ai/cezar/workflows/factory-plan.yaml')))
Add-Content (Join-Path $mp '.ai/skills/factory-plan/SKILL.md') 'local edit'
$r = Run 'migrate-to-shared.ps1' @{ ProjectPath = $mp }
Assert 'migrate: a locally edited managed file blocks and nothing is removed' ($r.Code -ne 0 -and (Test-Path (Join-Path $mp '.ai/skills/factory-plan/SKILL.md')) -and (Test-Path (Join-Path $mp '.ai/cezar/workflows/factory-plan.yaml')))
$r = Run 'migrate-to-shared.ps1' @{ ProjectPath = $mp; Force = $true; DryRun = $true }
Assert 'migrate: dry-run removes nothing' ($r.Code -eq 0 -and (Test-Path (Join-Path $mp '.ai/cezar/workflows/factory-plan.yaml')))
$r = Run 'migrate-to-shared.ps1' @{ ProjectPath = $mp; Force = $true }
Assert 'migrate: removes installed workflows, skills and manifest but keeps project config' ($r.Code -eq 0 -and -not (Test-Path (Join-Path $mp '.ai/cezar/workflows/factory-plan.yaml')) -and -not (Test-Path (Join-Path $mp '.ai/skills/factory-plan')) -and -not (Test-Path (Join-Path $mp '.ai/factory/manifest.json')) -and (Test-Path $mcfg))

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

if ($script:fail) { Write-Host "FAILED: $script:fail assertion(s)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASSED' -ForegroundColor Green
