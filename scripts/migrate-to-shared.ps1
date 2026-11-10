#!/usr/bin/env pwsh
<#
.SYNOPSIS
Prepare a reviewed migration of identical installed Factory files to the shared checkout.
.DESCRIPTION
Consumes the explicit, schema-validated shadow-audit receipt and one project ID. The default
mode is read-only. -CreatePullRequest creates a separate worktree from origin/dev, rechecks the
receipt, manifest and live source hashes there, records a backout plan before removing anything,
and pushes a migration branch with a PR. The caller's target checkout is never modified.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [Parameter(Mandatory)][string]$ProjectId,
    [Parameter(Mandatory)][string]$AuditReceiptPath,
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..'),
    [string]$ReviewArtifactRoot = '',
    [string]$GhCommand = 'gh',
    [switch]$CreatePullRequest
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$factory = (Resolve-Path -LiteralPath $FactoryPath).Path
$project = (Resolve-ProjectPath $ProjectPath)
$receiptPath = (Resolve-Path -LiteralPath $AuditReceiptPath).Path
$reviewRoot = if ($ReviewArtifactRoot) { $ReviewArtifactRoot } else { Join-Path $factory '.factory/release-reports/shadow-migration' }
$receiptSchema = Join-Path $factory 'schemas/shadow-audit-receipt.schema.json'
$receiptJson = Get-Content -LiteralPath $receiptPath -Raw
if (-not (Test-Json -Json $receiptJson -SchemaFile $receiptSchema)) { throw 'Shadow audit receipt is invalid.' }
$receipt = $receiptJson | ConvertFrom-Json
if ($receipt.status -ne 'complete') { throw "Shadow audit status '$($receipt.status)' is not eligible for migration." }
function Get-ProjectPathHash([string]$Path) {
    $canonical = [IO.Path]::GetFullPath($Path).Replace('\', '/')
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path)).Replace('\', '/')
    if ($canonical.Length -gt $root.Length) { $canonical = $canonical.TrimEnd('/') }
    if ([IO.Path]::DirectorySeparatorChar -eq [char]'\') { $canonical = $canonical.ToLowerInvariant() }
    Get-TextHash $canonical
}
$matches = @($receipt.targets | Where-Object { $_.projectId -ceq $ProjectId })
if ($matches.Count -ne 1) { throw "Receipt must contain exactly one target for project '$ProjectId'." }
$receiptTarget = $matches[0]
$projectPathHash = Get-ProjectPathHash $project
if (-not $receiptTarget.projectPathHash -or $receiptTarget.projectPathHash -cne $projectPathHash) {
    throw "Audit receipt path identity does not match target project '$ProjectId'. Rerun the audit for this checkout."
}
if ($receiptTarget.migrationStatus -notin @('shadowed', 'modified')) { throw "Target '$ProjectId' is '$($receiptTarget.migrationStatus)' and cannot be migrated." }

function Invoke-Git([string]$WorkingDirectory, [string[]]$GitArgs, [switch]$AllowDifference) {
    $output = @(& git -C $WorkingDirectory @GitArgs 2>&1)
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not ($AllowDifference -and $code -eq 1)) {
        throw "git $($GitArgs -join ' ') failed in '$WorkingDirectory' (exit $code): $($output -join "`n")"
    }
    [pscustomobject]@{ Code = $code; Output = ($output -join "`n") }
}

function Write-AtomicJson([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-ReviewDiff([string]$LeftPath, [string]$RightPath, [string]$OutputPath) {
    $parent = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $diff = @(& git diff --no-index --no-ext-diff --text -- $LeftPath $RightPath 2>&1)
    if ($LASTEXITCODE -gt 1) { throw "Could not create a review diff for '$RightPath'." }
    [IO.File]::WriteAllText($OutputPath, (($diff -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
}

function Get-MigrationSelection([string]$Root, [string]$ReviewDirectory) {
    $factoryDir = Get-FactoryDir $Root
    $manifest = Read-Manifest $factoryDir
    if (-not $manifest -or -not ($manifest.files -is [array])) { throw "${Root}: no valid Factory manifest; refusing migration." }
    if ($manifest.files.Count -gt 1000) { throw 'Factory manifest exceeds the migration file limit.' }
    $receiptFiles = @{}
    foreach ($file in $receiptTarget.files) {
        if ($receiptFiles.ContainsKey([string]$file.path)) { throw "Audit receipt repeats path '$($file.path)'." }
        $receiptFiles[[string]$file.path] = $file
    }
    $removable = [System.Collections.Generic.List[object]]::new()
    $review = [System.Collections.Generic.List[object]]::new()
    $retained = [System.Collections.Generic.List[object]]::new()
    $seenManifestPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        $relative = ([string]$entry.path).Replace('\', '/')
        if ($relative -notmatch '^\.ai/' -or $relative -match '(^|/)\.\.(/|$)') { throw "Unsafe managed path '$relative' in manifest." }
        if (-not $seenManifestPaths.Add($relative)) { throw "Factory manifest repeats path '$relative'." }
        if ([string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Factory manifest has an invalid hash for '$relative'." }
        if (-not $receiptFiles.ContainsKey($relative)) { throw "Audit receipt is missing manifest path '$relative'; rerun the audit." }
        $auditFile = $receiptFiles[$relative]
        $targetPath = [IO.Path]::GetFullPath((Join-Path $Root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)))
        $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar
        if (-not $targetPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Managed path '$relative' escapes the project." }
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) { $retained.Add($entry); continue }
        $sourceRelative = [string]$auditFile.sourcePath
        if ($auditFile.effectiveSource -eq 'override' -or $sourceRelative -match '^overrides/') { $retained.Add($entry); continue }
        if ($auditFile.migrationStatus -eq 'modified' -or $auditFile.shadowConflict -eq 'modified') {
            $retained.Add($entry)
            $sourcePath = if ($sourceRelative -and $sourceRelative -notmatch '(^|/)\.\.(/|$)' -and -not [IO.Path]::IsPathRooted($sourceRelative)) { Join-Path $factory $sourceRelative } else { $null }
            if ($sourcePath -and (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                $diffPath = Join-Path $ReviewDirectory ((Get-TextHash $relative) + '.diff')
                Get-ReviewDiff $sourcePath $targetPath $diffPath
                $review.Add([pscustomobject]@{ path = $relative; diffPath = $diffPath; reason = 'audit-reported-modified' })
            }
            continue
        }
        if ($auditFile.migrationStatus -ne 'shadowed' -or $auditFile.shadowConflict -ne 'identical' -or -not $sourceRelative) {
            $retained.Add($entry)
            continue
        }
        $sourceRelative = $sourceRelative.Replace('\', '/')
        if ($sourceRelative -match '(^|/)\.\.(/|$)' -or [IO.Path]::IsPathRooted($sourceRelative)) { throw "Unsafe shared source path '$sourceRelative'." }
        $sourcePath = [IO.Path]::GetFullPath((Join-Path $factory ($sourceRelative -replace '/', [IO.Path]::DirectorySeparatorChar)))
        $factoryPrefix = $factory.TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar
        if (-not $sourcePath.StartsWith($factoryPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            $retained.Add($entry)
            continue
        }
        $installedHash = Get-FileTextHash $targetPath
        if ($installedHash -ne [string]$entry.sha256) {
            $retained.Add($entry)
            $diffPath = Join-Path $ReviewDirectory ((Get-TextHash $relative) + '.diff')
            Get-ReviewDiff $sourcePath $targetPath $diffPath
            $review.Add([pscustomobject]@{ path = $relative; diffPath = $diffPath; reason = 'manifest-hash-mismatch' })
            continue
        }
        $style = Get-MarkerStyle $sourceRelative
        $installedBody = Remove-Marker ([IO.File]::ReadAllText($targetPath)) $style
        $sharedBody = Remove-Marker ([IO.File]::ReadAllText($sourcePath)) $style
        if ((Get-TextHash $installedBody) -ne (Get-TextHash $sharedBody)) {
            $retained.Add($entry)
            $diffPath = Join-Path $ReviewDirectory ((Get-TextHash $relative) + '.diff')
            Get-ReviewDiff $sourcePath $targetPath $diffPath
            $review.Add([pscustomobject]@{ path = $relative; diffPath = $diffPath; reason = 'shared-source-hash-mismatch' })
            continue
        }
        $removable.Add([pscustomobject]@{ path = $relative; sha256 = $installedHash; sourcePath = $sourceRelative })
    }
    [pscustomobject]@{ removable = @($removable); retained = @($retained); review = @($review); manifest = $manifest }
}

$reviewDirectory = Join-Path $reviewRoot "$($ProjectId -replace '[^A-Za-z0-9._-]', '_')-$([guid]::NewGuid().ToString('N'))"
$selection = Get-MigrationSelection $project $reviewDirectory
$plan = [ordered]@{
    schemaVersion = 1
    status = if ($selection.removable.Count) { 'ready' } else { 'no-safe-files' }
    projectId = $ProjectId
    projectPath = $project
    receiptPath = $receiptPath
    removable = $selection.removable
    retained = $selection.retained.Count
    reviewDiffs = $selection.review
    reviewDirectory = $reviewDirectory
}

if (-not $CreatePullRequest) {
    Write-Output ($plan | ConvertTo-Json -Depth 10)
    exit 0
}
if (-not $selection.removable.Count) {
    Write-Output ($plan | ConvertTo-Json -Depth 10)
    exit 0
}

$status = (Invoke-Git $project @('status', '--porcelain', '--untracked-files=all')).Output
if ($status) { throw "Target '$ProjectId' is dirty; refusing migration." }
$null = Invoke-Git $project @('fetch', 'origin', 'dev')
$baseSha = (Invoke-Git $project @('rev-parse', 'origin/dev')).Output.Trim()
if ($baseSha -notmatch '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$') { throw "Could not resolve origin/dev for target '$ProjectId'." }
$slug = ($ProjectId.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
if (-not $slug) { throw 'Project ID cannot produce a migration branch name.' }
$branch = "codex/migrate-factory-$($slug.Substring(0, [Math]::Min(32, $slug.Length)))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$worktree = Join-Path ([IO.Path]::GetTempPath()) "cezar-shadow-migration-$([guid]::NewGuid().ToString('N'))"
$addedWorktree = $false
try {
    $null = Invoke-Git $project @('worktree', 'add', '--quiet', '-b', $branch, $worktree, 'origin/dev')
    $addedWorktree = $true
    $selection = Get-MigrationSelection $worktree $reviewDirectory
    if (-not $selection.removable.Count) { throw 'No receipt-approved files remain identical on the origin/dev base.' }
    $backoutPath = Join-Path (Get-FactoryDir $worktree) 'migration-backout.json'
    $backout = [ordered]@{
        schemaVersion = 1
        projectId = $ProjectId
        baseSha = $baseSha
        branch = $branch
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        removedFiles = $selection.removable
        restoreCommand = "git restore --source $baseSha -- $($selection.removable.path -join ' ')"
    }
    $backoutJson = $backout | ConvertTo-Json -Depth 12
    if (-not (Test-Json -Json $backoutJson -SchemaFile (Join-Path $factory 'schemas/shadow-migration-backout.schema.json'))) {
        throw 'Migration backout record failed schema validation.'
    }
    Write-AtomicJson $backoutPath $backout
    foreach ($file in $selection.removable) {
        $fullPath = Join-Path $worktree ($file.path -replace '/', [IO.Path]::DirectorySeparatorChar)
        Remove-Item -LiteralPath $fullPath -Force
    }
    $selection.manifest.files = @($selection.retained)
    Write-AtomicJson (Join-Path (Get-FactoryDir $worktree) 'manifest.json') $selection.manifest
    foreach ($file in $selection.removable) { $null = Invoke-Git $worktree @('add', '--', $file.path) }
    $null = Invoke-Git $worktree @('add', '--', '.ai/factory/manifest.json', '.ai/factory/migration-backout.json')
    $null = Invoke-Git $worktree @('diff', '--cached', '--check')
    $staged = (Invoke-Git $worktree @('diff', '--cached', '--name-only')).Output
    if (-not $staged) { throw 'Migration branch contains no changes.' }
    $null = Invoke-Git $worktree @('commit', '-m', "Migrate $ProjectId to shared Factory files")
    $null = Invoke-Git $worktree @('push', '--set-upstream', 'origin', $branch)
    $bodyPath = Join-Path ([IO.Path]::GetTempPath()) "shadow-migration-$([guid]::NewGuid().ToString('N')).md"
    try {
        $body = "Remove only manifest-verified Factory files that match the shared checkout for project ``$ProjectId``.`n`n" +
            "Locally modified files remain untouched; review diffs are recorded at ``$($reviewDirectory.Replace('\','/'))``. " +
            "The migration backout record is ``.ai/factory/migration-backout.json``."
        [IO.File]::WriteAllText($bodyPath, $body, [Text.UTF8Encoding]::new($false))
        $prOutput = @(& $GhCommand pr create --base dev --head $branch --title "Migrate $ProjectId to shared Factory" --body-file $bodyPath 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "gh pr create failed: $($prOutput -join "`n")" }
        $prUrl = ($prOutput | Select-Object -Last 1).ToString().Trim()
    }
    finally { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }
    $result = [ordered]@{ schemaVersion = 1; status = 'pr-open'; projectId = $ProjectId; branch = $branch; baseSha = $baseSha; removedFiles = $selection.removable; retainedCount = $selection.retained.Count; reviewDiffs = $selection.review; backoutPath = '.ai/factory/migration-backout.json'; pullRequest = $prUrl }
    Write-Output ($result | ConvertTo-Json -Depth 10)
}
finally {
    if ($addedWorktree) { $null = Invoke-Git $project @('worktree', 'remove', '--force', $worktree) }
}
