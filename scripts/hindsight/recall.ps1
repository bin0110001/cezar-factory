[CmdletBinding()]
param([string]$Project = $env:FACTORY_PROJECT_ID, [string]$ProjectBank = $env:HINDSIGHT_PROJECT_BANK, [string]$FactoryBank = $env:HINDSIGHT_FACTORY_BANK, [Parameter(Mandatory)][string]$Objective, [Parameter(Mandatory)][string]$TaskClass, [string[]]$Keywords = @(), [string]$FailureSignature = '', [string]$OutputPath = '.factory/context/memory-recall.json')
$ErrorActionPreference = 'Stop'
# Already-resolved issue (see check-already-resolved.ps1): nothing to do.
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
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
$readAt = (Get-Date).ToUniversalTime().ToString('o')
$artifact = [ordered]@{ status = 'miss'; banksQueried = @(); memoryIds = @(); memoryCount = 0; contextChars = 0; selected = @(); deterministicMatches = @(); retrievalCapture = [ordered]@{ schemaVersion = 1; project = $Project; readAt = $readAt; deterministicMatches = @(); memories = @() } }
function Get-Sha256([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
$deterministicPath = if ($env:HINDSIGHT_DETERMINISTIC_INDEX) { $env:HINDSIGHT_DETERMINISTIC_INDEX } else { '' }
if ($deterministicPath -and (Test-Path -LiteralPath $deterministicPath)) {
    try {
        $index = Get-Content -Raw -LiteralPath $deterministicPath | ConvertFrom-Json
        $needles = @(@($FailureSignature) + @($Keywords) | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
        foreach ($row in @($index.records)) {
            $value = if ($row.kind -eq 'fingerprint') { [string]$row.fingerprint } elseif ($row.kind -eq 'test') { [string]$row.testId } else { '' }
            if (-not $value -or $needles -notcontains $value.ToLowerInvariant()) { continue }
            $id = if ($row.id) { [string]$row.id } else { $value }
            $reference = if ($row.ref) { [string]$row.ref } else { $id }
            if (($id + ' ' + $reference + ' ' + $value) -match '(?i)(transcript|raw log|source file|credential|password|token|secret|personal data|temporary state|bearer\s+\S+)') { continue }
            if (@($artifact.deterministicMatches | Where-Object id -eq $id).Count) { continue }
            $hash = if ($row.contentHash -match '^[a-f0-9]{64}$') { [string]$row.contentHash } else { Get-Sha256 ($row | ConvertTo-Json -Compress -Depth 8) }
            $artifact.deterministicMatches += [ordered]@{ kind = [string]$row.kind; id = $id; ref = $reference; value = $value; contentHash = $hash; readAt = $readAt }
            $artifact.retrievalCapture.deterministicMatches += [ordered]@{ kind = [string]$row.kind; id = $id; ref = $reference; contentHash = $hash }
            if ($artifact.deterministicMatches.Count -ge 100) { break }
        }
    } catch { $artifact.deterministicMatches = @(); $artifact.retrievalCapture.deterministicMatches = @() }
}
$provenancePath = if ($env:HINDSIGHT_PROVENANCE_INDEX) { $env:HINDSIGHT_PROVENANCE_INDEX } elseif ($env:CEZ_HOME) { Join-Path $env:CEZ_HOME 'hindsight/provenance.jsonl' } else { Join-Path '.factory/context' 'hindsight-provenance.jsonl' }
$supersededIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$provenanceById = @{}
if (Test-Path -LiteralPath $provenancePath) {
    foreach ($line in Get-Content -LiteralPath $provenancePath) {
        try {
            $entry = $line | ConvertFrom-Json
            if ($entry.event -eq 'retained' -and $entry.record.id) { $provenanceById[[string]$entry.record.id] = $entry.record }
            if ($entry.event -eq 'retained' -and $entry.supersedes) {
                $priorId = [string]$entry.supersedes; [void]$supersededIds.Add($priorId)
                if ($provenanceById.ContainsKey($priorId)) {
                    $provenanceById[$priorId] | Add-Member -NotePropertyName superseded -NotePropertyValue $true -Force
                    $provenanceById[$priorId] | Add-Member -NotePropertyName supersededBy -NotePropertyValue ([string]$entry.record.id) -Force
                }
            }
        } catch { }
    }
}
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
            $parsed = $null
            try { $parsed = [string]$content.text | ConvertFrom-Json -ErrorAction Stop } catch { }
            $rows = @()
            if ($parsed -is [array]) { $rows = @($parsed) }
            elseif ($parsed -and $parsed.memories) { $rows = @($parsed.memories) }
            elseif ($parsed -and $parsed.results) { $rows = @($parsed.results) }
            elseif ($parsed -and $parsed.items) { $rows = @($parsed.items) }
            elseif ($parsed -and ($parsed.id -or $parsed.memoryId)) { $rows = @($parsed) }
            else { $rows = @([pscustomobject]@{ id = $content.id; excerpt = [string]$content.text }) }
            foreach ($memory in $rows) {
                if ($artifact.memoryCount -ge 8) { break }
                $metadata = if ($memory.metadata) { $memory.metadata } else { $null }
                $rawExcerpt = if ($memory.excerpt) { [string]$memory.excerpt } elseif ($memory.content) { [string]$memory.content } elseif ($memory.text) { [string]$memory.text } else { [string]$content.text }
                $excerpt = $rawExcerpt -replace '(?i)(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*\S+|bearer\s+\S+', '[redacted]'
                $remaining = 12000 - [int]$artifact.contextChars; if ($remaining -le 0) { break }
                $excerpt = $excerpt.Substring(0, [Math]::Min($excerpt.Length, $remaining)); if (-not $excerpt) { continue }
                $id = if ($memory.id) { [string]$memory.id } elseif ($memory.memoryId) { [string]$memory.memoryId } else { "mcp-$bank-$($artifact.memoryCount + 1)" }
                $localMemory = $provenanceById[$id]
                if ($supersededIds.Contains($id) -or $localMemory.superseded -or $metadata.superseded) { continue }
                $entryReadAt = (Get-Date).ToUniversalTime().ToString('o')
                $versionValue = $null; $rawVersion = if ($localMemory.version) { $localMemory.version } else { $metadata.version }
                if ([string]$rawVersion -match '^\d+$' -and [long]$rawVersion -gt 0) { $versionValue = [long]$rawVersion }
                $contentHash = if ($localMemory.contentHash -match '^[a-f0-9]{64}$') { [string]$localMemory.contentHash } elseif ($metadata.contentHash -match '^[a-f0-9]{64}$') { [string]$metadata.contentHash } else { Get-Sha256 $excerpt }
                $validationStatus = if ($localMemory.validationStatus) { [string]$localMemory.validationStatus } elseif ($metadata.validationStatus -in @('validated','unvalidated')) { [string]$metadata.validationStatus } else { 'unvalidated' }
                $capture = [ordered]@{ id = $id; version = $versionValue; contentHash = $contentHash; readAt = $entryReadAt; validationStatus = $validationStatus }
                $artifact.selected += [ordered]@{ id = $id; excerpt = $excerpt; version = $versionValue; contentHash = $contentHash; readAt = $entryReadAt; validationStatus = $validationStatus; superseded = $false }; $artifact.retrievalCapture.memories += $capture
                $artifact.memoryIds += $id; $artifact.memoryCount++; $artifact.contextChars += $excerpt.Length
            }
        }
    }
    if ($artifact.memoryCount -or $artifact.deterministicMatches.Count) { $artifact.status = 'ok' }
} catch {
    $artifact.status = 'unavailable'; $artifact.warning = 'Hindsight recall unavailable; continuing without recall.'; $artifact.errorClass = $_.Exception.GetType().Name
}
$artifact | ConvertTo-Json -Depth 8 | Set-Content -NoNewline $OutputPath
if ($artifact.status -eq 'unavailable') { Write-Warning $artifact.warning }
exit 0
