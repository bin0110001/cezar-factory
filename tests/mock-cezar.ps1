# Minimal in-memory mock of Cezar's automations HTTP API (list/get/create/update/delete).
# Request log (one "METHOD path" per line) is appended to -LogFile; seed state from -SeedFile (JSON array).
param([int]$Port, [string]$LogFile, [string]$SeedFile)
$items = [System.Collections.ArrayList]::new()
if ($SeedFile -and (Test-Path $SeedFile)) { foreach ($x in (Get-Content -Raw $SeedFile | ConvertFrom-Json -AsHashtable)) { [void]$items.Add($x) } }
$next = 100
$l = [System.Net.HttpListener]::new(); $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start()
while ($l.IsListening) {
    $ctx = $l.GetContext(); $req = $ctx.Request; $res = $ctx.Response
    $path = $req.Url.AbsolutePath
    Add-Content $LogFile "$($req.HttpMethod) $path"
    $body = $null
    if ($req.HasEntityBody) { $body = [IO.StreamReader]::new($req.InputStream).ReadToEnd() | ConvertFrom-Json -AsHashtable }
    $id = if ($path -match '/automations/([^/]+)$') { [uri]::UnescapeDataString($Matches[1]) } else { $null }
    $out = @{}; $code = 200
    switch ($req.HttpMethod) {
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
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 20 -Compress))
    $res.StatusCode = $code; $res.ContentType = 'application/json'; $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.Close()
}
