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
    Get-ChildItem $From -Force | Where-Object { $_.Name -notin '.git', 'tests' } | Copy-Item -Destination $To -Recurse
}

# ---- Static checks -------------------------------------------------------
Write-Host '== static =='
$curVer = Get-FactoryVersion $factory
$required = 'README.md', 'VERSION', 'CHANGELOG.md', 'policies/labels.yaml', 'policies/retry.yaml', 'policies/risk.yaml',
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
'scripts/record-local-evaluation.ps1', 'scripts/evaluate-local-promotion.ps1', 'schemas/local-evaluation.schema.json', 'docs/local-model-evaluation.md',
'docs/execution-inventory.md', 'docs/backlog-reconciler.md', 'docs/factory-automation-status.md', 'skills/factory-work-backlog/SKILL.md', 'skills/factory-backlog-label-audit/SKILL.md', 'workflows/backlog-label-audit.yaml', 'automations/backlog-label-audit.json'
foreach ($f in $required) { Assert "exists $f" (Test-Path (Join-Path $factory $f)) }
Assert 'automation catalog validates' ((Run 'validate-automation-catalog.ps1' @{}).Code -eq 0)
$catalog = Get-Content -Raw (Join-Path $factory 'routing/automation-catalog.json') | ConvertFrom-Json
Assert 'automation profiles pin Codex work to gpt-5.6-terra' ($catalog.automationProfiles.'factory-implement'.runner -eq 'codex' -and $catalog.automationProfiles.'factory-implement'.model -eq 'gpt-5.6-terra' -and $catalog.automationProfiles.'factory-fix-review'.model -eq 'gpt-5.6-terra')
Assert 'backlog audit is pinned to bounded local model' ($catalog.automationProfiles.'factory-backlog-label-audit'.runner -eq 'opencode' -and $catalog.automationProfiles.'factory-backlog-label-audit'.model -eq 'litellm/factory-small')
$planWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/plan.yaml')
$investigateWorkflow = Get-Content -Raw (Join-Path $factory 'workflows/investigate.yaml')
$routeState = Get-Content -Raw (Join-Path $factory 'scripts/route-state.ps1')
Assert 'isolated-worktree workflows use the registered Factory runtime' ($planWorkflow -match '\$FACTORY_RUNTIME_ROOT/scripts/(hindsight/recall|validate-result|route-state)' -and $investigateWorkflow -match '\$FACTORY_RUNTIME_ROOT/scripts/(hindsight/recall|validate-result|route-state)' -and $planWorkflow -notmatch '\.ai/factory/scripts' -and $investigateWorkflow -notmatch '\.ai/factory/scripts')
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
        Assert 'backlog label audit not installed' (-not (Test-Path (Join-Path $fdir 'automations/backlog-label-audit.json')))
        Assert 'verify passes' ((Run 'verify.ps1' $a).Code -eq 0)
        Assert 'diff clean' ((Run 'diff.ps1' $a).Code -eq 0)
        Assert 'reinstall idempotent' ((Run 'install.ps1' $a).Code -eq 0)

        # Drift detection
        $target = Join-Path $proj '.ai/skills/factory-plan/SKILL.md'
        $orig = [IO.File]::ReadAllText($target)
        Add-Content $target 'local edit'
        Assert 'diff detects modified file' ((Run 'diff.ps1' $a).Code -ne 0)
        Assert 'update refuses modified managed file' ((Run 'update.ps1' $a).Code -ne 0)
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
        $a = @{ Event = $Event; GhCommand = $gh }
        if ($Obj) { $a.Path = $f } else { $a.Issue = $Issue }
        try { & pwsh -NoProfile -File $route @a *>&1 | Out-Null } catch { $global:LASTEXITCODE = 1 }
        $global:LASTEXITCODE
    }
    $plan = @{ issue = 7; objective = 'o'; acceptanceCriteria = 'a'; nonGoals = 'n'; risks = 'r'; dependencies = 'd'; suggestedWorkBreakdown = '1. do'; requiredProjectSkills = @('s'); unresolvedQuestions = ''; readyNotReadyStatus = 'ready' }
    Assert 'validate: good plan passes' ((Test-Validate 'plan' $plan) -eq 0)
    $memoryPlan = With $plan @{ memoryRecall = @{ banksQueried = @('project-7'); memoryIds = @('m1'); memoryCount = 1; contextChars = 4200 } }
    Assert 'validate: bounded memory recall passes' ((Test-Validate 'plan' $memoryPlan) -eq 0)
    Assert 'validate: ready plan with open questions fails' ((Test-Validate 'plan' (With $plan @{ unresolvedQuestions = 'which db?' })) -ne 0)
    $bad = $plan.Clone(); $bad.Remove('issue')
    Assert 'validate: missing issue fails' ((Test-Validate 'plan' $bad) -ne 0)
    Assert 'validate: not-ready plan with questions passes' ((Test-Validate 'plan' (With $plan @{ unresolvedQuestions = 'q'; readyNotReadyStatus = 'not-ready' })) -eq 0)
    $impl = @{ issue = 7; status = 'success'; summary = 's'; filesChanged = @('a.gd'); testsRun = @('t'); testResult = 'pass'; acceptanceCriteriaStatus = 'met'; knownConcerns = ''; followUpSuggestions = ''; durableKnowledgeCandidates = ''; pr = 'https://x/pr/1' }
    Assert 'validate: good implementation passes' ((Test-Validate 'implementation' $impl) -eq 0)
    $noPr = $impl.Clone(); $noPr.Remove('pr')
    Assert 'validate: success without PR fails' ((Test-Validate 'implementation' $noPr) -ne 0)
    $rev = @{ issue = 7; approvalChangeRequestStatus = 'change-request'; blockingFindings = ''; nonBlockingFindings = ''; acceptanceCriteriaVerification = 'v'; testAdequacy = 't'; riskObservations = 'r' }
    Assert 'validate: change-request without findings fails' ((Test-Validate 'review' $rev) -ne 0)
    Assert 'validate: change-request with findings passes' ((Test-Validate 'review' (With $rev @{ blockingFindings = 'bug at x' })) -eq 0)
    $inv = @{ issue = 7; failureClassification = 'flaky-test'; evidence = 'e'; attemptsReviewed = 'a'; rootCauseHypothesis = 'h'; confidence = 'high'; recommendedAction = 'retry'; automaticRetryAppropriate = $true }
    Assert 'validate: good investigation passes' ((Test-Validate 'investigation' $inv) -eq 0)
    Assert 'validate: unknown classification fails' ((Test-Validate 'investigation' (With $inv @{ failureClassification = 'gremlins' })) -ne 0)

    Set-Gh @('factory:needs-plan', 'type:bug')
    Assert 'route: plan ready -> factory:ready' ((Invoke-Route 'plan-result' $plan) -eq 0 -and (Get-Gh).labels -contains 'factory:ready' -and (Get-Gh).labels -notcontains 'factory:needs-plan' -and (Get-Gh).labels -contains 'type:bug')
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
    Assert 'route: start is idempotent while working' ((Invoke-Route 'start' $null 7) -eq 0)
    Set-Gh @('factory:needs-plan')
    Assert 'route: start from needs-plan refused' ((Invoke-Route 'start' $null 7) -ne 0)
    Set-Gh @('factory:working')
    Assert 'route: implement success -> review' ((Invoke-Route 'implement-result' $impl) -eq 0 -and (Get-Gh).labels -contains 'factory:review')
    $execution = Get-Content -Raw (Join-Path $rp '.factory/execution.json') | ConvertFrom-Json
    Assert 'route: execution completion recorded' ($execution.execution.status -eq 'complete' -and $execution.execution.result -eq 'success' -and $execution.execution.pr -eq $impl.pr)
    Set-Gh @('factory:working')
    Assert 'route: implement failure -> investigate' ((Invoke-Route 'implement-result' (With $impl @{ status = 'failure' })) -eq 0 -and (Get-Gh).labels -contains 'factory:investigate')
    Set-Gh @('factory:review')
    Assert 'route: review approval -> human-review' ((Invoke-Route 'review-result' (With $rev @{ approvalChangeRequestStatus = 'approval' })) -eq 0 -and (Get-Gh).labels -contains 'factory:human-review')
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
        @{ title = 'Phase A'; body = 'Do A'; type = 'type:feature'; risk = 'risk:medium' },
        @{ title = 'Phase B'; body = 'Do B'; type = 'type:test'; risk = 'risk:low'; dependsOn = @(0) }
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
    Assert 'route: sub-issues created' ($iss.Count -eq 2 -and $iss[0].labels -eq 'factory:new,type:feature,risk:medium')
    Assert 'route: sub-issue links back to parent' ($iss[0].body -match 'Parent: #7' -and $iss[0].body -match 'factory-parent:7')
    Assert 'route: parent comment lists children and dependencies' ((@((Get-Gh).comments)[-1]) -match '#100' -and (@((Get-Gh).comments)[-1]) -match '\| #101 \| Phase B .* \| #100 \|')
    $st = Get-Gh; $st.labels = @('factory:needs-plan'); $st | ConvertTo-Json -Depth 6 | Set-Content $env:FAKE_GH_STATE
    Assert 'route: re-running does not duplicate sub-issues' ((Invoke-Route 'plan-result' $dec) -eq 0 -and @((Get-Gh).issues).Count -eq 2)

    $labelScript = Join-Path $rp '.ai/factory/scripts/create-labels.ps1'
    Set-Gh @()
    & pwsh -NoProfile -File $labelScript -GhCommand $gh *>&1 | Out-Null
    $created = @((Get-Gh).created)
    Assert 'labels: all factory-state labels created' (@(@('factory:new', 'factory:ready', 'factory:investigate', 'factory:done') | Where-Object { $created -notcontains $_ }).Count -eq 0)
    Assert 'labels: type, risk and agent labels created' ($created -contains 'type:bug' -and $created -contains 'risk:high' -and $created -contains 'agent:either')
    Assert 'labels: dry-run creates nothing' ((& { Set-Gh @(); & pwsh -NoProfile -File $labelScript -GhCommand $gh -DryRun *>&1 | Out-Null; @((Get-Gh).created).Count -eq 0 }))

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
    }
    finally { if ($srv -and -not $srv.HasExited) { $srv.Kill() } }
}
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:fail) { Write-Host "FAILED: $script:fail assertion(s)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASSED' -ForegroundColor Green
