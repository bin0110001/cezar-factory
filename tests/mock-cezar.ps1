# Minimal TCP-based mock of Cezar's automations HTTP API.
# TcpListener is used instead of HttpListener because the latter is unavailable
# in some Windows-hosted CI runners with restricted handle access.
param([int]$Port, [string]$LogFile, [string]$SeedFile)
$ErrorActionPreference = 'Stop'
$items = [System.Collections.ArrayList]::new()
if ($SeedFile -and (Test-Path $SeedFile)) {
    foreach ($x in (Get-Content -Raw $SeedFile | ConvertFrom-Json -AsHashtable)) { [void]$items.Add($x) }
}
$next = 100
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

function Send-Response($Stream, [int]$Code, $Body) {
    $json = ($Body | ConvertTo-Json -Depth 20 -Compress)
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $reason = if ($Code -eq 201) { 'Created' } else { 'OK' }
    $head = "HTTP/1.1 $Code $reason`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
    $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($headBytes, 0, $headBytes.Length)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $reader = $null
        try {
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) { continue }
            $parts = $requestLine.Split(' ')
            $method = $parts[0]; $path = $parts[1]
            $headers = @{}
            while (($line = $reader.ReadLine()) -ne '') {
                $pair = $line.Split(':', 2)
                if ($pair.Count -eq 2) { $headers[$pair[0].Trim().ToLowerInvariant()] = $pair[1].Trim() }
            }
            $body = $null
            if ($headers.ContainsKey('content-length') -and [int]$headers['content-length'] -gt 0) {
                $buffer = [char[]]::new([int]$headers['content-length'])
                $read = 0
                while ($read -lt $buffer.Length) { $read += $reader.Read($buffer, $read, $buffer.Length - $read) }
                $body = (-join $buffer) | ConvertFrom-Json -AsHashtable
            }
            Add-Content $LogFile "$method $path"
            $id = if ($path -match '/automations/([^/]+)$') { [uri]::UnescapeDataString($Matches[1]) } else { $null }
            $out = @{}; $code = 200
            switch ($method) {
                'GET' {
                    if ($id) { $out = @{ automation = ($items | Where-Object { $_.id -eq $id } | Select-Object -First 1) } }
                    else { $out = @{ available = $true; automations = @($items | ForEach-Object { @{ id = $_.id; name = $_.name; enabled = $_.enabled } }) } }
                }
                'POST' {
                    $a = @{} + $body; $a.id = "a$next"; $next++; $a.revision = 1; $a.enabled = [bool]$body.enable; $a.Remove('enable')
                    [void]$items.Add($a); $out = @{ automation = $a }; $code = 201
                }
                'PUT' {
                    $cur = $items | Where-Object { $_.id -eq $id } | Select-Object -First 1
                    foreach ($k in $body.Keys) { if ($k -ne 'expectedRevision') { $cur[$k] = $body[$k] } }
                    $cur.revision = [int]$cur.revision + 1; $out = @{ automation = $cur }
                }
                'DELETE' { $cur = $items | Where-Object { $_.id -eq $id } | Select-Object -First 1; $items.Remove($cur); $out = @{ ok = $true } }
                default { $code = 404; $out = @{ error = 'not found' } }
            }
            Send-Response $stream $code $out
        }
        finally { if ($reader) { $reader.Dispose() }; $client.Dispose() }
    }
}
finally { $listener.Stop() }
