#!/usr/bin/env pwsh
# Exercises scripts/probe-model-endpoint.ps1 against tests/fake-model-server.ps1.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$probe = Join-Path $factory 'scripts/probe-model-endpoint.ps1'
$server = Join-Path $PSScriptRoot 'fake-model-server.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) "model-probe-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$script:failures = 0
function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ }
}
function Get-FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p
}
function Start-Fake([string]$Mode, [int]$Port, [int]$Delay = 2) {
    $proc = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-File', $server, '-Port', $Port, '-Mode', $Mode, '-DelaySeconds', $Delay)
    for ($i = 0; $i -lt 100; $i++) {
        try { $c = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $Port); $c.Dispose(); return $proc } catch { Start-Sleep -Milliseconds 100 }
    }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "fake model server ($Mode) did not start"
}
# Runs the probe in a child pwsh so `exit` and the environment are isolated; returns exit code and receipt.
function Run-Probe([hashtable]$Params, [hashtable]$Env = @{}) {
    $out = Join-Path $temp ("receipt-{0}.json" -f [guid]::NewGuid().ToString('N').Substring(0, 6))
    $argList = @('-NoProfile', '-File', $probe, '-OutputPath', $out)
    foreach ($k in $Params.Keys) {
        if ($Params[$k] -is [bool] -or $Params[$k] -is [switch]) { if ($Params[$k]) { $argList += "-$k" } } else { $argList += "-$k"; $argList += [string]$Params[$k] }
    }
    $saved = @{}
    foreach ($k in @('FACTORY_MODEL_PROBE_URL', 'LITELLM_URL', 'FACTORY_VLLM_BASE_URL', 'FACTORY_MODEL_PROBE_KEY', 'LITELLM_MASTER_KEY', 'VLLM_API_KEY', 'FACTORY_MODEL_PROBE_MODEL') + @($Env.Keys)) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
        [Environment]::SetEnvironmentVariable($k, $(if ($Env.ContainsKey($k)) { $Env[$k] } else { $null }))
    }
    try {
        $text = (& pwsh @argList 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $receipt = if (Test-Path $out) { Get-Content -LiteralPath $out -Raw | ConvertFrom-Json } else { $null }
    [pscustomobject]@{ exit = $code; text = $text; receipt = $receipt; raw = $(if (Test-Path $out) { Get-Content -LiteralPath $out -Raw } else { '' }) }
}
function With-Fake([string]$Mode, [scriptblock]$Body, [int]$Delay = 2) {
    $port = Get-FreePort
    $proc = Start-Fake $Mode $port $Delay
    try { & $Body "http://127.0.0.1:$port/v1" } finally { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
$fast = @{ Attempts = 1; BackoffSeconds = 0; ConnectTimeoutSeconds = 3 }
# Later keys win, unlike the + operator, which throws on a duplicate.
function Merge([hashtable]$Base, [hashtable]$Over) { $m = $Base.Clone(); foreach ($k in $Over.Keys) { $m[$k] = $Over[$k] }; $m }
try {
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    With-Fake 'ok' {
        param($url)
        $r = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key' })
        Check 'healthy host: exit 0, status ok, picks factory-code' ($r.exit -eq 0 -and $r.receipt.status -eq 'ok' -and $r.receipt.code -eq 'OK' -and $r.receipt.model -eq 'factory-code')
        Check 'healthy host: vLLM load metrics are recorded' ($r.receipt.metrics.requestsWaiting -eq 1 -and $r.receipt.metrics.kvCacheUsage -eq 0.83)
        Check 'the API key never reaches the receipt or output' ($r.raw -notmatch 'sk-test-key' -and $r.text -notmatch 'sk-test-key')
        $viaEnv = Run-Probe $fast @{ FACTORY_MODEL_PROBE_URL = $url; LITELLM_MASTER_KEY = 'sk-test-key' }
        Check 'endpoint and key resolve from the environment' ($viaEnv.exit -eq 0 -and $viaEnv.receipt.endpointSource -eq 'FACTORY_MODEL_PROBE_URL')
        $noV1 = Run-Probe $fast @{ LITELLM_URL = ($url -replace '/v1$', '/'); LITELLM_MASTER_KEY = 'sk-test-key' }
        Check 'a LiteLLM base URL without /v1 is normalized' ($noV1.exit -eq 0 -and $noV1.receipt.endpoint -eq $url)
        $named = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key'; Model = 'factory-small' })
        Check 'an explicitly requested served model is used' ($named.exit -eq 0 -and $named.receipt.model -eq 'factory-small')
        $missing = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key'; Model = 'nope' })
        Check 'a model that is not served fails as MODEL_NOT_SERVED' ($missing.exit -eq 1 -and $missing.receipt.code -eq 'MODEL_NOT_SERVED')
        $noKey = Run-Probe (Merge $fast @{ BaseUrl = $url })
        Check 'a missing credential fails as MODEL_AUTH without retrying' ($noKey.exit -eq 1 -and $noKey.receipt.code -eq 'MODEL_AUTH' -and @($noKey.receipt.attempts).Count -eq 1)
    }

    With-Fake 'slow' {
        param($url)
        $r = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key'; WarnLatencySeconds = 1 })
        Check 'slow but working generation is degraded, not failed' ($r.exit -eq 0 -and $r.receipt.status -eq 'degraded' -and $r.receipt.code -eq 'MODEL_SLOW')
    } 3

    With-Fake 'hang' {
        param($url)
        $r = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key'; GenerationTimeoutSeconds = 2 })
        Check 'a reachable host that will not generate fails as MODEL_GENERATION_TIMEOUT' ($r.exit -eq 1 -and $r.receipt.code -eq 'MODEL_GENERATION_TIMEOUT' -and $r.receipt.failureClass -eq 'environment')
        $warn = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key'; GenerationTimeoutSeconds = 2; WarnOnly = $true })
        Check '-WarnOnly records the failure but exits 0' ($warn.exit -eq 0 -and $warn.receipt.status -eq 'failed')
    } 8

    With-Fake 'auth' {
        param($url)
        $r = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key'; Attempts = 3 })
        Check 'a rejected credential is not retried' ($r.exit -eq 1 -and $r.receipt.code -eq 'MODEL_AUTH' -and @($r.receipt.attempts).Count -eq 1)
    }

    With-Fake 'empty' {
        param($url)
        $r = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key' })
        Check 'a server with nothing loaded fails as MODEL_NO_MODELS' ($r.exit -eq 1 -and $r.receipt.code -eq 'MODEL_NO_MODELS')
    }

    With-Fake 'badbody' {
        param($url)
        $r = Run-Probe (Merge $fast @{ BaseUrl = $url; ApiKey = 'sk-test-key' })
        Check 'a proxy error page behind HTTP 200 is not mistaken for a model listing' ($r.exit -eq 1 -and $r.receipt.code -eq 'MODEL_UNAVAILABLE')
    }

    With-Fake 'flaky' {
        param($url)
        $r = Run-Probe @{ BaseUrl = $url; ApiKey = 'sk-test-key'; Attempts = 3; BackoffSeconds = 1; ConnectTimeoutSeconds = 3 }
        Check 'a transient 503 is retried and the probe recovers' ($r.exit -eq 0 -and $r.receipt.status -eq 'ok' -and @($r.receipt.attempts).Count -eq 2 -and $r.receipt.attempts[0].code -eq 'MODEL_UNAVAILABLE')
    }

    $dead = Get-FreePort
    $r = Run-Probe (Merge $fast @{ BaseUrl = "http://127.0.0.1:$dead/v1"; ApiKey = 'sk-test-key' })
    Check 'nothing listening fails as MODEL_UNREACHABLE' ($r.exit -eq 1 -and $r.receipt.code -eq 'MODEL_UNREACHABLE')
    $r = Run-Probe @{ BaseUrl = "http://127.0.0.1:$dead/v1"; Attempts = 3; BackoffSeconds = 1; ConnectTimeoutSeconds = 2; GenerationTimeoutSeconds = 2; TotalDeadlineSeconds = 20 }
    Check 'an unreachable host is retried up to the attempt limit' ($r.exit -eq 1 -and @($r.receipt.attempts).Count -eq 3)
    $r = Run-Probe @{ BaseUrl = 'not a url ::'; Attempts = 1 }
    Check 'a malformed endpoint fails cleanly instead of throwing' ($r.exit -eq 1 -and $r.receipt.code -eq 'MODEL_UNREACHABLE')
    $r = Run-Probe @{}
    Check 'no configured endpoint is reported as skipped, exit 0' ($r.exit -eq 0 -and $r.receipt.status -eq 'skipped' -and $r.receipt.code -eq 'MODEL_PROBE_SKIPPED')
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($script:failures) { exit 1 }
