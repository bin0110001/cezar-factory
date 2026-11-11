#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$Root = '.',
    [string]$BaseRef = 'origin/dev',
    [string]$HeadRef = 'HEAD',
    [string]$ManifestPath = '.ai/factory/factory.config.yaml',
    [string]$OutputPath = '.factory/changed-set.json',
    [switch]$Optional
)

$ErrorActionPreference = 'Stop'
# The changed-set is JSON (UTF-8 by spec). Without this, Windows pwsh emits the OEM code page and non-ASCII paths are corrupted.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }

function Invoke-GitText([string]$Directory, [string[]]$Arguments) {
    $result = & git -C $Directory @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
    [string]::Join("`n", [string[]]$result).Trim()
}

function Invoke-GitBytes([string]$Directory, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = 'git'
    $info.WorkingDirectory = $Directory
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    [void]$process.Start()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $memory = [IO.MemoryStream]::new()
    $outputTask = $process.StandardOutput.BaseStream.CopyToAsync($memory)
    try {
        if (-not $process.WaitForExit(120000)) {
            $process.Kill($true)
            [void]$process.WaitForExit(5000)
            throw 'verification manifest validation timed out after 120 seconds.'
        }
        [void]$outputTask.GetAwaiter().GetResult()
        $errorText = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "git $($Arguments -join ' ') failed: $errorText" }
        return ,$memory.ToArray()
    } finally { $memory.Dispose(); $process.Dispose() }
}

function ConvertTo-GlobRegex([string]$Glob) {
    $value = $Glob.Replace('\', '/')
    if ($value.StartsWith('/') -or $value -match '(^|/)\.\.(?:/|$)' -or $value -match '^[A-Za-z]:') {
        throw "unsafe ownership glob in verification manifest: $Glob"
    }
    $escaped = [regex]::Escape($value).Replace('\*\*/', "`0").Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '[^/]')
    '^' + $escaped.Replace("`0", '(?:.*/)?') + '$'
}

function Get-Owners([string]$Path, [object[]]$Checks, [hashtable]$RegexCache) {
    $ownerRecords = @()
    foreach ($check in $Checks) {
        $owned = $false
        foreach ($glob in @($check.owns)) {
            if (-not $RegexCache.ContainsKey([string]$glob)) { $RegexCache[[string]$glob] = ConvertTo-GlobRegex ([string]$glob) }
            if ($Path -match $RegexCache[[string]$glob]) { $owned = $true; break }
        }
        if ($owned) { $ownerRecords += [ordered]@{ checkId = $check.id; tags = @($check.tags) } }
    }
    return ,([object[]]$ownerRecords)
}

