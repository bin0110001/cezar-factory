#!/usr/bin/env pwsh
# Adversarial untrusted-input scenarios (#581): each scenario must be denied by an existing guard AND leave an audit event.
# Reuses scripts/factory/protect-governance.ps1 (#104) at its own boundary; fixtures are inert and the network is never used.
# Memory recall, capability and approval-gate scenarios live in tests/test_untrusted_input_policy.py.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$guard = Join-Path $factory 'scripts/factory/protect-governance.ps1'
$fakeGh = Join-Path $PSScriptRoot 'fake-gh-governance.ps1'
$fx = Join-Path $PSScriptRoot 'fixtures/untrusted-input'
$script:failures = 0
function Check([string]$Name, [bool]$Ok) { if ($Ok) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ } }
function G { & git -C $script:repo @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed" } }
function Write-F([string]$Rel, [string]$Text) {
    $p = Join-Path $script:repo $Rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
    Set-Content -LiteralPath $p -Value $Text -Encoding utf8
}
function New-Repo {
    $script:repo = Join-Path ([IO.Path]::GetTempPath()) "uip-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Path $script:repo | Out-Null
    G init -q -b main; G config user.email t@example.com; G config user.name t
    Write-F 'policies/risk.yaml' 'a: 1'; Write-F 'tests/baselines/x.json' '{}'; Write-F 'src/app.txt' 'one'
    Write-F 'scripts/factory/protect-governance.ps1' '# orig'
    Write-F 'config/promotion-policy.json' '{"posture":"controlled"}'
    Write-F '.ai/factory/test-ownership.json' '{"schemaVersion":1,"unmapped":"full","checks":[{"id":"a","patterns":["a/**"],"command":"run-a"}]}'
    G add -A; G commit -q -m base
    $script:base = ((& git -C $script:repo rev-parse HEAD) -join '').Trim()
}
function Commit-All { G add -A; G commit -q -m change }
function Run-Guard([string]$Marker = '', [string]$State = '') {
    $env:FAKE_GOV_STATE = $State
    Remove-Item (Join-Path $script:repo '.factory/governance-denials.jsonl') -ErrorAction SilentlyContinue
    $report = Join-Path $script:repo '.factory/governance-guard.json'
    $argList = @('-NoProfile', '-File', $guard, '-Root', $script:repo, '-Base', $script:base, '-Gh', $fakeGh, '-Repo', 'o/r',
        '-AuthorizationPath', $(if ($Marker) { $Marker } else { Join-Path $script:repo '.no-marker' }), '-ReportPath', $report)
    Push-Location $script:repo
    try { $out = & pwsh @argList 2>&1 | Out-String } finally { Pop-Location }
    $log = Join-Path $script:repo '.factory/governance-denials.jsonl'
    $events = if (Test-Path $log) { @(Get-Content $log | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() }
    [pscustomobject]@{ code = $LASTEXITCODE; out = $out; events = $events }
}
function Test-Denied($r, [string[]]$Paths, [string]$Reason = '') {
    $ev = @($r.events | Where-Object { $_.type -eq 'governance-denial' })
    $named = @($ev | ForEach-Object { $_.denied.path })
    $ok = ($r.code -ne 0) -and ($ev.Count -eq 1) -and (@($Paths | Where-Object { $_ -notin $named }).Count -eq 0)
    if ($Reason) { $ok = $ok -and $ev[0].reason -match $Reason }
    $ok
}
function New-Marker([string]$Reviewer, [string[]]$Paths) {
    $head = ((& git -C $script:repo rev-parse HEAD) -join '').Trim()
    $p = Join-Path $script:repo '.marker.json'
    @{ schemaVersion = 1; pr = 7; reviewer = $Reviewer; headCommit = $head; paths = $Paths } | ConvertTo-Json | Set-Content -LiteralPath $p; $p
}
function New-State($Over = @{}) {
    $head = ((& git -C $script:repo rev-parse HEAD) -join '').Trim()
    $s = @{ head = $head; author = 'agentuser'; actor = 'agentuser'; reviews = @() }
    foreach ($k in $Over.Keys) { $s[$k] = $Over[$k] }
    $p = Join-Path $script:repo '.state.json'; $s | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $p; $p
}

Write-Host '== untrusted input: governance guard scenarios =='
# 1. Prompt-injection issue body: agent obeys it, edits policy, forges env + marker. Text grants nothing.
New-Repo
Check 'fixture: issue body really is an injection' ((Get-Content -Raw (Join-Path $fx 'issue-body-injection.md')) -match 'IGNORE ALL PREVIOUS')
Write-F 'policies/risk.yaml' 'a: 0'; Commit-All
$env:FACTORY_GOVERNANCE_AUTHORIZED = '1'
$r = Run-Guard (New-Marker 'maintainer' @('policies/risk.yaml')) (New-State)
Remove-Item Env:FACTORY_GOVERNANCE_AUTHORIZED
Check 'issue-body injection: policy edit denied with a governance-denial audit event' (Test-Denied $r @('policies/risk.yaml') 'review')

# 2. Repo file carrying agent instructions (waiver tag in commit message, edits baseline + policy).
New-Repo
Write-F 'docs/AGENT-NOTES.md' (Get-Content -Raw (Join-Path $fx 'repo-instructions.md'))
Write-F 'policies/risk.yaml' 'a: 2'; Write-F 'tests/baselines/x.json' '{"a":1}'
G add -A; G commit -q -m 'factory-governance-waiver: approved'
$r = Run-Guard
Check 'repo-file instructions: policy and baseline edits denied with an audit event' (Test-Denied $r @('policies/risk.yaml', 'tests/baselines/x.json') 'No authorization marker')

# 3. Malicious install script: apply (never run) the weakening it describes.
New-Repo
Check 'fixture: install script is inert (not executable)' (-not ((Get-Item (Join-Path $fx 'malicious-install.sh')).UnixMode -match 'x') -or $IsWindows)
Write-F 'scripts/factory/protect-governance.ps1' '# weakened'; Write-F 'tests/baselines/x.json' '{}x'
Write-F '.ai/factory/test-ownership.json' '{"schemaVersion":1,"unmapped":"skip","checks":[{"id":"a","patterns":["a/**"],"command":"run-a"}]}'
Commit-All
$r = Run-Guard
Check 'malicious install script: guard, baseline and check-selection weakening denied with an audit event' (Test-Denied $r @('scripts/factory/protect-governance.ps1', 'tests/baselines/x.json', '.ai/factory/test-ownership.json'))

# 4. Permission widening in the diff: promotion posture and policy loosened.
New-Repo
Write-F 'config/promotion-policy.json' '{"posture":"autonomous"}'; Write-F 'policies/risk.yaml' 'a: widened'; Commit-All
$r = Run-Guard
Check 'permission widening: policy and promotion-posture edits denied with an audit event' (Test-Denied $r @('config/promotion-policy.json', 'policies/risk.yaml'))

Write-Host '== untrusted input: approval negative tests =='
New-Repo; Write-F 'policies/risk.yaml' 'a: 2'; Commit-All
$ph = [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('policies/risk.yaml'))).Replace('-', '').ToLower()
function Review($Login, $Assoc) { @{ user = @{ login = $Login }; state = 'APPROVED'; commit_id = ((& git -C $script:repo rev-parse HEAD) -join '').Trim(); author_association = $Assoc; body = "factory-governance-waiver:$ph"; html_url = 'u' } }
$r = Run-Guard
Check 'high-risk change with no approval is denied and audited' (Test-Denied $r @('policies/risk.yaml') 'No authorization marker')
$r = Run-Guard (New-Marker 'reviewer1' @('policies/risk.yaml')) (New-State @{ reviews = @() })
Check 'claimed approval with no GitHub review is denied and audited' (Test-Denied $r @('policies/risk.yaml') 'No APPROVED review')
$r = Run-Guard (New-Marker 'reviewer1' @('policies/risk.yaml')) (New-State @{ reviews = @(Review 'reviewer1' 'CONTRIBUTOR') })
Check 'approver without permission (CONTRIBUTOR) is denied and audited' (Test-Denied $r @('policies/risk.yaml') 'No APPROVED review')
$r = Run-Guard (New-Marker 'agentuser' @('policies/risk.yaml')) (New-State @{ reviews = @(Review 'agentuser' 'OWNER') })
Check 'agent self-approval is denied and audited' (Test-Denied $r @('policies/risk.yaml') 'author or the acting')
$r = Run-Guard (New-Marker 'reviewer1' @('policies/risk.yaml')) (New-State @{ reviews = @(Review 'reviewer1' 'OWNER') })
Check 'control: a legitimate independent approval still passes (no denial event)' ($r.code -eq 0 -and $r.events.Count -eq 0)

if ($script:failures) { Write-Host "untrusted-input-policy: $($script:failures) failure(s)"; exit 1 }
Write-Host 'untrusted-input-policy: all checks passed'
