[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('create','inspect','release')][string]$Action,
    [Parameter(Mandatory)][int]$Issue,
    [string]$Owner = $env:FACTORY_LEASE_OWNER,
    [ValidateRange(1,1440)][int]$Minutes = 30,
    [string]$GhCommand = 'gh',
    [string]$Repository = ''
)

$ErrorActionPreference = 'Stop'
$now = [DateTimeOffset]::UtcNow
$marker = "<!-- factory-lease:$Issue -->"
function Invoke-Gh([string[]]$Arguments) {
    $all = @($Arguments); if ($Repository) { $all += @('--repo', $Repository) }
    $output = & $GhCommand @all 2>&1
    if ($LASTEXITCODE -ne 0) { throw "GitHub lease operation failed: $($output -join "`n")" }
    return ($output -join "`n")
}
function Get-CurrentLease {
    $raw = Invoke-Gh @('issue','view',[string]$Issue,'--json','comments')
    $comments = @((ConvertFrom-Json $raw).comments)
    for ($index = $comments.Count - 1; $index -ge 0; $index--) {
        $comment = $comments[$index]
        $body = [string]$comment.body
        if ($body -notlike "*$marker*") { continue }
        $json = ($body -split [regex]::Escape($marker), 2)[1].Trim()
        try { return ($json | ConvertFrom-Json) } catch { throw "Factory lease marker on issue #$Issue is malformed." }
    }
    return $null
}
function Add-LeaseMarker($Value) {
    $temp = Join-Path ([IO.Path]::GetTempPath()) "factory-lease-$([guid]::NewGuid()).md"
    try {
        "$marker`n$($Value | ConvertTo-Json -Compress)" | Set-Content -NoNewline $temp
        Invoke-Gh @('issue','comment',[string]$Issue,'--body-file',$temp) | Out-Null
    } finally { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
}

$current = Get-CurrentLease
$active = $current -and -not $current.releasedAt -and $current.expiresAt -and ([DateTimeOffset]::Parse($current.expiresAt) -gt $now)
if ($Action -eq 'inspect') { if ($current) { $current | ConvertTo-Json } else { @{ issue=$Issue; status='none' } | ConvertTo-Json }; exit 0 }
if ($Action -eq 'create') {
    if (-not $Owner) { throw 'A lease owner is required.' }
    if ($active) {
        if ($current.owner -eq $Owner) { $current | ConvertTo-Json; exit 0 }
        throw "Issue $Issue already has an active lease owned by $($current.owner)."
    }
    $lease = [ordered]@{ issue=$Issue; owner=$Owner; createdAt=$now.ToString('o'); expiresAt=$now.AddMinutes($Minutes).ToString('o'); releasedAt=$null }
    Add-LeaseMarker $lease
    $lease | ConvertTo-Json
    exit 0
}
if (-not $current -or $current.releasedAt) { @{ issue=$Issue; released=$true; idempotent=$true } | ConvertTo-Json; exit 0 }
$release = [ordered]@{ issue=$Issue; owner=$current.owner; createdAt=$current.createdAt; expiresAt=$current.expiresAt; releasedAt=$now.ToString('o') }
Add-LeaseMarker $release
$release | ConvertTo-Json
