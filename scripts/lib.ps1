# Shared helpers for install/update/diff/verify. Dot-source this file.
Set-StrictMode -Version Latest

$script:ManifestName = 'manifest.json'

function Get-DefaultFactoryRoot { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

function Get-FactoryDir([string]$ProjectPath) { Join-Path $ProjectPath '.ai/factory' }

function Get-FactoryVersion([string]$FactoryRoot) {
    $v = Join-Path $FactoryRoot 'VERSION'
    if (-not (Test-Path $v)) { throw "VERSION not found in factory source '$FactoryRoot'" }
    (Get-Content -Raw $v).Trim()
}

function Test-SemVer([string]$Value) { $Value -match '^\d+\.\d+\.\d+$' }

# Minimal YAML reader for factory.config.yaml: top-level lists and one nested level of scalars.
function Read-FactoryConfig([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Config not found: $Path" }
    $cfg = [ordered]@{}
    $section = $null
    foreach ($line in (Get-Content $Path)) {
        if ($line -match '^\s*(#.*)?$') { continue }
        if ($line -match '^(\w+):\s*$') { $section = $Matches[1]; $cfg[$section] = $null; continue }
        if ($line -match '^\s+-\s+(.+?)\s*$') {
            if ($null -eq $cfg[$section]) { $cfg[$section] = @() }
            $cfg[$section] = @($cfg[$section]) + ($Matches[1].Trim('"'))
            continue
        }
        if ($line -match '^\s+(\w+):\s*(.*?)\s*$' -and $section) {
            if ($null -eq $cfg[$section]) { $cfg[$section] = [ordered]@{} }
            $cfg[$section][$Matches[1]] = $Matches[2].Trim('"')
        }
    }
    $cfg
}

function Test-FactoryConfig($Config) {
    $errs = @()
    foreach ($k in 'factory', 'workflows', 'skills', 'project', 'validation') {
        if (-not $Config.Contains($k) -or $null -eq $Config[$k]) { $errs += "missing section '$k'" }
    }
    if ($Config.Contains('factory') -and $Config['factory']) {
        $f = $Config['factory']
        if (-not $f.Contains('source')) { $errs += 'factory.source missing' }
        if (-not $f.Contains('version') -or -not (Test-SemVer $f['version'])) { $errs += 'factory.version missing or not x.y.z' }
    }
    $errs
}

# Drain both child streams while retaining at most 64 KiB of each. In
# particular, one enormous line must not defeat the output bound.
function New-ValidationCapture {
    if (-not ('FactoryValidationCappedStream' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
public sealed class FactoryValidationCappedStream : Stream {
    private readonly MemoryStream saved = new MemoryStream();
    private readonly int limit;
    public long BytesSeen { get; private set; }
    public FactoryValidationCappedStream(int limit) { this.limit = limit; }
    public byte[] SavedBytes() { return saved.ToArray(); }
    public override void Write(byte[] buffer, int offset, int count) {
        BytesSeen += count;
        int keep = Math.Min(count, Math.Max(0, limit - (int)saved.Length));
        if (keep > 0) saved.Write(buffer, offset, keep);
    }
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) {
        Write(buffer, offset, count);
        return Task.CompletedTask;
    }
    public override bool CanRead { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return true; } }
    public override long Length { get { return saved.Length; } }
    public override long Position { get { return saved.Position; } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
}
'@
    }
    [FactoryValidationCappedStream]::new(65536)
}

function Get-ValidationTimeoutSeconds([string]$Stage) {
    if ($Stage -eq 'changed') { return 1200 }
    return 7200
}

function Invoke-FactoryValidation {
    param(
        [ValidateSet('changed', 'full', 'verify')][string]$Stage,
        [string]$WrapperPath,
        [string]$Task = '',
        [switch]$Quiet
    )
    $root = (Get-Location).Path
    $gitRoot = @(& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and $gitRoot.Count -gt 0) { $root = ([string]$gitRoot[0]).Trim() }
    $attempt = [guid]::NewGuid().ToString('N')
    $relative = ".factory/artifacts/validation/$Stage/$attempt"
    $directory = Join-Path $root $relative
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $stdoutPath = Join-Path $directory 'stdout.log'
    $stderrPath = Join-Path $directory 'stderr.log'
    $receiptPath = Join-Path $directory 'receipt.json'
    $receipt = [ordered]@{
        schemaVersion = 1; issue = 0; repository = ''; pr = ''; headSha = ''
        stage = $Stage; status = 'error'; exitCode = 1
        artifactPaths = @("$relative/stdout.log", "$relative/stderr.log", "$relative/receipt.json")
        worktreeClean = $false; timeoutSeconds = (Get-ValidationTimeoutSeconds $Stage)
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        finishedAt = ''; command = ''; truncated = $false; message = ''
    }
    $stdout = [byte[]]@(); $stderr = [byte[]]@()
    try {
        if ($env:FACTORY_VALIDATION_ROOT -and
            [string]::Equals([IO.Path]::GetFullPath($env:FACTORY_VALIDATION_ROOT), [IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Nested Factory validation in the same worktree is not allowed.'
        }
        if ($LASTEXITCODE -ne 0 -or $gitRoot.Count -eq 0) { throw 'Current directory is not inside a Git worktree.' }
        $head = @(& git -C $root rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0 -or $head.Count -eq 0) { throw 'Cannot resolve the current worktree HEAD.' }
        $receipt.headSha = ([string]$head[0]).Trim()
        $dirty = @(& git -C $root status --porcelain 2>$null)
        $receipt.worktreeClean = ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0)
        $remote = [string](@(& git -C $root config --get remote.origin.url 2>$null) | Select-Object -First 1)
        if ($remote -match '(?i)github\.com[:/](?<slug>[^/\s]+/[^/\s]+?)(?:\.git)?$') { $receipt.repository = $Matches.slug }
        $resultPath = Join-Path $root '.factory/implement-result.json'
        if (-not (Test-Path $resultPath)) { $resultPath = Join-Path $root '.factory/review-result.json' }
        if (Test-Path $resultPath) {
            $result = Get-Content -Raw $resultPath | ConvertFrom-Json
            if ($result.issue) { $receipt.issue = [int]$result.issue }
            if ($result.pr) { $receipt.pr = [string]$result.pr }
        }
        if ($Task -match '(?:issues/|#)?([1-9][0-9]*)$') { $receipt.issue = [int]$Matches[1] }
        if (Test-Path (Join-Path $root '.factory/already-resolved.json')) {
            $receipt.status = 'skipped'; $receipt.exitCode = 0; $receipt.message = 'Issue already resolved.'
            return 0
        }
        $configPath = Join-Path $root '.ai/factory/factory.config.yaml'
        $config = Read-FactoryConfig $configPath
        if (-not $config.Contains('validation') -or $null -eq $config.validation -or -not $config.validation.Contains($Stage)) {
            throw "Configured validation.$Stage command is missing from $configPath."
        }
        $command = ([string]$config.validation[$Stage]).Trim()
        if (-not $command) { throw "Configured validation.$Stage command is empty." }
        if ($command -eq 'skip' -and $Stage -eq 'changed') {
            $receipt.status = 'skipped'; $receipt.exitCode = 0; $receipt.message = 'Targeted validation explicitly unsupported.'
            return 0
        }
        if ($command -eq 'skip') { throw "Required validation.$Stage cannot be skipped." }
        $receipt.command = $command
        foreach ($match in [regex]::Matches($command, '(?:"[^"]+\.ps1"|''[^'']+\.ps1''|[^\s]+\.ps1)')) {
            $candidate = $match.Value.Trim('"', "'")
            $candidatePath = if ([IO.Path]::IsPathRooted($candidate)) { $candidate } else { Join-Path $root $candidate }
            $resolved = [IO.Path]::GetFullPath($candidatePath)
            if ([string]::Equals($resolved, [IO.Path]::GetFullPath($WrapperPath), [StringComparison]::OrdinalIgnoreCase)) {
                throw "Configured validation.$Stage recursively invokes its Factory wrapper."
            }
        }
        $start = [Diagnostics.ProcessStartInfo]::new('pwsh')
        $start.ArgumentList.Add('-NoProfile')
        $start.ArgumentList.Add('-EncodedCommand')
        $start.ArgumentList.Add([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))
        $start.WorkingDirectory = $root
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.Environment['FACTORY_VALIDATION_ROOT'] = $root
        $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
        if (-not $process.Start()) { throw "Could not start configured validation.$Stage command." }
        $outCapture = New-ValidationCapture; $errCapture = New-ValidationCapture
        $outTask = $process.StandardOutput.BaseStream.CopyToAsync($outCapture)
        $errTask = $process.StandardError.BaseStream.CopyToAsync($errCapture)
        if (-not $process.WaitForExit([int]$receipt.timeoutSeconds * 1000)) {
            $process.Kill($true); $process.WaitForExit()
            throw "Configured validation.$Stage exceeded the $($receipt.timeoutSeconds)-second limit."
        }
        [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outTask, $errTask)).GetAwaiter().GetResult()
        $stdout = $outCapture.SavedBytes(); $stderr = $errCapture.SavedBytes()
        $receipt.truncated = ($outCapture.BytesSeen -gt 65536 -or $errCapture.BytesSeen -gt 65536)
        $receipt.exitCode = [int]$process.ExitCode
        $receipt.status = if ($process.ExitCode -eq 0) { 'passed' } else { 'failed' }
        if ($receipt.truncated) { $receipt.message = 'Output truncated to 64 KiB per stream.' }
    } catch {
        $receipt.status = 'error'; $receipt.exitCode = 1; $receipt.message = $_.Exception.Message
    } finally {
        # A project runner can modify tracked files or create untracked files
        # after the initial snapshot. Keep the receipt clean only if both the
        # pre-run and post-run worktree are clean.
        $postRunStatus = @(& git -C $root status --porcelain 2>$null)
        $receipt.worktreeClean = ($receipt.worktreeClean -and $LASTEXITCODE -eq 0 -and $postRunStatus.Count -eq 0)
        [IO.File]::WriteAllBytes($stdoutPath, $stdout)
        [IO.File]::WriteAllBytes($stderrPath, $stderr)
        $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
        $receipt | ConvertTo-Json -Depth 6 | Set-Content -Path $receiptPath -Encoding utf8
        if (-not $Quiet) { Write-Host ($receipt | ConvertTo-Json -Compress -Depth 6) }
    }
    if ($receipt.status -eq 'passed' -or ($Stage -eq 'changed' -and $receipt.status -eq 'skipped')) { return 0 }
    return 1
}

function Get-MarkerStyle([string]$RelPath) {
    if ($RelPath -match '\.md$') { return 'html' }
    if ($RelPath -match '\.(ya?ml|ps1)$') { return 'hash' }
    'none'
}

# Remove any existing managed header, return the body (LF endings).
function Remove-Marker([string]$Text, [string]$Style) {
    $t = $Text -replace "`r`n", "`n"
    if ($Style -eq 'html') { $t = [regex]::Replace($t, '\A<!--\s*\nmanaged-by:[\s\S]*?-->\n?', '') }
    elseif ($Style -eq 'hash') { $t = [regex]::Replace($t, '\A# GENERATED BY CEZAR-FACTORY\n(#[^\n]*\n)*', '') }
    $t
}

# Build the installed content (LF line endings) for a source file.
function New-ManagedContent([string]$SourceFile, [string]$RelSource, [string]$Version) {
    $style = Get-MarkerStyle $RelSource
    $raw = [IO.File]::ReadAllText($SourceFile)
    $body = Remove-Marker $raw $style
    switch ($style) {
        'html' { "<!--`nmanaged-by: cezar-factory`nfactory-version: $Version`nsource: $RelSource`n-->`n$body" }
        'hash' { "# GENERATED BY CEZAR-FACTORY`n# factory-version: $Version`n# source: $RelSource`n# DO NOT EDIT DIRECTLY`n$body" }
        default { $raw -replace "`r`n", "`n" }
    }
}

function Get-TextHash([string]$Text) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    # Use the provider API so the factory works under both PowerShell 7/.NET
    # and Windows PowerShell 5.1/.NET Framework.
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash($bytes) }
    finally { $sha.Dispose() }
    ([BitConverter]::ToString($digest) -replace '-', '').ToLower()
}

