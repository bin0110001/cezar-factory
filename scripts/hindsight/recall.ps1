[CmdletBinding()]
param([string]$Project = $env:FACTORY_PROJECT_ID, [string]$ProjectBank = $env:HINDSIGHT_PROJECT_BANK, [string]$FactoryBank = $env:HINDSIGHT_FACTORY_BANK, [Parameter(Mandatory)][string]$Objective, [Parameter(Mandatory)][string]$TaskClass, [string[]]$Keywords = @(), [string]$FailureSignature = '', [string]$OutputPath = '.factory/context/memory-recall.json')
$ErrorActionPreference = 'Stop'
if (-not $Project) { $Project = (Split-Path -Leaf (Get-Location)) }
if (-not $ProjectBank) { $ProjectBank = "project-$Project" }
$python = Get-Command python3 -ErrorAction SilentlyContinue; if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if ($python) {
    & $python.Source (Join-Path $PSScriptRoot 'client.py') recall --project $Project --project-bank $ProjectBank --factory-bank $FactoryBank --objective $Objective --task-class $TaskClass --failure-signature $FailureSignature --output $OutputPath --keywords $Keywords
    exit $LASTEXITCODE
}

# Cezar's current image intentionally has no Python runtime. Keep the Python
# client as the portable implementation, but use this equivalent bounded MCP
# path in the PowerShell-only workflow host.
$parent = Split-Path -Parent $OutputPath; if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$artifact = [ordered]@{ status = 'miss'; banksQueried = @(); memoryIds = @(); memoryCount = 0; contextChars = 0; selected = @() }
if (-not $env:HINDSIGHT_URL) {
    $artifact.status = 'unavailable'; $artifact.warning = 'Hindsight is not configured; continuing without recall.'
    $artifact | ConvertTo-Json -Depth 6 | Set-Content -NoNewline $OutputPath
    Write-Warning $artifact.warning
    exit 0
}
function Invoke-HindsightMcp([string]$Bank, $Payload, [string]$SessionId = '') {
    $headers = @{ Accept = 'application/json, text/event-stream' }
    if ($env:HINDSIGHT_AUTH_TOKEN) { $headers.Authorization = "Bearer $env:HINDSIGHT_AUTH_TOKEN" }
    if ($SessionId) { $headers.'Mcp-Session-Id' = $SessionId }
    $endpoint = "$($env:HINDSIGHT_URL.TrimEnd('/'))/mcp/$([Uri]::EscapeDataString($Bank))/"
    $response = Invoke-WebRequest -Method Post -Uri $endpoint -Headers $headers -ContentType 'application/json' -Body ($Payload | ConvertTo-Json -Compress -Depth 8) -TimeoutSec 15
    $data = (($response.Content -split "`n") | Where-Object { $_ -like 'data:*' } | ForEach-Object { $_.Substring(5).Trim() }) -join "`n"
    if (-not $data) { return [pscustomobject]@{ body = $null; session = $response.Headers['mcp-session-id'] } }
    return [pscustomobject]@{ body = ($data | ConvertFrom-Json); session = $response.Headers['mcp-session-id'] }
}
try {
    $query = (@($Objective, $TaskClass, $Keywords, $FailureSignature) | Where-Object { $_ } | Join-String -Separator ' ').Substring(0, [Math]::Min(2500, (@($Objective, $TaskClass, $Keywords, $FailureSignature) | Where-Object { $_ } | Join-String -Separator ' ').Length))
    foreach ($bank in @($ProjectBank, $FactoryBank) | Select-Object -Unique) {
        if (-not $bank -or $artifact.memoryCount -ge 8) { continue }
        $artifact.banksQueried += $bank
        $init = Invoke-HindsightMcp $bank @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'cezar-factory'; version = '1' } } }
        if (-not $init.session -or $init.body.error) { throw 'Hindsight MCP initialization failed.' }
        Invoke-HindsightMcp $bank @{ jsonrpc = '2.0'; method = 'notifications/initialized'; params = @{} } $init.session | Out-Null
        $reply = Invoke-HindsightMcp $bank @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{ name = 'recall'; arguments = @{ query = $query; budget = 'low'; max_tokens = 3000 } } } $init.session
        if ($reply.body.error) { throw 'Hindsight MCP recall failed.' }
        foreach ($content in @($reply.body.result.content | Where-Object { $_.type -eq 'text' })) {
            if ($artifact.memoryCount -ge 8) { break }
            $excerpt = ([string]$content.text) -replace '(?i)(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*\S+|bearer\s+\S+', '[redacted]'
            $remaining = 12000 - [int]$artifact.contextChars; if ($remaining -le 0) { break }
            $excerpt = $excerpt.Substring(0, [Math]::Min($excerpt.Length, $remaining)); if (-not $excerpt) { continue }
            $id = if ($content.id) { [string]$content.id } else { "mcp-$bank-$($artifact.memoryCount + 1)" }
            $artifact.selected += [ordered]@{ id = $id; excerpt = $excerpt }; $artifact.memoryIds += $id; $artifact.memoryCount++; $artifact.contextChars += $excerpt.Length
        }
    }
    if ($artifact.memoryCount) { $artifact.status = 'ok' }
} catch {
    $artifact.status = 'unavailable'; $artifact.warning = 'Hindsight recall unavailable; continuing without recall.'; $artifact.errorClass = $_.Exception.GetType().Name
}
$artifact | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
if ($artifact.status -eq 'unavailable') { Write-Warning $artifact.warning }
exit 0