function Write-Result($Value, [string]$Path) {
    $json = ConvertTo-Json -InputObject $Value -Depth 12
    if ($Path) {
        $parent = Split-Path -Parent $Path
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Set-Content -LiteralPath $Path -Value $json -Encoding utf8
    }
    Write-Output $json
}

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$repoRoot = (Resolve-Path -LiteralPath (Invoke-GitText $rootPath @('rev-parse', '--show-toplevel'))).Path
$outputFull = if ([IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } elseif ($OutputPath) { Join-Path $rootPath $OutputPath } else { '' }
$manifestFull = if ([IO.Path]::IsPathRooted($ManifestPath)) { [IO.Path]::GetFullPath($ManifestPath) } else { [IO.Path]::GetFullPath((Join-Path $rootPath $ManifestPath)) }
$manifestPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $manifestFull.StartsWith($manifestPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "verification manifest must be inside the repository root. Repository='$repoRoot'; manifest='$manifestFull'." }
if (-not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) {
    if ($Optional) { Write-Result ([ordered]@{ schemaVersion = 1; status = 'skipped'; reason = 'manifest-missing'; baseSha = $null; headSha = $null; added = @(); modified = @(); deleted = @(); renamed = @(); paths = @(); unowned = @() }) $outputFull; exit 0 }
    throw "verification manifest not found: $ManifestPath"
}
$manifestFull = (Resolve-Path -LiteralPath $manifestFull).Path
if (-not $manifestFull.StartsWith($manifestPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'resolved verification manifest escapes the repository root.' }

$factoryRoot = Split-Path -Parent $PSScriptRoot
$cezarPackage = Join-Path $factoryRoot 'cezar/packages/cezar'
$manifestHelper = Join-Path $cezarPackage 'src/verification/impact-manifest.ts'
if (-not (Test-Path -LiteralPath $manifestHelper)) { throw "verification manifest adapter is missing: $manifestHelper" }
Push-Location $cezarPackage
try {
    $manifestOutput = & node --import tsx $manifestHelper $manifestFull 2>&1
    $manifestExit = $LASTEXITCODE
} finally { Pop-Location }
if ($manifestExit -ne 0) { throw "verification manifest validation failed: $($manifestOutput -join "`n")" }
$manifest = ($manifestOutput -join "`n") | ConvertFrom-Json -AsHashtable
if (-not $manifest.configured) {
    if ($Optional) { Write-Result ([ordered]@{ schemaVersion = 1; status = 'skipped'; reason = 'verification-not-configured'; baseSha = $null; headSha = $null; added = @(); modified = @(); deleted = @(); renamed = @(); paths = @(); unowned = @() }) $outputFull; exit 0 }
    throw 'verification section is missing from the manifest.'
}

$baseSha = Invoke-GitText $repoRoot @('rev-parse', '--verify', "$BaseRef^{commit}")
$headSha = Invoke-GitText $repoRoot @('rev-parse', '--verify', "$HeadRef^{commit}")
$mergeBase = try { Invoke-GitText $repoRoot @('merge-base', $baseSha, $headSha) } catch { throw "no merge-base exists between '$BaseRef' and '$HeadRef'." }
if ($mergeBase -notmatch '^[0-9a-fA-F]{40,64}$') { throw "no merge-base exists between '$BaseRef' and '$HeadRef'." }
$diffBytes = Invoke-GitBytes $repoRoot @('-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '-z', '--name-status', '-M', $mergeBase, $headSha, '--')
$diffText = [Text.UTF8Encoding]::new($false, $true).GetString($diffBytes)
$tokens = @($diffText.Split([char]0, [StringSplitOptions]::RemoveEmptyEntries))
$checks = @($manifest.checks)
$regexCache = @{}
$added = @(); $modified = @(); $deleted = @(); $renamed = @(); $paths = @(); $unowned = @()
$i = 0
while ($i -lt $tokens.Count) {
    $status = [string]$tokens[$i++]
    if ($status -match '^[RC][0-9]+$') {
        if ($i + 1 -ge $tokens.Count) { throw 'git returned a malformed rename record.' }
        $oldPath = ([string]$tokens[$i++]).Replace('\', '/')
        $newPath = ([string]$tokens[$i++]).Replace('\', '/')
        $oldOwners = [object[]](Get-Owners $oldPath $checks $regexCache)
        $newOwners = [object[]](Get-Owners $newPath $checks $regexCache)
        $renamed += [ordered]@{ oldPath = $oldPath; newPath = $newPath; oldOwners = $oldOwners; newOwners = $newOwners }
        $paths += [ordered]@{ path = $oldPath; change = 'renamed-from'; owners = $oldOwners }
        $paths += [ordered]@{ path = $newPath; change = 'renamed-to'; previousPath = $oldPath; owners = $newOwners }
        if (-not $oldOwners.Count) { $unowned += [ordered]@{ path = $oldPath; change = 'renamed-from' } }
        if (-not $newOwners.Count) { $unowned += [ordered]@{ path = $newPath; change = 'renamed-to' } }
        continue
    }
    if ($status -notmatch '^[AMD]$' -or $i -ge $tokens.Count) { throw "git returned an unsupported or malformed change status: $status" }
    $path = ([string]$tokens[$i++]).Replace('\', '/')
    $operation = switch ($status) { 'A' { 'added' } 'M' { 'modified' } 'D' { 'deleted' } }
    $owners = [object[]](Get-Owners $path $checks $regexCache)
    $entry = [ordered]@{ path = $path; owners = $owners }
    $paths += [ordered]@{ path = $path; change = $operation; owners = $owners }
    switch ($operation) { 'added' { $added += $entry } 'modified' { $modified += $entry } 'deleted' { $deleted += $entry } }
    if (-not $owners.Count) { $unowned += [ordered]@{ path = $path; change = $operation } }
}

$result = [ordered]@{ schemaVersion = 1; status = 'complete'; baseSha = $baseSha; headSha = $headSha; mergeBaseSha = $mergeBase; added = @($added); modified = @($modified); deleted = @($deleted); renamed = @($renamed); paths = @($paths); unowned = @($unowned) }
Write-Result $result $outputFull
