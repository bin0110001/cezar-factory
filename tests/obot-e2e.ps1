#!/usr/bin/env pwsh
# Local end-to-end security, regression and telemetry acceptance for the Obot MCP gateway wiring (issue #172).
# Runs on local compute only: a loopback fake gateway (tests/obot-e2e/fake-gateway.py) plus the real client
# helper (integrations/mcp-gateway/headers.mjs) and static checks of the committed client/Obot contracts.
# Reproduce with: pwsh -NoProfile -File tests/obot-e2e.ps1   (docs/obot-mcp-e2e.md maps each case to G0-G4).
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:fail = 0
function Assert([string]$Name, [bool]$Cond) {
    if ($Cond) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:fail++ }
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("obot-e2e-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$state = Join-Path $work 'state'
$script:proc = $null
$script:url = $null

function Start-Gateway {
    $port = Join-Path $work 'port.txt'
    Remove-Item $port -ErrorAction SilentlyContinue
    $psi = [Diagnostics.ProcessStartInfo]::new('python3')
    foreach ($a in @('-I', (Join-Path $PSScriptRoot 'obot-e2e/fake-gateway.py'), $state)) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
    if ($script:lastPort) { $psi.Environment['FAKE_GATEWAY_PORT'] = "$script:lastPort" }
    $script:proc = [Diagnostics.Process]::Start($psi)
    $readTask = $script:proc.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait(10000)) { throw 'fake gateway did not report a port within 10s' }
    $script:lastPort = [int]($readTask.Result -replace '^PORT=', '')
    $script:url = "http://127.0.0.1:$script:lastPort/mcp"
}
function Stop-Gateway { if ($script:proc -and -not $script:proc.HasExited) { $script:proc.Kill(); [void]$script:proc.WaitForExit(5000) } }

