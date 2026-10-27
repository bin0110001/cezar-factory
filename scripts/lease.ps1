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
function Get-IssueSnapshot {
    $raw = Invoke-Gh @('issue','view',[string]$Issue,'--json','comments,updatedAt')
    $snapshot = ConvertFrom-Json -InputObject $raw -DateKind String
    if ([string]::IsNullOrWhiteSpace([string]$snapshot.updatedAt)) { throw "Issue #$Issue has no revision timestamp; refusing a lease write." }
    return $snapshot
}
function Get-CurrentLease($Snapshot) {
    $comments = @($Snapshot.comments)
    for ($index = $comments.Count - 1; $index -ge 0; $index--) {
        $comment = $comments[$index]
        $body = [string]$comment.body
        if ($body -notlike "*$marker*") { continue }
        $json = (($body -split [regex]::Escape($marker), 2)[1]).Trim()
        try { return ($json | ConvertFrom-Json) } catch { throw "Factory lease marker on issue #$Issue is malformed." }
    }
    return $null
}
function Get-ActionOperationKey($CommentBody) {
    $match = [regex]::Match([string]$CommentBody, '<!-- factory:effect-action:v1:([A-Za-z0-9+/=]+) -->')
    if (-not $match.Success) { return $null }
    try {
        $actionJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Groups[1].Value))
        return [string](ConvertFrom-Json $actionJson).operationKey
    } catch { return $null }
}
function Test-OperationReceipt($Snapshot, [string]$OperationKey) {
    foreach ($comment in @($Snapshot.comments)) {
        if ((Get-ActionOperationKey ([string]$comment.body)) -eq $OperationKey) { return $true }
    }
    return $false
}
function Add-LeaseMarker($Value, [string]$Rationale, [string]$OperationKey, [string]$ExpectedRevision) {
    $payload = "$marker`n$($Value | ConvertTo-Json -Compress)"
    $bodyHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($payload))).ToLowerInvariant()
    $action = [ordered]@{
        schemaVersion = 1
        target = @{ kind = 'github_issue'; id = $Issue }
        expectedRevision = $ExpectedRevision
        operation = 'github.issue.add_comment'
        arguments = @{ bodySha256 = $bodyHash }
        rationale = $Rationale
        operationKey = $OperationKey
    }
    $actionEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($action | ConvertTo-Json -Compress -Depth 6)))
    $body = "<!-- factory:effect-action:v1:$actionEncoded -->`n$payload"
    $beforeWrite = Get-IssueSnapshot
    if (Test-OperationReceipt $beforeWrite $OperationKey) { return }
    if ([string]$beforeWrite.updatedAt -ne $ExpectedRevision) { throw "Issue #$Issue changed since the lease action was prepared; refusing to write." }
    $temp = Join-Path ([IO.Path]::GetTempPath()) "factory-lease-$([guid]::NewGuid()).md"
    try {
        $body | Set-Content -NoNewline $temp
        try { Invoke-Gh @('issue','comment',[string]$Issue,'--body-file',$temp) | Out-Null }
        catch {
            $afterAmbiguous = Get-IssueSnapshot
            if (Test-OperationReceipt $afterAmbiguous $OperationKey) { return }
            throw
        }
        $verified = Get-IssueSnapshot
        if (-not (Test-OperationReceipt $verified $OperationKey)) { throw "Lease action '$OperationKey' could not be verified on issue #$Issue." }
    } finally { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
}

$snapshot = Get-IssueSnapshot
$current = Get-CurrentLease $snapshot
$active = $current -and -not $current.releasedAt -and $current.expiresAt -and ([DateTimeOffset]::Parse($current.expiresAt) -gt $now)
if ($Action -eq 'inspect') { if ($current) { $current | ConvertTo-Json } else { @{ issue=$Issue; status='none' } | ConvertTo-Json }; exit 0 }
if ($Action -eq 'create') {
    if (-not $Owner) { throw 'A lease owner is required.' }
    if ($active) {
        if ($current.owner -eq $Owner) { $current | ConvertTo-Json; exit 0 }
        throw "Issue $Issue already has an active lease owned by $($current.owner)."
    }
    $lease = [ordered]@{ issue=$Issue; owner=$Owner; createdAt=$now.ToString('o'); expiresAt=$now.AddMinutes($Minutes).ToString('o'); releasedAt=$null }
    Add-LeaseMarker $lease 'lease create' "factory:lease:create:${Issue}:$($lease.createdAt)" ([string]$snapshot.updatedAt)
    $lease | ConvertTo-Json
    exit 0
}
if (-not $current -or $current.releasedAt) { @{ issue=$Issue; released=$true; idempotent=$true } | ConvertTo-Json; exit 0 }
$release = [ordered]@{ issue=$Issue; owner=$current.owner; createdAt=$current.createdAt; expiresAt=$current.expiresAt; releasedAt=$now.ToString('o') }
Add-LeaseMarker $release 'lease release' "factory:lease:release:${Issue}:$($current.createdAt)" ([string]$snapshot.updatedAt)
$release | ConvertTo-Json