function Write-Utf8([string]$Path, [string]$Text) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Get-FeatureOn($Config, [string]$Name) {
    $Config.Contains('features') -and $Config['features'] -and $Config['features'].Contains($Name) -and $Config['features'][$Name] -eq 'true'
}

# Where a factory source file lives inside a project (Cezar's own discovery locations).
#   workflows/X.yaml        -> .ai/cezar/workflows/factory-X.yaml  (workflow name inside is factory-X)
#   skills/S/SKILL.md       -> .ai/skills/S/SKILL.md
#   policies|schemas|scripts-> .ai/factory/<same path>
#   automations/*.json      -> .ai/factory/automations/*.json (applied to Cezar by sync-automations.ps1)
function Get-TargetPath([string]$Rel) {
    if ($Rel -match '^workflows/(.+)$') { return ".ai/cezar/workflows/factory-$($Matches[1])" }
    if ($Rel -match '^skills/(.+)$') { return ".ai/skills/$($Matches[1])" }
    ".ai/factory/$Rel"
}

# Factory scripts that run inside projects (called by workflows/skills).
$script:RuntimeScripts = @('validate-result.ps1', 'route-state.ps1', 'check-already-resolved.ps1', 'prepare-implementation.ps1', 'ensure-implementation-result.ps1', 'ensure-pr-closes-issue.ps1', 'factory-startup.ps1', 'sync-automations.ps1', 'watchdog-automations.ps1', 'create-labels.ps1', 'audit-backlog-labels.ps1', 'recover-audit-reservations.ps1', 'audit-factory-failures.ps1', 'refresh-stale-workable.ps1', 'maintain-repository.ps1', 'godot-upgrade.ps1', 'validate-automation-catalog.ps1', 'reconcile-backlog.ps1', 'lease.ps1', 'record-local-evaluation.ps1', 'evaluate-local-promotion.ps1', 'local/run-local-job.ps1', 'openhands/validate-job.ps1', 'hindsight/client.py', 'hindsight/recall.ps1', 'hindsight/retain.ps1')

