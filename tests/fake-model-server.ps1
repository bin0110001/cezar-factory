#!/usr/bin/env pwsh
# Minimal OpenAI-compatible fake used by tests/model-probe.ps1. Modes:
#   ok        healthy listing and generation, plus a vLLM-style /metrics
#   slow      generation answers after -DelaySeconds
#   hang      generation sleeps -DelaySeconds (the probe is expected to time out first)
#   auth      every request is 401
#   empty     listing succeeds with no models
#   flaky     the first listing request is 503, later ones are healthy
#   badbody   listing is 200 with a non-JSON body
# In every mode a request whose bearer token is not 'sk-test-key' is answered 401, so a probe
# that forgets to send its key fails the test instead of passing silently.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][ValidateSet('ok', 'slow', 'hang', 'auth', 'empty', 'flaky', 'badbody')][string]$Mode,
    [int]$DelaySeconds = 2
)
$ErrorActionPreference = 'Stop'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
$listingHits = 0
function Send($ctx, [int]$Status, [string]$Body, [string]$Type = 'application/json') {
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $ctx.Response.StatusCode = $Status
        $ctx.Response.ContentType = $Type
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $ctx.Response.Close()
    } catch { } # the probe may already have given up and closed the socket
}
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.AbsolutePath
    $auth = $ctx.Request.Headers['Authorization']
    if ($Mode -eq 'auth' -or $auth -ne 'Bearer sk-test-key') { Send $ctx 401 '{"error":"bearer token required"}'; continue }
    switch ($path) {
        '/v1/models' {
            $listingHits++
            if ($Mode -eq 'flaky' -and $listingHits -eq 1) { Send $ctx 503 '{"error":"warming up"}'; break }
            if ($Mode -eq 'badbody') { Send $ctx 200 '<html>proxy error</html>' 'text/html'; break }
            if ($Mode -eq 'empty') { Send $ctx 200 '{"object":"list","data":[]}'; break }
            Send $ctx 200 '{"object":"list","data":[{"id":"factory-small"},{"id":"factory-code"}]}'
        }
        '/v1/chat/completions' {
            if ($Mode -in 'slow', 'hang') { Start-Sleep -Seconds $DelaySeconds }
            Send $ctx 200 '{"choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}'
        }
        '/metrics' {
            Send $ctx 200 "vllm:num_requests_running{model_name=`"x`"} 2.0`nvllm:num_requests_waiting{model_name=`"x`"} 1.0`nvllm:kv_cache_usage_perc{model_name=`"x`"} 0.83`n" 'text/plain'
        }
        default { Send $ctx 404 '{}' }
    }
}
