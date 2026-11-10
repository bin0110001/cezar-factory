#!/usr/bin/env pwsh
<#
.SYNOPSIS
Audits registered project Factory copies against the shared checkout without changing targets.
.DESCRIPTION
Reads only explicitly registered local project paths. Remote-only targets and unreachable local paths
are reported without probing alternate locations. The JSON receipt is operational state under .factory/.
#>
[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$TargetsPath = '',
    [string]$ReceiptPath = '.factory/release-reports/shadow-audit.json'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
if (-not $TargetsPath) { $TargetsPath = Join-Path $repo 'config/factory-projects.json' }
$factoryVersion = Get-FactoryVersion $repo

function Get-SourcePath([string]$TargetRelativePath, [string]$InstalledPath) {
    $content = [IO.File]::ReadAllText($InstalledPath)
    $match = [regex]::Match($content, '(?m)^\s*(?:#\s*)?source:\s*([^\r\n]+)')
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    if ($TargetRelativePath -match '^\.ai/cezar/workflows/factory-(.+)$') { return "workflows/$($Matches[1])" }
    if ($TargetRelativePath -match '^\.ai/skills/(.+)$') { return "skills/$($Matches[1])" }
    if ($TargetRelativePath -match '^\.ai/factory/(.+)$' -and $Matches[1] -notmatch '^(manifest\.json|VERSION|gitignore\.fragment)$') { return [string]$Matches[1] }
    $null
}

function Get-EffectiveSource([string]$Mode, [string]$SourcePath) {
    if ($SourcePath -match '^overrides/') { return 'override' }
    'installed'
}

function Get-SharedRelativePath([string]$SourcePath) {
    if ($SourcePath -match '^overrides/(.+)$') { return $Matches[1] }
    $SourcePath
}

function Get-ObjectValue($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    $null
}

function Get-ProjectPathHash([string]$Path) {
    if (-not $Path) { return $null }
    $canonical = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $canonical -PathType Container) { $canonical = (Resolve-Path -LiteralPath $canonical).Path }
    $canonical = $canonical.Replace('\', '/')
    $root = [IO.Path]::GetPathRoot($canonical).Replace('\', '/')
    if ($canonical.Length -gt $root.Length) { $canonical = $canonical.TrimEnd('/') }
    if ([IO.Path]::DirectorySeparatorChar -eq [char]'\') { $canonical = $canonical.ToLowerInvariant() }
    Get-TextHash $canonical
}

function New-FileFinding([string]$TargetRelativePath, [string]$ProjectRoot, [string]$Mode, $ManifestEntry) {
    $targetFull = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $TargetRelativePath))
    $prefix = $ProjectRoot.TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $targetFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $TargetRelativePath -notmatch '^\.ai/') {
        throw 'Manifest contains a path outside the managed .ai directory.'
    }
    if (-not (Test-Path -LiteralPath $targetFull -PathType Leaf)) {
        return [pscustomobject]@{ path = $TargetRelativePath; sourcePath = $null; effectiveSource = 'installed'; shadowConflict = 'none'; migrationStatus = 'not-installed' }
    }

    $sourcePath = Get-SourcePath $TargetRelativePath $targetFull
    $effective = Get-EffectiveSource $Mode $sourcePath
    $installedHash = Get-FileTextHash $targetFull
    if ($installedHash -ne [string]$ManifestEntry.sha256) {
        return [pscustomobject]@{ path = $TargetRelativePath; sourcePath = $sourcePath; effectiveSource = $effective; shadowConflict = 'modified'; migrationStatus = 'modified' }
    }
    $sharedRelative = Get-SharedRelativePath $sourcePath
    $sharedPath = if ($sharedRelative) { Join-Path $repo $sharedRelative } else { '' }
    if (-not $sharedPath -or -not (Test-Path -LiteralPath $sharedPath -PathType Leaf)) {
        return [pscustomobject]@{ path = $TargetRelativePath; sourcePath = $sourcePath; effectiveSource = $effective; shadowConflict = 'unknown'; migrationStatus = 'shadowed' }
    }
    $style = Get-MarkerStyle $sharedRelative
    $installedBody = Remove-Marker ([IO.File]::ReadAllText($targetFull)) $style
    $sharedBody = Remove-Marker ([IO.File]::ReadAllText($sharedPath)) $style
    $conflict = if ((Get-TextHash $installedBody) -eq (Get-TextHash $sharedBody)) { 'identical' } else { 'modified' }
    $migration = if ($conflict -eq 'modified') { 'modified' } else { 'shadowed' }
    [pscustomobject]@{ path = $TargetRelativePath; sourcePath = $sourcePath; effectiveSource = $effective; shadowConflict = $conflict; migrationStatus = $migration }
}