# Desired managed files for a config. Each: Target (project-relative, '/'), Content, Hash.
# A project override at .ai/factory/overrides/<source path> fully replaces the factory file.
function Get-DesiredFiles([string]$FactoryRoot, $Config, [string]$Version, [string]$ProjectPath) {
    $skills = @($Config['skills']); $workflows = @($Config['workflows'])
    $selected = [System.Collections.Generic.List[string]]::new()
    foreach ($s in $skills) {
        $p = "skills/$s/SKILL.md"
        if (-not (Test-Path (Join-Path $FactoryRoot $p))) { throw "Requested skill '$s' not found in factory $Version" }
        $selected.Add($p)
    }
    foreach ($w in $workflows) {
        $p = "workflows/$w.yaml"
        if (-not (Test-Path (Join-Path $FactoryRoot $p))) { throw "Requested workflow '$w' not found in factory $Version" }
        $selected.Add($p)
    }
    foreach ($dir in 'policies', 'schemas', 'routing') {
        foreach ($f in Get-ChildItem (Join-Path $FactoryRoot $dir) -File -Recurse) {
            $selected.Add(($f.FullName.Substring($FactoryRoot.Length).TrimStart([char[]]'\/') -replace '\\', '/'))
        }
    }
    foreach ($sc in $script:RuntimeScripts) { $selected.Add("scripts/$sc") }
    $maint = Get-FeatureOn $Config 'maintenance'
    $labelCleanup = Get-FeatureOn $Config 'backlog_label_cleanup'
    $combinedMaintenance = $maint -or $labelCleanup
    if ($combinedMaintenance -and $workflows -notcontains 'maintenance') { $selected.Add('workflows/maintenance.yaml') }
    if ($combinedMaintenance -and $skills -notcontains 'factory-backlog-label-audit') { $selected.Add('skills/factory-backlog-label-audit/SKILL.md') }
    $godotUpgrade = Get-FeatureOn $Config 'godot_upgrade'
    if ($godotUpgrade -and $workflows -notcontains 'godot-upgrade') { $selected.Add('workflows/godot-upgrade.yaml') }
    if ($godotUpgrade -and $skills -notcontains 'factory-godot-upgrade') { $selected.Add('skills/factory-godot-upgrade/SKILL.md') }
    if ((Get-FeatureOn $Config 'knowledge_extraction') -and $skills -notcontains 'factory-learn') { $selected.Add('skills/factory-learn/SKILL.md') }
    if ((Get-FeatureOn $Config 'backlog_reconciliation') -and $skills -notcontains 'factory-work-backlog') { $selected.Add('skills/factory-work-backlog/SKILL.md') }
    # Automations: only those whose workflow is installed (maintenance only with the feature on).
    $allWorkflows = @($workflows) + $(if ($combinedMaintenance) { 'maintenance' }) + $(if ($godotUpgrade) { 'godot-upgrade' })
    foreach ($f in Get-ChildItem (Join-Path $FactoryRoot 'automations') -File -Filter *.json) {
        $def = Get-Content -Raw $f.FullName | ConvertFrom-Json
        if ($f.BaseName -eq 'maintenance' -and -not $combinedMaintenance) { continue }
        if ($f.BaseName -eq 'godot-upgrade' -and -not $godotUpgrade) { continue }
        $wf = $def.task.workflow -replace '^factory-', ''
        if ($wf -and $allWorkflows -notcontains $wf) { continue }
        $selected.Add("automations/$($f.Name)")
    }
    foreach ($rel in ($selected | Sort-Object -Unique)) {
        $src = Join-Path $FactoryRoot $rel
        $label = $rel
        if ($ProjectPath) {
            $ov = Join-Path (Get-FactoryDir $ProjectPath) "overrides/$rel"
            if (Test-Path $ov) { $src = $ov; $label = "overrides/$rel" }
        }
        $content = New-ManagedContent $src $label $Version
        $target = Get-TargetPath $rel
        [pscustomobject]@{ Target = $target; Content = $content; Hash = (Get-TextHash $content) }
    }
}

