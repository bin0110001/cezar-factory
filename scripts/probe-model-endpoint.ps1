#!/usr/bin/env pwsh
<#
.SYNOPSIS
Fails fast when the model endpoint cannot actually generate, before an agent step spends 30 minutes finding out.

.DESCRIPTION
A model host can answer /health and /v1/models while generation is wedged or thrashing (a 16 GB host
that is swapping serves 0.3 tok/s for minutes at a time). This probe therefore runs two stages through
the same OpenAI-compatible path the agents use:

  1. GET  {base}/models              - reachability, authentication, and which model is served.
  2. POST {base}/chat/completions    - a one-token generation, timed.

The whole sequence is retried with backoff so a brief stall does not fail a run, but a host that stays
down fails in seconds with a named code instead of surfacing later as "codex app-server timed out".

Result codes (failureClass is always 'environment'; none of these are defects in the change under work):
  OK                        generation succeeded within the warning latency
  MODEL_SLOW                generation succeeded but slowly (exit 0; the receipt says degraded)
  MODEL_PROBE_SKIPPED       no endpoint is configured (exit 0; protection is off, and the receipt says so)
  MODEL_UNREACHABLE         connection refused, DNS failure or connect timeout
  MODEL_AUTH                401/403 - credential missing or rejected (not retried)
  MODEL_UNAVAILABLE         5xx/429 from the models listing
  MODEL_NO_MODELS           the listing worked but names no model
  MODEL_NOT_SERVED          the requested model is not in the listing (not retried)
  MODEL_GENERATION_TIMEOUT  the one-token generation did not finish in time
  MODEL_GENERATION_ERROR    the generation returned an error or an empty body

Endpoint, key and model come from parameters, else the environment:
  URL    FACTORY_MODEL_PROBE_URL, then LITELLM_URL (+/v1), then FACTORY_VLLM_BASE_URL
  KEY    FACTORY_MODEL_PROBE_KEY, then LITELLM_MASTER_KEY, then VLLM_API_KEY
  MODEL  FACTORY_MODEL_PROBE_MODEL, else 'factory-code' when listed, else the first listed model
FACTORY_MODEL_PROBE_WARN_ONLY=1 behaves like -WarnOnly (record the failure, exit 0) so the preflight can be rolled out
on a host without risking every workflow.
The key is sent only as a bearer header and is never written to the receipt or to output.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl,
    [string]$ApiKey,
    [string]$Model,
    [ValidateRange(1, 120)][int]$ConnectTimeoutSeconds = 10,
    [ValidateRange(1, 600)][int]$GenerationTimeoutSeconds = 60,
    [ValidateRange(1, 600)][int]$WarnLatencySeconds = 20,
    [ValidateRange(1, 10)][int]$Attempts = 3,
    [ValidateRange(0, 120)][int]$BackoffSeconds = 5,
    [ValidateRange(10, 3600)][int]$TotalDeadlineSeconds = 240,
    [string]$OutputPath = '.factory/model-probe.json',
    [switch]$WarnOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function First-Set([string[]]$Names) {
    foreach ($n in $Names) {
        $v = [Environment]::GetEnvironmentVariable($n)
        if (-not [string]::IsNullOrWhiteSpace($v)) { return [pscustomobject]@{ name = $n; value = $v.Trim() } }
    }
    $null
}

function Normalize-BaseUrl([string]$Url) {
    $u = $Url.Trim().TrimEnd('/')
    if ($u -notmatch '/v1$') { $u = "$u/v1" }
    $u
}

# --- configuration (every unset input degrades to "skipped", never to a crash) -------------------------
$urlSource = 'parameter'
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $hit = First-Set @('FACTORY_MODEL_PROBE_URL', 'LITELLM_URL', 'FACTORY_VLLM_BASE_URL')
    if ($hit) { $BaseUrl = $hit.value; $urlSource = $hit.name }
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    $hit = First-Set @('FACTORY_MODEL_PROBE_KEY', 'LITELLM_MASTER_KEY', 'VLLM_API_KEY')
    if ($hit) { $ApiKey = $hit.value }
}
if ([string]::IsNullOrWhiteSpace($Model)) {
    $hit = First-Set @('FACTORY_MODEL_PROBE_MODEL')
    if ($hit) { $Model = $hit.value }
}

if (-not $WarnOnly -and $env:FACTORY_MODEL_PROBE_WARN_ONLY -in '1', 'true') { $WarnOnly = [switch]::new($true) }
$started = Get-Date
$receipt = [ordered]@{
    schemaVersion = 1
    status        = 'unknown'
    code          = $null
    failureClass  = $null
    message       = $null
    checkedAt     = $started.ToUniversalTime().ToString('o')
    endpoint      = $null
    endpointSource = $urlSource
    model         = $null
    attempts      = @()
    metrics       = $null
}

function Write-Receipt {
    try {
        $dir = Split-Path -Parent $OutputPath
        if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
    } catch {
        # A receipt that cannot be written must not mask the probe result.
        [Console]::Error.WriteLine("model-probe: could not write receipt $OutputPath - $($_.Exception.Message)")
    }
}

