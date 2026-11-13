#!/usr/bin/env pwsh
# Tests for scripts/asset-locality-lib.ps1 (issue #218). Fixture content only; no real assets.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $factory 'scripts/asset-locality-lib.ps1')
$script:failures = 0
function Check([string]$Name, [bool]$Condition) { if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ } }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('asset-locality-' + [guid]::NewGuid().ToString('N'))
$srcRoot = Join-Path $tmp 'source'; New-Item -ItemType Directory -Force $srcRoot | Out-Null
try {
    $content = 'fixture-bytes-' + ('x' * 100)
    Set-Content -LiteralPath (Join-Path $srcRoot 'blob.bin') -Value $content -NoNewline
    $digest = Get-AssetFileDigest (Join-Path $srcRoot 'blob.bin')
    $size = (Get-Item (Join-Path $srcRoot 'blob.bin')).Length
    function New-Desc([hashtable]$Over = @{}) {
        $d = @{ schemaVersion = 'factory-asset-requirement/v1'; id = 'acme.fixtures.sample'; version = '1'; digest = $digest; sourceClass = 'licensed'
                accessScope = 'acme-licensed'; sizeBytes = $size; stagingMethod = 'local-mount'; sourceRef = 'blob.bin'; cacheable = $true; retentionDays = 7 }
        foreach ($k in $Over.Keys) { $d[$k] = $Over[$k] }; $d
    }
    $credentialCalls = [System.Collections.Generic.List[string]]::new()
    function New-Worker([string]$Name, [string[]]$Scopes = @('acme-licensed'), [hashtable]$Over = @{}) {
        $w = @{ id = $Name; online = $true; scopes = $Scopes; cacheRoot = (Join-Path $tmp "cache-$Name"); cacheQuotaBytes = 100000
                adapters = @(@{ method = 'local-mount'; root = $srcRoot; credential = { param($d) $script:credentialCalls.Add($d['id']); 'secret-token' } }) }
        foreach ($k in $Over.Keys) { $w[$k] = $Over[$k] }; $w
    }

    # Descriptor validation
    Check 'a valid descriptor has no problems' (@(Test-AssetDescriptor (New-Desc)).Count -eq 0)
    Check 'an un-namespaced id, a bad digest and an unknown source class are rejected' (@(Test-AssetDescriptor (New-Desc @{ id = 'flat' })).Count -eq 1 -and @(Test-AssetDescriptor (New-Desc @{ digest = 'abc' })).Count -eq 1 -and @(Test-AssetDescriptor (New-Desc @{ sourceClass = 'secret' })).Count -eq 1)
    Check 'path traversal in sourceRef is rejected' ((@('../x', '/etc/passwd', 'a/../../b', 'C:\x', '~/x', 'a//b', '') | ForEach-Object { Test-AssetSafeRelativePath $_ } | Where-Object { $_ } | Measure-Object).Count -eq 0)
    Check 'a plain relative sourceRef is accepted' (Test-AssetSafeRelativePath 'sub/dir/blob.bin')

    # Fresh stage, then cache hit
    $w = New-Worker 'w1'
    $pre = Get-AssetPreflight -Descriptors @(New-Desc) -Worker $w
    Check 'preflight passes for an authorized worker and estimates the staging cost' ($pre.ok -and $pre.stagingBytes -eq $size -and $pre.assets[0].cacheState -eq 'miss')
    $s1 = Invoke-AssetStage -Descriptor (New-Desc) -Worker $w
    Check 'fresh stage succeeds, verifies the digest and resolves credentials once' ($s1.ok -and $s1.cacheState -eq 'staged' -and (Get-AssetFileDigest $s1.payloadPath) -eq $digest -and $credentialCalls.Count -eq 1)
    $pre2 = Get-AssetPreflight -Descriptors @(New-Desc) -Worker $w
    Check 'after staging, preflight sees a cache hit with zero staging cost' ($pre2.ok -and $pre2.stagingBytes -eq 0 -and $pre2.stagingCost -eq 0 -and $pre2.assets[0].cacheState -eq 'hit')
    $s2 = Invoke-AssetStage -Descriptor (New-Desc) -Worker $w
    Check 'second stage is a cache hit and asks the adapter for no credential' ($s2.ok -and $s2.cacheState -eq 'hit' -and $credentialCalls.Count -eq 1)

    # Authorization
    $credentialCalls.Clear()
    $bad = New-Worker 'w-unauth' @('other-scope')
    $pb = Get-AssetPreflight -Descriptors @(New-Desc) -Worker $bad
    $sb = Invoke-AssetStage -Descriptor (New-Desc) -Worker $bad
    Check 'an unauthorized worker is unschedulable and never receives credentials or content' ($pb.status -eq 'unschedulable:unauthorized' -and $sb.status -eq 'unschedulable:unauthorized' -and $credentialCalls.Count -eq 0 -and -not (Test-Path -LiteralPath $bad.cacheRoot))
    $pub = New-Desc @{ id = 'tools.public.runtime'; sourceClass = 'public'; accessScope = 'none' }
    Check 'a public asset needs no scope' ((Get-AssetPreflight -Descriptors @($pub) -Worker $bad).ok)
    Check 'an offline worker is unschedulable, not a test failure' ((Get-AssetPreflight -Descriptors @(New-Desc) -Worker (New-Worker 'w-off' @('acme-licensed') @{ online = $false })).status -eq 'unschedulable:worker-offline')
    $noAdapter = New-Worker 'w-na' @('acme-licensed') @{ adapters = @() }
    Check 'a worker without the allowlisted adapter is unschedulable' ((Get-AssetPreflight -Descriptors @(New-Desc) -Worker $noAdapter).status -eq 'unschedulable:adapter-not-allowed')
    Check 'insufficient quota or free disk is unschedulable:capacity at preflight' ((Get-AssetPreflight -Descriptors @(New-Desc) -Worker (New-Worker 'w-q' @('acme-licensed') @{ cacheQuotaBytes = 10 })).status -eq 'unschedulable:capacity' -and (Get-AssetPreflight -Descriptors @(New-Desc) -Worker (New-Worker 'w-f' @('acme-licensed') @{ freeBytes = 5 })).status -eq 'unschedulable:capacity')

    # Manifest change invalidates the stale cache
    Set-Content -LiteralPath (Join-Path $srcRoot 'blob.bin') -Value ($content + '-v2') -NoNewline
    $digest2 = Get-AssetFileDigest (Join-Path $srcRoot 'blob.bin'); $size2 = (Get-Item (Join-Path $srcRoot 'blob.bin')).Length
    $d2 = New-Desc @{ version = '2'; digest = $digest2; sizeBytes = $size2 }
    Check 'a changed manifest is a cache miss, not a stale hit' ((Get-AssetCacheState -Worker $w -Descriptor $d2) -eq 'miss')
    $s3 = Invoke-AssetStage -Descriptor $d2 -Worker $w
    $metas = @(Get-ChildItem $w.cacheRoot -Recurse -Filter meta.json | ForEach-Object { (Get-Content -Raw $_.FullName | ConvertFrom-Json).version })
    Check 'the new version stages and the stale entry of the same asset is evicted' ($s3.ok -and $s3.cacheState -eq 'staged' -and $metas.Count -eq 1 -and $metas[0] -eq '2')

    # Hash mismatch
    $wm = New-Worker 'w-hash'
    $sm = Invoke-AssetStage -Descriptor (New-Desc @{ version = '3'; digest = $digest }) -Worker $wm   # source now holds v2 bytes
    Check 'a hash mismatch fails as infra:hash-mismatch and leaves nothing in the cache' ($sm.status -eq 'infra:hash-mismatch' -and @(Get-ChildItem $wm.cacheRoot -Recurse -File -Force).Count -eq 0)

    # Unsafe path
    $su = Invoke-AssetStage -Descriptor (New-Desc @{ sourceRef = '../escape' }) -Worker (New-Worker 'w-path')
    Check 'an unsafe sourceRef fails as infra:unsafe-path' ($su.status -eq 'infra:unsafe-path')
    if (-not $IsWindows) {
        $outside = Join-Path $tmp 'outside.bin'; Set-Content -LiteralPath $outside -Value 'x' -NoNewline
        New-Item -ItemType SymbolicLink -Path (Join-Path $srcRoot 'link.bin') -Target $outside | Out-Null
        Check 'a symlink leaving the adapter root is refused' ((Invoke-AssetStage -Descriptor (New-Desc @{ sourceRef = 'link.bin' }) -Worker (New-Worker 'w-link')).status -eq 'infra:unsafe-path')
    }

    # Disk full / quota
    $sd = Invoke-AssetStage -Descriptor $d2 -Worker (New-Worker 'w-full' @('acme-licensed') @{ cacheQuotaBytes = 10 })
    Check 'a quota smaller than the asset fails as infra:disk-full' ($sd.status -eq 'infra:disk-full')
    Check 'disk full at stage time (free space shrank after preflight) fails as infra:disk-full' ((Invoke-AssetStage -Descriptor $d2 -Worker (New-Worker 'w-free' @('acme-licensed') @{ freeBytes = 1 })).status -eq 'infra:disk-full')

    # Revoked access mid-stage
    $wr = New-Worker 'w-revoked'; $wr.adapters = @(@{ method = 'local-mount'; root = $srcRoot; fetch = { throw 'HTTP 403 access revoked for token SECRETVALUE' } })
    $sr = Invoke-AssetStage -Descriptor $d2 -Worker $wr
    Check 'revoked access fails as infra:access-revoked and the error text (possible secret) is not echoed' ($sr.status -eq 'infra:access-revoked' -and $sr.reason -notmatch 'SECRETVALUE')

    # Corrupt cache is detected and re-staged, or typed infra if the source is gone
    $wc = New-Worker 'w-corrupt'
    $null = Invoke-AssetStage -Descriptor $d2 -Worker $wc
    $cp = (Get-ChildItem $wc.cacheRoot -Recurse -Filter payload | Select-Object -First 1).FullName
    if (-not $IsWindows) { & chmod u+w $cp }
    Set-Content -LiteralPath $cp -Value 'tampered' -NoNewline
    Check 'a tampered cache entry is reported as corrupt, never a hit' ((Get-AssetCacheState -Worker $wc -Descriptor $d2) -eq 'corrupt')
    $sc = Invoke-AssetStage -Descriptor $d2 -Worker $wc
    Check 'a corrupt cache entry is evicted and re-staged from source' ($sc.ok -and $sc.cacheState -eq 'restaged-after-corrupt' -and (Get-AssetFileDigest $sc.payloadPath) -eq $digest2)
    if (-not $IsWindows) { & chmod u+w $sc.payloadPath }
    Set-Content -LiteralPath $sc.payloadPath -Value 'tampered again' -NoNewline
    $wc.adapters = @(@{ method = 'local-mount'; root = (Join-Path $tmp 'gone') })
    Check 'corrupt cache with the source unavailable is infra:stage-failed, not a test failure' ((Invoke-AssetStage -Descriptor $d2 -Worker $wc).status -eq 'infra:stage-failed')

    # Run view and evidence
    $ws = New-Worker 'w-view'; $st = Invoke-AssetStage -Descriptor $d2 -Worker $ws
    $view = New-AssetRunView -Staged @($st) -RunRoot (Join-Path $tmp 'run1')
    $viewFile = Join-Path $view.assetView 'acme.fixtures.sample'
    $writable = $true; try { [IO.File]::OpenWrite($st.payloadPath).Dispose() } catch { $writable = $false }
    Check 'the run view exposes the asset and is separate from the writable data directory' ((Test-Path $viewFile) -and (Test-Path $view.writableData) -and $view.assetView -ne $view.writableData)
    if (-not $IsWindows -and (id -u) -ne '0') { Check 'the cached payload is read-only to the run' (-not $writable) }
    $ev = New-AssetEvidence -Descriptors @($d2) -Results @($st) | ConvertTo-Json -Depth 6
    Check 'evidence holds ids and digests only: no payload, source ref or worker path' ($ev -match $digest2 -and $ev -notmatch 'fixture-bytes' -and $ev -notmatch 'blob\.bin' -and $ev -notmatch [regex]::Escape($tmp))

    # Non-asset jobs are unaffected
    Check 'a job with no asset requirements has nothing to preflight or stage' ((Get-AssetPreflight -Descriptors @() -Worker (New-Worker 'w-none' @())).ok)
    $policy = Get-AssetPolicy
    Check 'the shipped policy allowlists only declared staging methods' (@($policy.adapters.allowlist | Where-Object { $policy.stagingMethods -notcontains $_ }).Count -eq 0)
} finally {
    if ($tmp -and (Test-Path $tmp)) { Get-ChildItem $tmp -Recurse -Force | ForEach-Object { if (-not $_.PSIsContainer -and -not $IsWindows) { & chmod u+w $_.FullName 2>$null } }; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
if ($script:failures) { Write-Host "FAILED: $script:failures"; exit 1 }
Write-Host 'asset locality: all passed'