function Get-TargetResult($Target, [int]$Index) {
    $projectId = Get-ObjectValue $Target 'projectId'
    $projectPath = Get-ObjectValue $Target 'projectPath'
    $id = if ($projectId) { [string]$projectId } else { "target-$Index" }
    if (-not $projectPath) {
        return [pscustomobject]@{ projectId = $id; projectPathHash = $null; effectiveSource = 'unknown'; shadowConflict = 'unknown'; migrationStatus = 'unknown'; files = @() }
    }
    $project = [IO.Path]::GetFullPath([string]$projectPath)
    $projectPathHash = Get-ProjectPathHash $project
    if (-not (Test-Path -LiteralPath $project -PathType Container)) {
        return [pscustomobject]@{ projectId = $id; projectPathHash = $projectPathHash; effectiveSource = 'unknown'; shadowConflict = 'unknown'; migrationStatus = 'unreachable'; files = @() }
    }
    $project = (Resolve-Path -LiteralPath $project).Path
    $projectPathHash = Get-ProjectPathHash $project
    $factoryDir = Get-FactoryDir $project
    $mode = [string](Get-ObjectValue $Target 'mode')
    if ($mode -ne 'shared' -and (Test-Path -LiteralPath (Join-Path $factoryDir 'factory.config.yaml') -PathType Leaf)) {
        $config = Read-FactoryConfig (Join-Path $factoryDir 'factory.config.yaml')
        if ($config.factory -and $config.factory.source -eq 'shared') { $mode = 'shared' }
    }
    $manifest = Read-Manifest $factoryDir
    if (-not $manifest) {
        if ($mode -eq 'shared') {
            return [pscustomobject]@{ projectId = $id; projectPathHash = $projectPathHash; effectiveSource = 'shared'; shadowConflict = 'none'; migrationStatus = 'shared'; files = @() }
        }
        return [pscustomobject]@{ projectId = $id; projectPathHash = $projectPathHash; effectiveSource = 'installed'; shadowConflict = 'none'; migrationStatus = 'not-installed'; files = @() }
    }
    if (-not ($manifest.files -is [array]) -or $manifest.files.Count -gt 1000) { throw "Target '$id' has an invalid or over-limit manifest." }

    $files = @($manifest.files | ForEach-Object { New-FileFinding ([string]$_.path) $project $mode $_ })
    $sources = @($files.effectiveSource | Sort-Object -Unique)
    $conflicts = @($files.shadowConflict)
    $statuses = @($files.migrationStatus)
    $source = if ($sources -contains 'override') { 'override' } elseif ($sources -contains 'installed') { 'installed' } elseif ($mode -eq 'shared') { 'shared' } else { 'installed' }
    $conflict = if ($conflicts -contains 'modified') { 'modified' } elseif ($conflicts -contains 'identical') { 'identical' } elseif ($conflicts -contains 'unknown') { 'unknown' } else { 'none' }
    $status = if ($statuses -contains 'modified') { 'modified' } elseif ($files.Count -and @($statuses | Where-Object { $_ -ne 'not-installed' }).Count -eq 0) { 'not-installed' } elseif ($files.Count) { 'shadowed' } else { 'not-installed' }
    [pscustomobject]@{ projectId = $id; projectPathHash = $projectPathHash; effectiveSource = $source; shadowConflict = $conflict; migrationStatus = $status; files = $files }
}

$status = 'complete'
$targets = @()
if (-not (Test-Path -LiteralPath $TargetsPath -PathType Leaf)) {
    $status = 'needs-target-configuration'
} else {
    try {
        $registry = Get-Content -LiteralPath $TargetsPath -Raw | ConvertFrom-Json
        $projects = Get-ObjectValue $registry 'projects'
        $configuredTargets = Get-ObjectValue $registry 'targets'
        $targets = if ($registry -is [array]) { @($registry) } elseif ($projects) { @($projects) } elseif ($configuredTargets) { @($configuredTargets) } else { @() }
        if (-not $targets.Count) { $status = 'needs-target-configuration' }
        if ($targets.Count -gt 100) { throw 'Target registry exceeds the 100-target audit limit.' }
    } catch {
        $receipt = [ordered]@{ schemaVersion = 1; status = 'invalid-registry'; factoryVersion = $factoryVersion; generatedAt = (Get-Date).ToUniversalTime().ToString('o'); targets = @(); summary = [ordered]@{ total = 0; shared = 0; shadowed = 0; modified = 0; notInstalled = 0; unreachable = 0; unknown = 0 }; errorCode = 'registry-invalid' }
        $status = 'invalid-registry'
    }
}

if ($status -ne 'invalid-registry') {
    $results = @()
    for ($i = 0; $i -lt $targets.Count; $i++) { $results += Get-TargetResult $targets[$i] ($i + 1) }
    $fileCount = @($results | ForEach-Object { $_.files.Count } | Measure-Object -Sum).Sum
    if ($fileCount -gt 5000) { throw 'Audit result exceeds the 5,000-file receipt limit.' }
    $receipt = [ordered]@{
        schemaVersion = 1
        status = $status
        factoryVersion = $factoryVersion
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        targets = $results
        summary = [ordered]@{
            total = $results.Count
            shared = @($results | Where-Object migrationStatus -eq 'shared').Count
            shadowed = @($results | Where-Object migrationStatus -eq 'shadowed').Count
            modified = @($results | Where-Object migrationStatus -eq 'modified').Count
            notInstalled = @($results | Where-Object migrationStatus -eq 'not-installed').Count
            unreachable = @($results | Where-Object migrationStatus -eq 'unreachable').Count
            unknown = @($results | Where-Object migrationStatus -eq 'unknown').Count
        }
    }
}

$receiptJson = $receipt | ConvertTo-Json -Depth 8
if (-not (Test-Json -Json $receiptJson -SchemaFile (Join-Path $repo 'schemas/shadow-audit-receipt.schema.json'))) {
    throw 'Shadow audit receipt failed schema validation.'
}
$receiptFullPath = if ([IO.Path]::IsPathRooted($ReceiptPath)) { $ReceiptPath } else { Join-Path (Get-Location).Path $ReceiptPath }
$receiptParent = Split-Path -Parent $receiptFullPath
if ($receiptParent) { New-Item -ItemType Directory -Path $receiptParent -Force | Out-Null }
$tempPath = "$receiptFullPath.tmp"
[IO.File]::WriteAllText($tempPath, "$receiptJson`n", [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempPath -Destination $receiptFullPath -Force
Write-Output $receiptJson
if ($status -eq 'invalid-registry') { exit 1 }