function Read-Manifest([string]$FactoryDir) {
    $p = Join-Path $FactoryDir $script:ManifestName
    if (-not (Test-Path $p)) { return $null }
    Get-Content -Raw $p | ConvertFrom-Json
}

function Write-Manifest([string]$FactoryDir, [string]$Version, $Files) {
    $m = [ordered]@{
        factory_version = $Version
        files           = @($Files | ForEach-Object { [ordered]@{ path = $_.Target; sha256 = $_.Hash } })
    }
    Write-Utf8 (Join-Path $FactoryDir $script:ManifestName) (($m | ConvertTo-Json -Depth 5) + "`n")
}

# Hash of a file on disk with LF endings, for drift comparison.
function Get-FileTextHash([string]$Path) {
    Get-TextHash (([IO.File]::ReadAllText($Path)) -replace "`r`n", "`n")
}

function Resolve-ProjectPath([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Project path not found: $Path" }
    (Resolve-Path $Path).Path
}

# Shared sync: reconcile project's .ai/factory against desired files. Returns change summary.
# Ownership rule: only paths listed in the existing manifest may be overwritten/removed. An existing
# file at a desired path that is not in the manifest (and differs) is "ambiguous" and blocks the sync.
function Invoke-FactorySync {
    param([string]$ProjectPath, [string]$FactoryRoot, [string]$ConfigPath, [switch]$DryRun)

    $fdir = Get-FactoryDir $ProjectPath
    $cfg = Read-FactoryConfig $ConfigPath
    $errs = Test-FactoryConfig $cfg
    if ($errs) { throw "Invalid config: $($errs -join '; ')" }
    $pin = $cfg['factory']['version']
    $srcVersion = Get-FactoryVersion $FactoryRoot
    if ($pin -ne $srcVersion) { throw "Config pins factory $pin but factory source is $srcVersion. Update the pin or use a matching factory checkout." }

    $desired = @(Get-DesiredFiles $FactoryRoot $cfg $srcVersion $ProjectPath)
    $manifest = Read-Manifest $fdir
    $owned = @{}
    if ($manifest) { foreach ($f in $manifest.files) { $owned[$f.path] = $f.sha256 } }
    $desiredMap = @{}; foreach ($d in $desired) { $desiredMap[$d.Target] = $d }

    $r = [ordered]@{ Added = @(); Updated = @(); Unchanged = @(); Removed = @(); Ambiguous = @(); Modified = @(); Blocked = $false; FromVersion = $(if ($manifest) { $manifest.factory_version } else { $null }); ToVersion = $srcVersion }
    foreach ($d in $desired) {
        $dest = Join-Path $ProjectPath $d.Target
        if (-not (Test-Path $dest)) { $r.Added += $d.Target; continue }
        $cur = Get-FileTextHash $dest
        if ($cur -eq $d.Hash) { $r.Unchanged += $d.Target; continue }
        if (-not $owned.ContainsKey($d.Target)) { $r.Ambiguous += $d.Target; continue }
        if ($cur -ne $owned[$d.Target]) { $r.Modified += $d.Target; continue }
        $r.Updated += $d.Target
    }
    foreach ($p in $owned.Keys) {
        if ($desiredMap.ContainsKey($p)) { continue }
        $dest = Join-Path $ProjectPath $p
        if (-not (Test-Path $dest)) { continue }
        if ((Get-FileTextHash $dest) -ne $owned[$p]) { $r.Modified += $p } else { $r.Removed += $p }
    }
    $r.Blocked = [bool]($r.Ambiguous.Count -or $r.Modified.Count)
    if ($r.Blocked) { return [pscustomobject]$r }

    if (-not $DryRun) {
        foreach ($d in $desired) { Write-Utf8 (Join-Path $ProjectPath $d.Target) $d.Content }
        foreach ($p in $r.Removed) {
            $dest = Join-Path $ProjectPath $p
            Remove-Item $dest -Force
            $parent = Split-Path $dest -Parent
            while ($parent.Length -gt $ProjectPath.Length + 5 -and (Test-Path $parent) -and -not (Get-ChildItem $parent -Force)) { Remove-Item $parent -Force; $parent = Split-Path $parent -Parent }
        }
        Write-Utf8 (Join-Path $fdir 'VERSION') "$srcVersion`n"
        Write-Manifest $fdir $srcVersion $desired
        # Gitignore fragment (factory-owned, tracked in manifest-free file for projects to append)
        $frag = Join-Path $FactoryRoot 'templates/gitignore.fragment'
        if (Test-Path $frag) { Write-Utf8 (Join-Path $fdir 'gitignore.fragment') ([IO.File]::ReadAllText($frag) -replace "`r`n", "`n") }
    }
    [pscustomobject]$r
}

function Write-SyncSummary($R, [switch]$DryRun) {
    $from = if ($R.FromVersion) { $R.FromVersion } else { '(none)' }
    Write-Host "Factory $from -> $($R.ToVersion)$(if ($DryRun) { ' [DRY-RUN]' })"
    foreach ($k in 'Updated', 'Added', 'Removed', 'Ambiguous', 'Modified') {
        if (@($R.$k).Count) { Write-Host "$k`:"; $R.$k | ForEach-Object { Write-Host "  $_" } }
    }
    Write-Host "Unchanged: $(@($R.Unchanged).Count) files"
    Write-Host 'Project-owned files:'
    Write-Host '  unchanged'
}
