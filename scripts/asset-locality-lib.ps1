# Policy-controlled asset locality, staging and worker caches (issue #218). Dot-source this file.
#
# A data-dependent job names the assets it needs with descriptors (schemas/asset-requirement.schema.json).
# This library decides, from policies/asset-locality.json and the worker's declared capabilities, whether a
# worker may run the job (Get-AssetPreflight), stages the content into a digest-verified worker cache
# (Invoke-AssetStage), exposes it to a run through a read-only view (New-AssetRunView) and describes it for
# evidence without its payload (New-AssetEvidence). Every failure is a typed status: `unschedulable:*` for a
# worker that cannot take the job, `infra:*` for a fault in storage or access, `invalid:*` for a bad request.
# None of them is a test failure. Jobs without asset requirements never call into this file.
#
# Worker: @{ id; online; scopes = @('...'); adapters = @(<adapter>...); cacheRoot; cacheQuotaBytes; freeBytes }
# Adapter: @{ method; root; credential = {scriptblock, optional}; fetch = {param($Descriptor,$Destination,$Credential)} }
# Without `fetch`, local-mount and readonly-filesystem adapters copy `sourceRef` from under `root`.

function Get-AssetPolicy {
    param([string]$Path = (Join-Path $PSScriptRoot '../policies/asset-locality.json'))
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "asset locality policy not found: $Path" }
    $policy = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    if ($policy['schemaVersion'] -ne 'factory-asset-locality/v1') { throw "unsupported asset locality schemaVersion '$($policy['schemaVersion'])' in $Path" }
    $policy
}

function New-AssetResult {
    param([string]$Status, [string]$Reason = '', [hashtable]$Extra = @{})
    $r = @{ status = $Status; ok = ($Status -eq 'ok'); reason = $Reason }
    foreach ($k in $Extra.Keys) { $r[$k] = $Extra[$k] }
    $r
}

function Test-AssetDescriptor {
    # Returns a list of problems; empty means valid. Also refuses a sourceRef that could leave the adapter root.
    param([hashtable]$Descriptor, [hashtable]$Policy = (Get-AssetPolicy))
    $problems = [System.Collections.Generic.List[string]]::new()
    foreach ($f in 'schemaVersion', 'id', 'version', 'digest', 'sourceClass', 'accessScope', 'sizeBytes', 'stagingMethod', 'cacheable', 'retentionDays') {
        if (-not $Descriptor.ContainsKey($f) -or $null -eq $Descriptor[$f] -or "$($Descriptor[$f])" -eq '') { $problems.Add("missing $f") }
    }
    if ($problems.Count) { return $problems.ToArray() }
    if ($Descriptor['schemaVersion'] -ne 'factory-asset-requirement/v1') { $problems.Add('unsupported schemaVersion') }
    if ([string]$Descriptor['id'] -cnotmatch '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$') { $problems.Add('id must be namespaced (a.b)') }
    if ([string]$Descriptor['digest'] -cnotmatch '^sha256:[0-9a-f]{64}$') { $problems.Add('digest must be sha256:<64 hex>') }
    if (-not $Policy['sourceClasses'].ContainsKey([string]$Descriptor['sourceClass'])) { $problems.Add('unknown sourceClass') }
    if (@($Policy['stagingMethods']) -notcontains [string]$Descriptor['stagingMethod']) { $problems.Add('unknown stagingMethod') }
    if ([long]$Descriptor['sizeBytes'] -lt 0) { $problems.Add('sizeBytes must not be negative') }
    if ($Descriptor.ContainsKey('sourceRef') -and -not (Test-AssetSafeRelativePath -Path ([string]$Descriptor['sourceRef']))) { $problems.Add('unsafe sourceRef') }
    $problems.ToArray()
}

function Test-AssetSafeRelativePath {
    # Path traversal defense: relative, no drive or UNC, no `..`, no empty/dot segments, no NUL.
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains([char]0)) { return $false }
    if ($Path -match '^([\\/]|[A-Za-z]:|~)') { return $false }
    foreach ($seg in ($Path -split '[\\/]')) { if ($seg -in '', '.', '..') { return $false } }
    $true
}

