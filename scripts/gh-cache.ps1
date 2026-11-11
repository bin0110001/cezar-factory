# Short-lived on-disk cache for read-only `gh` list calls. Dot-source this file.
#
# One maintenance run executes several scripts that each list every open issue. They run in the
# same worktree seconds apart, so the first script's answer serves the rest. The cache lives under
# `.factory/gh-cache` (override with FACTORY_GH_CACHE_DIR) and entries expire after
# FACTORY_GH_CACHE_TTL_SECONDS (default 120, capped at 900; 0 disables caching entirely).
#
# Only read-only listings belong here. A script that edits issues calls Clear-GhCache afterwards so
# the next reader fetches fresh labels.

function Get-GhCacheTtlSeconds {
    $ttl = 0
    if ([string]::IsNullOrWhiteSpace($env:FACTORY_GH_CACHE_TTL_SECONDS)) { return 120 }
    if ([int]::TryParse($env:FACTORY_GH_CACHE_TTL_SECONDS.Trim(), [ref]$ttl) -and $ttl -ge 0) { return [Math]::Min($ttl, 900) }
    120
}

function Get-GhCacheDirectory {
    if ($env:FACTORY_GH_CACHE_DIR) { $env:FACTORY_GH_CACHE_DIR } else { '.factory/gh-cache' }
}

function Get-GhCachePath([string]$Key) {
    $bytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Key))
    Join-Path (Get-GhCacheDirectory) ("$([Convert]::ToHexString($bytes).ToLowerInvariant()).json")
}

# Returns the cached text for $Key while it is fresh, otherwise runs $Fetch (which returns the raw
# `gh` output) and caches the result. -Refresh skips the read but still stores the fresh answer.
# A cache that cannot be read or written never fails the caller; it just costs the call.
function Get-GhCachedText([string]$Key, [scriptblock]$Fetch, [switch]$Refresh) {
    $ttl = Get-GhCacheTtlSeconds
    $path = Get-GhCachePath $Key
    if ($ttl -gt 0 -and -not $Refresh -and (Test-Path -LiteralPath $path)) {
        $age = ([DateTime]::UtcNow - (Get-Item -LiteralPath $path).LastWriteTimeUtc).TotalSeconds
        if ($age -ge 0 -and $age -lt $ttl) {
            try { return [IO.File]::ReadAllText($path) } catch { }
        }
    }
    $text = (@(& $Fetch) -join "`n")
    if ($ttl -gt 0) {
        try {
            New-Item -ItemType Directory -Force -Path (Get-GhCacheDirectory) | Out-Null
            $temp = "$path.$PID.tmp"
            [IO.File]::WriteAllText($temp, $text)
            Move-Item -Force -LiteralPath $temp -Destination $path
        } catch { }
    }
    $text
}

function Clear-GhCache {
    try {
        $directory = Get-GhCacheDirectory
        if (Test-Path -LiteralPath $directory) { Get-ChildItem -LiteralPath $directory -Filter '*.json' -File | Remove-Item -Force }
    } catch { }
}