function Finish([string]$Status, [string]$Code, [string]$Message, [int]$ExitCode) {
    $receipt.status = $Status
    $receipt.code = $Code
    $receipt.message = $Message
    if ($Status -eq 'failed') { $receipt.failureClass = 'environment' }
    $receipt.durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Receipt
    $receipt | ConvertTo-Json -Depth 8 -Compress
    if ($Status -eq 'failed') {
        # Cezar may surface only stderr for a failed command step; keep the reason visible there too.
        [Console]::Error.WriteLine("model-probe: $Code - $Message")
        if ($WarnOnly) { exit 0 }
    }
    exit $ExitCode
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    Finish 'skipped' 'MODEL_PROBE_SKIPPED' 'No model endpoint is configured (FACTORY_MODEL_PROBE_URL, LITELLM_URL or FACTORY_VLLM_BASE_URL); the preflight did not run.' 0
}
try {
    $BaseUrl = Normalize-BaseUrl $BaseUrl
    [void][Uri]$BaseUrl
} catch {
    Finish 'failed' 'MODEL_UNREACHABLE' "The configured model endpoint is not a valid URL: $($_.Exception.Message)" 1
}
$receipt.endpoint = $BaseUrl

# --- HTTP ---------------------------------------------------------------------------------------------
function Invoke-Http([string]$Method, [string]$Url, [string]$Body, [int]$TimeoutSeconds) {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = [ordered]@{ status = 0; body = ''; seconds = 0.0; timedOut = $false; error = $null }
    try {
        $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
        if ($ApiKey) { [void]$req.Headers.TryAddWithoutValidation('Authorization', "Bearer $ApiKey") }
        if ($Body) { $req.Content = [System.Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json') }
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $out.status = [int]$resp.StatusCode
        $out.body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } catch {
        $e = $_.Exception
        $names = @()
        while ($e) { $names += $e.GetType().Name; $e = $e.InnerException }
        if ($names -match 'TaskCanceled|OperationCanceled|Timeout') { $out.timedOut = $true }
        $out.error = $_.Exception.Message
    } finally {
        $sw.Stop()
        $out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        $client.Dispose()
    }
    [pscustomobject]$out
}

# Optional, best-effort load figures from vLLM's Prometheus endpoint; never fails the probe.
function Get-LoadMetrics {
    try {
        $root = $BaseUrl -replace '/v1$', ''
        $r = Invoke-Http 'GET' "$root/metrics" $null 5
        if ($r.status -ne 200) { return $null }
        $pick = {
            param($pattern)
            $m = [regex]::Match($r.body, "(?m)^$pattern(?:\{[^}]*\})?\s+([0-9.eE+-]+)")
            if ($m.Success) { [double]$m.Groups[1].Value } else { $null }
        }
        $metrics = [ordered]@{
            requestsRunning = (& $pick 'vllm:num_requests_running')
            requestsWaiting = (& $pick 'vllm:num_requests_waiting')
            kvCacheUsage    = (& $pick 'vllm:(?:kv|gpu)_cache_usage_perc')
        }
        if (@($metrics.Values | Where-Object { $null -ne $_ }).Count -eq 0) { return $null }
        $metrics
    } catch { $null }
}

# One pass through both stages. Returns @{ ok; retryable; code; message; ... }.
function Invoke-Attempt([int]$Number) {
    $a = [ordered]@{ attempt = $Number; ok = $false; code = $null; message = $null; modelsSeconds = $null; generationSeconds = $null }

    $models = Invoke-Http 'GET' "$BaseUrl/models" $null $ConnectTimeoutSeconds
    $a.modelsSeconds = $models.seconds
    if ($models.status -eq 0) {
        $a.code = 'MODEL_UNREACHABLE'
        $a.message = if ($models.timedOut) { "No answer from $BaseUrl/models within ${ConnectTimeoutSeconds}s." } else { "Could not connect to $BaseUrl : $($models.error)" }
        $a.retryable = $true; return [pscustomobject]$a
    }
    if ($models.status -in 401, 403) {
        $a.code = 'MODEL_AUTH'
        $a.message = "The model endpoint rejected the credential (HTTP $($models.status)). Check FACTORY_MODEL_PROBE_KEY / LITELLM_MASTER_KEY / VLLM_API_KEY."
        $a.retryable = $false; return [pscustomobject]$a
    }
    if ($models.status -ne 200) {
        $a.code = 'MODEL_UNAVAILABLE'
        $a.message = "GET /models returned HTTP $($models.status)."
        $a.retryable = ($models.status -ge 500 -or $models.status -eq 429); return [pscustomobject]$a
    }

    $ids = @()
    try {
        $ids = @(($models.body | ConvertFrom-Json).data | ForEach-Object { $_.id } | Where-Object { $_ })
    } catch {
        $a.code = 'MODEL_UNAVAILABLE'
        $a.message = 'GET /models returned HTTP 200 with a body that is not the OpenAI model listing (a proxy or error page?).'
        $a.retryable = $true; return [pscustomobject]$a
    }
    if ($ids.Count -eq 0) {
        $a.code = 'MODEL_NO_MODELS'
        $a.message = 'GET /models succeeded but lists no model; the server is up with nothing loaded.'
        $a.retryable = $true; return [pscustomobject]$a
    }
    $chosen = $Model
    if ($chosen) {
        if ($chosen -notin $ids) {
            $a.code = 'MODEL_NOT_SERVED'
            $a.message = "Model '$chosen' is not served. Served: $($ids -join ', ')."
            $a.retryable = $false; return [pscustomobject]$a
        }
    } elseif ('factory-code' -in $ids) { $chosen = 'factory-code' } else { $chosen = $ids[0] }
    $receipt.model = $chosen

    $payload = [ordered]@{
        model       = $chosen
        messages    = @(@{ role = 'user'; content = 'Reply with the single word: ok' })
        max_tokens  = 1
        temperature = 0
        stream      = $false
        chat_template_kwargs = @{ enable_thinking = $false }
    } | ConvertTo-Json -Depth 6 -Compress
    $gen = Invoke-Http 'POST' "$BaseUrl/chat/completions" $payload $GenerationTimeoutSeconds
    $a.generationSeconds = $gen.seconds
    if ($gen.timedOut) {
        $a.code = 'MODEL_GENERATION_TIMEOUT'
        $a.message = "A one-token generation did not finish within ${GenerationTimeoutSeconds}s; the model host is reachable but not generating (queue stuck or memory thrash)."
        $a.retryable = $true; return [pscustomobject]$a
    }
    if ($gen.status -eq 0) {
        $a.code = 'MODEL_UNREACHABLE'
        $a.message = "Connection dropped during generation: $($gen.error)"
        $a.retryable = $true; return [pscustomobject]$a
    }
    if ($gen.status -in 401, 403) {
        $a.code = 'MODEL_AUTH'
        $a.message = "Generation was rejected (HTTP $($gen.status))."
        $a.retryable = $false; return [pscustomobject]$a
    }
    if ($gen.status -ne 200) {
        $a.code = 'MODEL_GENERATION_ERROR'
        $a.message = "POST /chat/completions returned HTTP $($gen.status)."
        $a.retryable = ($gen.status -ge 500 -or $gen.status -eq 429); return [pscustomobject]$a
    }
    $hasChoice = $false
    try { $hasChoice = @(($gen.body | ConvertFrom-Json).choices).Count -gt 0 } catch { $hasChoice = $false }
    if (-not $hasChoice) {
        $a.code = 'MODEL_GENERATION_ERROR'
        $a.message = 'POST /chat/completions returned HTTP 200 without any choices.'
        $a.retryable = $true; return [pscustomobject]$a
    }

    $a.ok = $true
    $a.code = if ($gen.seconds -gt $WarnLatencySeconds) { 'MODEL_SLOW' } else { 'OK' }
    $a.message = "Generation took $($gen.seconds)s."
    $a.retryable = $false
    [pscustomobject]$a
}

# --- retry loop, bounded by an overall deadline ---------------------------------------------------------
$last = $null
for ($i = 1; $i -le $Attempts; $i++) {
    try {
        $last = Invoke-Attempt $i
    } catch {
        $last = [pscustomobject]@{ attempt = $i; ok = $false; code = 'MODEL_UNREACHABLE'; message = "Unexpected probe error: $($_.Exception.Message)"; retryable = $true; modelsSeconds = $null; generationSeconds = $null }
    }
    $receipt.attempts = @($receipt.attempts) + @($last)
    if ($last.ok -or -not $last.retryable) { break }
    if ($i -lt $Attempts) {
        $pause = $BackoffSeconds * $i
        $elapsed = ((Get-Date) - $started).TotalSeconds
        # Stop retrying when another full attempt could not finish inside the deadline.
        if ($elapsed + $pause + $ConnectTimeoutSeconds + $GenerationTimeoutSeconds -gt $TotalDeadlineSeconds) { break }
        if ($pause -gt 0) { Start-Sleep -Seconds $pause }
    }
}

$receipt.metrics = Get-LoadMetrics
$load = ''
if ($receipt.metrics -and $null -ne $receipt.metrics.requestsWaiting) {
    $load = " Host load: $($receipt.metrics.requestsRunning) running, $($receipt.metrics.requestsWaiting) waiting, KV cache $($receipt.metrics.kvCacheUsage)."
}

if ($last.ok) {
    $status = if ($last.code -eq 'MODEL_SLOW') { 'degraded' } else { 'ok' }
    Finish $status $last.code ("$($last.message) Model '$($receipt.model)' at $BaseUrl.$load") 0
}
Finish 'failed' $last.code ("$($last.message) (after $(@($receipt.attempts).Count) attempt(s)).$load") 1