function Resolve-AssetSourcePath {
    # Joins a relative reference to an allowlisted root and proves the result (symlinks resolved) stays inside it.
    param([string]$Root, [string]$Ref)
    if (-not (Test-AssetSafeRelativePath -Path $Ref)) { return $null }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('/', '\')
    $full = [IO.Path]::GetFullPath((Join-Path $rootFull $Ref))
    if (-not $full.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { return $null }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkTarget) {
        $real = $item.ResolveLinkTarget($true).FullName
        if (-not $real.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) { return $null }
    }
    $full
}

function Get-AssetCacheKey {
    param([hashtable]$Descriptor)
    $text = "$($Descriptor['id'])|$($Descriptor['version'])|$($Descriptor['digest'])"
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

function Get-AssetFileDigest {
    param([string]$Path)
    'sha256:' + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-AssetCacheState {
    # 'hit' (present and digest verified), 'corrupt' (present, digest differs), or 'miss'.
    param([hashtable]$Worker, [hashtable]$Descriptor)
    if (-not $Worker['cacheRoot'] -or -not [bool]$Descriptor['cacheable']) { return 'miss' }
    $payload = Join-Path (Join-Path $Worker['cacheRoot'] (Get-AssetCacheKey $Descriptor)) 'payload'
    if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { return 'miss' }
    if ((Get-AssetFileDigest $payload) -ceq [string]$Descriptor['digest']) { 'hit' } else { 'corrupt' }
}

function Get-AssetPreflight {
    # Decides schedulability for a worker before anything is staged or any credential is touched. Hard
    # constraints (authorization, adapter allowlist, online, capacity) make a worker unschedulable; a cache hit
    # only lowers the estimated staging cost, which the scheduler may use as a soft preference.
    param([hashtable[]]$Descriptors, [hashtable]$Worker, [hashtable]$Policy = (Get-AssetPolicy))
    $cost = 0.0; $stageBytes = 0L; $details = @()
    foreach ($d in @($Descriptors)) {
        $problems = @(Test-AssetDescriptor -Descriptor $d -Policy $Policy)
        if ($problems.Count) { return New-AssetResult 'invalid:descriptor' ($problems -join '; ') }
    }
    if (-not [bool]$Worker['online']) { return New-AssetResult 'unschedulable:worker-offline' "worker $($Worker['id']) is offline" }
    foreach ($d in @($Descriptors)) {
        $class = $Policy['sourceClasses'][[string]$d['sourceClass']]
        if ($class['requiresAuthorization'] -and @($Worker['scopes']) -notcontains [string]$d['accessScope']) {
            return New-AssetResult 'unschedulable:unauthorized' "worker $($Worker['id']) lacks the scope for $($d['id'])@$($d['version'])"
        }
        $method = [string]$d['stagingMethod']
        $adapter = @($Worker['adapters'] | Where-Object { $_ -and $_['method'] -eq $method })[0]
        if (@($Policy['adapters']['allowlist']) -notcontains $method -or -not $adapter) {
            return New-AssetResult 'unschedulable:adapter-not-allowed' "worker $($Worker['id']) has no allowlisted $method adapter for $($d['id'])"
        }
        $state = Get-AssetCacheState -Worker $Worker -Descriptor $d
        $need = if ($state -eq 'hit') { 0L } else { [long]$d['sizeBytes'] }
        $stageBytes += $need
        $details += @{ id = $d['id']; version = $d['version']; cacheState = $state }
    }
    $quota = if ($Worker['cacheQuotaBytes']) { [long]$Worker['cacheQuotaBytes'] } else { [long]$Policy['cache']['defaultQuotaBytes'] }
    $total = (@($Descriptors) | ForEach-Object { [long]$_['sizeBytes'] } | Measure-Object -Sum).Sum
    if ($total -gt $quota) { return New-AssetResult 'unschedulable:capacity' "assets need $total bytes, worker cache quota is $quota" }
    if ($null -ne $Worker['freeBytes'] -and $stageBytes -gt [long]$Worker['freeBytes']) { return New-AssetResult 'unschedulable:capacity' "staging needs $stageBytes bytes, worker has $($Worker['freeBytes']) free" }
    $cost = [math]::Round($stageBytes / [double]$Policy['costModel']['bytesPerCostUnit'], 3)
    New-AssetResult 'ok' '' @{ stagingBytes = $stageBytes; stagingCost = $cost; assets = $details }
}

function Remove-AssetCacheEntry {
    param([string]$Dir)
    if (Test-Path -LiteralPath $Dir) {
        Get-ChildItem -LiteralPath $Dir -Recurse -Force | ForEach-Object { if (-not $_.PSIsContainer -and -not $IsWindows) { & chmod u+w $_.FullName 2>$null } }
        Remove-Item -LiteralPath $Dir -Recurse -Force
    }
}

function Invoke-AssetEviction {
    # Frees cache space by dropping entries of the same asset id with another key (a manifest change makes
    # them stale) and then least-recently-used entries, never the entries in -Keep.
    param([string]$CacheRoot, [long]$NeedBytes, [long]$QuotaBytes, [string[]]$Keep = @(), [string]$StaleId = '', [string]$StaleKey = '')
    if (-not (Test-Path -LiteralPath $CacheRoot)) { return }
    $entries = @(Get-ChildItem -LiteralPath $CacheRoot -Directory -Force)
    foreach ($e in $entries) {
        $meta = Join-Path $e.FullName 'meta.json'
        if ($StaleId -and $e.Name -ne $StaleKey -and (Test-Path -LiteralPath $meta) -and ((Get-Content -Raw -LiteralPath $meta | ConvertFrom-Json).id -eq $StaleId)) { Remove-AssetCacheEntry $e.FullName }
    }
    $used = { (Get-ChildItem -LiteralPath $CacheRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
    foreach ($e in @(Get-ChildItem -LiteralPath $CacheRoot -Directory -Force | Sort-Object LastWriteTimeUtc)) {
        if ((& $used) + $NeedBytes -le $QuotaBytes) { break }
        if ($Keep -notcontains $e.Name) { Remove-AssetCacheEntry $e.FullName }
    }
}

function Invoke-AssetStage {
    # Stages one asset into the worker cache and returns a typed result with the cache payload path (internal to
    # the worker; never put it in evidence). Authorization is checked first and credentials are resolved only
    # afterwards, so an unauthorized worker never receives them.
    param([hashtable]$Descriptor, [hashtable]$Worker, [hashtable]$Policy = (Get-AssetPolicy))
    $problems = @(Test-AssetDescriptor -Descriptor $Descriptor -Policy $Policy)
    if ($problems.Count) {
        $unsafe = $problems -contains 'unsafe sourceRef'
        return New-AssetResult $(if ($unsafe) { 'infra:unsafe-path' } else { 'invalid:descriptor' }) ($problems -join '; ')
    }
    if (-not [bool]$Worker['online']) { return New-AssetResult 'unschedulable:worker-offline' "worker $($Worker['id']) is offline" }
    $class = $Policy['sourceClasses'][[string]$Descriptor['sourceClass']]
    if ($class['requiresAuthorization'] -and @($Worker['scopes']) -notcontains [string]$Descriptor['accessScope']) {
        return New-AssetResult 'unschedulable:unauthorized' "worker $($Worker['id']) lacks the scope for $($Descriptor['id'])"
    }
    $method = [string]$Descriptor['stagingMethod']
    $adapter = @($Worker['adapters'] | Where-Object { $_ -and $_['method'] -eq $method })[0]
    if (@($Policy['adapters']['allowlist']) -notcontains $method -or -not $adapter) { return New-AssetResult 'unschedulable:adapter-not-allowed' "no allowlisted $method adapter" }

    $key = Get-AssetCacheKey $Descriptor
    $cacheable = [bool]$Descriptor['cacheable'] -and [bool]$class['cacheable'] -and $Worker['cacheRoot']
    $cacheRoot = if ($Worker['cacheRoot']) { [string]$Worker['cacheRoot'] } else { Join-Path ([IO.Path]::GetTempPath()) ('asset-stage-' + [guid]::NewGuid().ToString('N')) }
    $entry = Join-Path $cacheRoot $key
    $payload = Join-Path $entry 'payload'
    $state = if ($cacheable) { Get-AssetCacheState -Worker $Worker -Descriptor $Descriptor } else { 'miss' }
    if ($state -eq 'hit') {
        (Get-Item -LiteralPath $entry).LastWriteTimeUtc = [DateTime]::UtcNow
        return New-AssetResult 'ok' '' @{ cacheState = 'hit'; payloadPath = $payload; id = $Descriptor['id']; version = $Descriptor['version']; digest = $Descriptor['digest'] }
    }
    if ($state -eq 'corrupt') { Remove-AssetCacheEntry $entry }   # re-stage from source below; a failure there is typed

    $quota = if ($Worker['cacheQuotaBytes']) { [long]$Worker['cacheQuotaBytes'] } else { [long]$Policy['cache']['defaultQuotaBytes'] }
    $size = [long]$Descriptor['sizeBytes']
    New-Item -ItemType Directory -Force $cacheRoot | Out-Null
    Invoke-AssetEviction -CacheRoot $cacheRoot -NeedBytes $size -QuotaBytes $quota -StaleId ([string]$Descriptor['id']) -StaleKey $key
    $usedNow = (Get-ChildItem -LiteralPath $cacheRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($size -gt $quota -or ($usedNow + $size) -gt $quota -or ($null -ne $Worker['freeBytes'] -and $size -gt [long]$Worker['freeBytes'])) {
        return New-AssetResult 'infra:disk-full' "no room for $($Descriptor['id'])@$($Descriptor['version']) ($size bytes)"
    }

    # Stage into a private temp name beside the entry, verify, then publish atomically.
    $tmpDir = Join-Path $cacheRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmpDir | Out-Null
    $tmp = Join-Path $tmpDir 'payload'
    try {
        $credential = $null
        if ($adapter['credential']) { $credential = & $adapter['credential'] $Descriptor }   # only reached once authorized
        if ($adapter['fetch']) {
            & $adapter['fetch'] $Descriptor $tmp $credential
        } else {
            $src = Resolve-AssetSourcePath -Root ([string]$adapter['root']) -Ref ([string]$Descriptor['sourceRef'])
            if (-not $src) { return New-AssetResult 'infra:unsafe-path' "sourceRef for $($Descriptor['id']) escapes the adapter root" }
            if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { return New-AssetResult 'infra:stage-failed' "source for $($Descriptor['id']) is not available" }
            Copy-Item -LiteralPath $src -Destination $tmp
        }
        if (-not (Test-Path -LiteralPath $tmp -PathType Leaf)) { return New-AssetResult 'infra:stage-failed' "adapter produced no content for $($Descriptor['id'])" }
        if ((Get-AssetFileDigest $tmp) -cne [string]$Descriptor['digest']) { return New-AssetResult 'infra:hash-mismatch' "staged content for $($Descriptor['id'])@$($Descriptor['version']) does not match its digest" }
        if ((Get-Item -LiteralPath $tmp).Length -gt $size) { return New-AssetResult 'infra:hash-mismatch' "staged content for $($Descriptor['id']) exceeds its declared size" }
        New-Item -ItemType Directory -Force $entry | Out-Null
        Move-Item -LiteralPath $tmp -Destination $payload -Force
        @{ id = $Descriptor['id']; version = $Descriptor['version']; digest = $Descriptor['digest']; stagedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $entry 'meta.json') -Encoding utf8
        if (-not $IsWindows) { & chmod a-w $payload }
    } catch {
        $msg = $_.Exception.Message
        $status = if ($msg -match 'access-revoked|revoked|forbidden|denied') { 'infra:access-revoked' } elseif ($msg -match 'No space|disk full|not enough space') { 'infra:disk-full' } else { 'infra:stage-failed' }
        return New-AssetResult $status "staging $($Descriptor['id']) failed: $status"   # message not echoed: it may carry credentials or paths
    } finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-AssetResult 'ok' '' @{ cacheState = $(if ($state -eq 'corrupt') { 'restaged-after-corrupt' } else { 'staged' }); payloadPath = $payload; id = $Descriptor['id']; version = $Descriptor['version']; digest = $Descriptor['digest'] }
}

function New-AssetRunView {
    # A per-run, read-only view of staged assets, separate from the run's writable data directory. Entries link
    # to the cache payload (made read-only at staging) under the asset id, so a run cannot alter the cache.
    param([hashtable[]]$Staged, [string]$RunRoot)
    $view = Join-Path $RunRoot 'assets'; $data = Join-Path $RunRoot 'data'
    New-Item -ItemType Directory -Force $view, $data | Out-Null
    foreach ($s in @($Staged)) {
        $link = Join-Path $view ([string]$s['id'])
        if (-not (Test-Path -LiteralPath $link)) { New-Item -ItemType SymbolicLink -Path $link -Target $s['payloadPath'] | Out-Null }
    }
    @{ assetView = $view; writableData = $data }
}

function New-AssetEvidence {
    # Identity only: id, version, digest, source class and cache state. No payload, filenames or worker paths.
    param([hashtable[]]$Descriptors, [hashtable[]]$Results, [hashtable]$Policy = (Get-AssetPolicy))
    $records = @()
    for ($i = 0; $i -lt @($Descriptors).Count; $i++) {
        $d = @($Descriptors)[$i]; $r = if ($Results) { @($Results)[$i] } else { $null }
        $records += [ordered]@{
            id = $d['id']; version = $d['version']; digest = $d['digest']; sourceClass = $d['sourceClass']
            cacheState = $(if ($r -and $r['cacheState']) { $r['cacheState'] } else { 'unknown' })
            status = $(if ($r) { $r['status'] } else { 'unstaged' })
        }
    }
    [ordered]@{ schemaVersion = 'factory-asset-evidence/v1'; assets = $records }
}