function Set-Tokens([hashtable]$Tokens) {
    New-Item -ItemType Directory -Force $state | Out-Null
    $reg = @{}
    foreach ($t in $Tokens.Keys) {
        $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($t))).Replace('-', '').ToLowerInvariant()
        $reg[$hash] = $Tokens[$t]
    }
    [IO.File]::WriteAllText((Join-Path $state 'tokens.json'), ($reg | ConvertTo-Json -Depth 5))
}
function Invoke-Mcp([string]$Token, [string]$Method, $Params = @{}, [string]$Trace = 'trace-none') {
    $headers = @{ 'X-Cezar-Trace-Id' = $Trace; Accept = 'application/json, text/event-stream' }
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    $body = @{ jsonrpc = '2.0'; id = 1; method = $Method; params = $Params } | ConvertTo-Json -Depth 6
    try {
        $r = Invoke-WebRequest -Uri $script:url -Method Post -Headers $headers -Body $body -ContentType 'application/json' -SkipHttpErrorCheck -TimeoutSec 10
        [pscustomobject]@{ Code = [int]$r.StatusCode; Body = $r.Content }
    }
    catch { [pscustomobject]@{ Code = 0; Body = $_.Exception.Message } }
}
function Get-Ledger { $p = Join-Path $state 'ledger.jsonl'; if (Test-Path $p) { @(Get-Content $p | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() } }

try {
    # ---------- G0/G1: client contract (static, against the committed files) ----------
    Write-Host '== client contract =='
    $gw = Get-Content -Raw (Join-Path $factory 'cezar/packages/cezar/src/core/mcp-gateway.ts')
    $mcpJson = Get-Content -Raw (Join-Path $factory '.mcp.json')
    Assert 'Claude gateway config is strict and references the token by name, never by value' ($gw -match "'--strict-mcp-config'" -and $gw -match '\\\$\{\$\{TOKEN_ENV\}\}')
    Assert 'Codex gateway config passes the token by environment-variable name' ($gw -match 'bearer_token_env_var: TOKEN_ENV')
    Assert 'gateway is off (fail closed to no MCP) when URL or token is missing' ($gw -match 'if \(!url \|\| !token\) return null')
    Assert 'committed .mcp.json carries no literal credential' ($mcpJson -notmatch '(ghp_|ghs_|github_pat_|Bearer\s+[A-Za-z0-9])')
    & git -C $factory check-ignore -q 'integrations/mcp-gateway/.env'
    Assert 'gateway .env is gitignored' ($LASTEXITCODE -eq 0)
    Assert 'no hosted CI workflow exists' (-not (Test-Path (Join-Path $factory '.github/workflows')))
    $compose = Get-Content -Raw (Join-Path $factory 'integrations/bazzite/obot/compose.yaml')
    Assert 'Obot requires authentication and publishes only on loopback' ($compose -match 'OBOT_SERVER_ENABLE_AUTHENTICATION: "true"' -and $compose -match '127\.0\.0\.1:\$\{OBOT_HOST_PORT')

    # ---------- G1/G2: identity lifecycle against the local gateway ----------
    Write-Host '== identity lifecycle =='
    $future = [DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeSeconds()
    $past = [DateTimeOffset]::UtcNow.AddHours(-1).ToUnixTimeSeconds()
    $good = 'ghs_goodtoken1234567890'; $stale = 'ghs_staletoken1234567890'; $old = 'ghs_oldrotated1234567890'
    $revoked = 'ghs_revokedtoken123456'; $other = 'ghs_projectBtoken1234567'
    Set-Tokens @{
        $good = @{ project = 'A'; expires = $future; repos = @('org/a') }
        $old = @{ project = 'A'; expires = $future; repos = @('org/a'); revoked = $true }
        $revoked = @{ project = 'A'; expires = $future; repos = @('org/a'); revoked = $true }
        $stale = @{ project = 'A'; expires = $past; repos = @('org/a') }
        $other = @{ project = 'B'; expires = $future; repos = @('org/b') }
    }
    Start-Gateway
    $r = Invoke-Mcp $good 'initialize' @{} 'trace-init'
    Assert 'a valid scoped identity initializes' ($r.Code -eq 200)
    $r = Invoke-Mcp '' 'initialize'
    Assert 'a missing identity is denied' ($r.Code -eq 403)
    $r = Invoke-Mcp 'ghs_neverissued1234567' 'initialize'
    Assert 'an unknown token is denied' ($r.Code -eq 403)
    $r = Invoke-Mcp $stale 'tools/list'
    Assert 'an expired token is denied with its reason ledgered' ($r.Code -eq 403 -and (@(Get-Ledger) | Where-Object { $_.reason -eq 'expired' }))
    $r = Invoke-Mcp $revoked 'tools/list'
    Assert 'a revoked token is denied' ($r.Code -eq 403 -and (@(Get-Ledger) | Where-Object { $_.reason -eq 'revoked' }))
    $r = Invoke-Mcp $old 'tools/list'
    Assert 'a rotated-out token no longer works while its replacement does' ($r.Code -eq 403 -and (Invoke-Mcp $good 'tools/list').Code -eq 200)

    # ---------- G2/G3: privilege escalation and isolation ----------
    Write-Host '== authorization =='
    $tools = ((Invoke-Mcp $good 'tools/list').Body | ConvertFrom-Json).result.tools.name
    Assert 'tools/list exposes no write tool' (-not ($tools | Where-Object { $_ -in 'create_pull_request', 'merge_pull_request', 'push_files' }))
    foreach ($w in 'create_pull_request', 'merge_pull_request', 'push_files') {
        $r = Invoke-Mcp $good 'tools/call' @{ name = $w; arguments = @{ repo = 'org/a' } }
        Assert "write tool $w is denied even when called directly" ($r.Code -eq 403)
    }
    $r = Invoke-Mcp $good 'tools/call' @{ name = 'get_file_contents'; arguments = @{ repo = 'org/b' } }
    Assert 'project A cannot read project B repository' ($r.Code -eq 403 -and (@(Get-Ledger) | Where-Object { $_.reason -eq 'cross-project' }))
    $r = Invoke-Mcp $other 'tools/call' @{ name = 'get_file_contents'; arguments = @{ repo = 'org/a' } }
    Assert 'project B cannot read project A repository' ($r.Code -eq 403)
    $r = Invoke-Mcp $good 'tools/call' @{ name = 'get_file_contents'; arguments = @{ repo = 'org/a' } }
    Assert 'an in-scope read-only call is allowed' ($r.Code -eq 200)
    $jobs = 1..4 | ForEach-Object { $t = $good; Start-ThreadJob { param($u, $t) (Invoke-WebRequest -Uri $u -Method Post -Headers @{ Authorization = "Bearer $t" } -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -ContentType 'application/json' -TimeoutSec 10).StatusCode } -ArgumentList $script:url, $t }
    Assert 'concurrent runs sharing one identity all succeed without interference' (@($jobs | Wait-Job -Timeout 30 | Receive-Job | Where-Object { $_ -eq 200 }).Count -eq 4)

    # ---------- failure modes: restart, outage, bad client helper ----------
    Write-Host '== fault injection =='
    Stop-Gateway
    $r = Invoke-Mcp $good 'tools/list'
    Assert 'a gateway outage fails closed (no response, never an implicit allow)' ($r.Code -eq 0)
    Start-Gateway
    $r = Invoke-Mcp $good 'tools/list'
    Assert 'after an Obot restart the registry persists and the identity works again' ($r.Code -eq 200)
    $r = Invoke-Mcp $revoked 'tools/list'
    Assert 'a restart does not resurrect a revoked identity' ($r.Code -eq 403)
    $r = Invoke-WebRequest -Uri $script:url -Method Post -Body '{not json' -ContentType 'application/json' -Headers @{ Authorization = "Bearer $good" } -SkipHttpErrorCheck -TimeoutSec 10
    Assert 'a malformed request is rejected, not executed' ([int]$r.StatusCode -eq 400)

    $helper = Join-Path $factory 'integrations/mcp-gateway/headers.mjs'
    $envFile = Join-Path $work 'gateway.env'
    $oldEnv = $env:CEZ_MCP_GATEWAY_ENV_FILE
    $env:CEZ_MCP_GATEWAY_ENV_FILE = $envFile
    try {
        [IO.File]::WriteAllText($envFile, "OBOT_MCP_TOKEN=$good`n")
        $out = & node $helper 2>&1 | Out-String
        $hdr = $out | ConvertFrom-Json
        Assert 'the client helper emits a bearer header the gateway accepts' ($LASTEXITCODE -eq 0 -and (Invoke-WebRequest -Uri $script:url -Method Post -Headers @{ Authorization = $hdr.Authorization } -Body '{"jsonrpc":"2.0","id":1,"method":"initialize"}' -ContentType 'application/json' -TimeoutSec 10).StatusCode -eq 200)
        [IO.File]::WriteAllText($envFile, "# no token`n")
        $out = & node $helper 2>&1 | Out-String
        Assert 'the client helper fails closed with a useful reason when the token is missing' ($LASTEXITCODE -ne 0 -and $out -match 'OBOT_MCP_TOKEN is not set')
        [IO.File]::WriteAllText($envFile, "OBOT_MCP_TOKEN=$stale`n")
        $hdr = (& node $helper 2>&1 | Out-String) | ConvertFrom-Json
        Assert 'a stale token reaches the gateway and is denied there' ((Invoke-Mcp ($hdr.Authorization -replace '^Bearer ', '') 'tools/list').Code -eq 403)
    }
    finally { if ($null -eq $oldEnv) { Remove-Item Env:CEZ_MCP_GATEWAY_ENV_FILE -ErrorAction SilentlyContinue } else { $env:CEZ_MCP_GATEWAY_ENV_FILE = $oldEnv } }

    # ---------- telemetry: correlation and redaction ----------
    Write-Host '== telemetry and audit =='
    [void](Invoke-Mcp $good 'tools/list' @{} 'cez-run-42-attempt-1')
    [void](Invoke-Mcp "ghs_unknownleak1234567890" 'tools/list' @{} 'cez-run-42-attempt-2')
    $events = Get-Ledger
    $rawLedger = Get-Content -Raw (Join-Path $state 'ledger.jsonl')
    Assert 'ledger events correlate to the Cezar run/attempt trace ID' (@($events | Where-Object { $_.trace -eq 'cez-run-42-attempt-1' -and $_.decision -eq 'allow' -and $_.project -eq 'A' }).Count -eq 1)
    Assert 'denials are ledgered with a reason' (@($events | Where-Object { $_.decision -eq 'deny' -and $_.reason }).Count -ge 6)
    Assert 'the ledger holds no credential from any case above' ($rawLedger -notmatch 'ghs_[A-Za-z0-9]{6,}' -and $rawLedger -notmatch 'Bearer\s+[A-Za-z0-9]')
    Assert 'every ledger event is complete (method, decision, timestamp)' (@($events | Where-Object { -not $_.method -or -not $_.decision -or -not $_.ts }).Count -eq 0)
    Assert 'the token registry stores hashes, not tokens' ((Get-Content -Raw (Join-Path $state 'tokens.json')) -notmatch 'ghs_')
}
finally {
    Stop-Gateway
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
# Cleanup is part of the contract: no gateway process or scratch state survives the run.
Assert 'cleanup removed the scratch state' (-not (Test-Path $work))
if ($script:fail) { Write-Host "OBOT E2E FAILED: $script:fail" -ForegroundColor Red; exit 1 }
Write-Host 'OBOT E2E PASSED' -ForegroundColor Green
