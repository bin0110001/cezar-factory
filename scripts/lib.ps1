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

# Parse the deliberately small YAML subset used by factory.config.yaml. Nested
# maps and lists are supported because project validation entries carry their
# own command, timeout, prerequisites and evidence path. This is not a general
# YAML parser; unsupported syntax fails closed instead of being misread.
function Convert-FactoryYamlScalar([string]$Text) {
    $value = $Text.Trim()
    if ($value -match '^"(.*)"$') { return $Matches[1] }
    if ($value -match "^'(.*)'$") { return $Matches[1] }
    if ($value -match '^\[(.*)\]$') {
        $inner = $Matches[1].Trim()
        if (-not $inner) { return ,@() }
        return ,@($inner -split '\s*,\s*' | ForEach-Object { Convert-FactoryYamlScalar $_ })
    }
    if ($value -match '^(?i:true|false)$') { return [bool]::Parse($value) }
    if ($value -match '^-?[0-9]+$') { return [int]$value }
    if ($value -in 'null', '~') { return $null }
    return $value
}

function Read-FactoryConfig([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Config not found: $Path" }
    $cfg = [ordered]@{}
    $stack = [System.Collections.Generic.List[object]]::new()
    foreach ($line in (Get-Content $Path)) {
        if ($line -match '^\s*(#.*)?$') { continue }
        $indent = $line.Length - $line.TrimStart().Length
        if (($indent % 2) -ne 0) { throw "Unsupported YAML indentation in ${Path}: $line" }
        while ($stack.Count -gt 0 -and $indent -le [int]$stack[$stack.Count - 1].Indent) {
            $stack.RemoveAt($stack.Count - 1)
        }

        $parent = $cfg
        if ($stack.Count -gt 0) {
            $entry = $stack[$stack.Count - 1]
            if ($null -eq $entry.Node) {
                if ($line.TrimStart().StartsWith('- ')) {
                    $entry.Node = [System.Collections.Generic.List[object]]::new()
                } else {
                    $entry.Node = [ordered]@{}
                }
                $entry.Parent[$entry.Key] = $entry.Node
            }
            $parent = $entry.Node
        }

        if ($line -match '^\s+-\s+(.+?)\s*$') {
            if ($parent -isnot [System.Collections.IList]) { throw "Unexpected YAML list item in ${Path}: $line" }
            $parent.Add((Convert-FactoryYamlScalar $Matches[1]))
            continue
        }
        if ($line -notmatch '^\s*([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$' -or $parent -isnot [System.Collections.IDictionary]) {
            throw "Unsupported factory.config.yaml syntax in ${Path}: $line"
        }
        $key = $Matches[1]
        $rawValue = [string]$Matches[2]
        if ($rawValue.Trim()) {
            $parent[$key] = Convert-FactoryYamlScalar $rawValue
        } else {
            $parent[$key] = $null
            $stack.Add([pscustomobject]@{ Indent = $indent; Parent = $parent; Key = $key; Node = $null })
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
    private readonly int limit;
    private readonly int firstLimit;
    private readonly MemoryStream first = new MemoryStream();
    private readonly byte[] tail;
    private int tailCount;
    private int tailNext;
    public long BytesSeen { get; private set; }
    public FactoryValidationCappedStream(int limit) {
        this.limit = limit;
        firstLimit = limit / 2;
        tail = new byte[limit - firstLimit];
    }
    public byte[] SavedBytes() {
        byte[] output = new byte[(int)first.Length + tailCount];
        byte[] prefix = first.ToArray();
        Buffer.BlockCopy(prefix, 0, output, 0, prefix.Length);
        int tailStart = tailCount == tail.Length ? tailNext : 0;
        int firstPart = Math.Min(tailCount, tail.Length - tailStart);
        if (firstPart > 0) Buffer.BlockCopy(tail, tailStart, output, prefix.Length, firstPart);
        if (tailCount > firstPart) Buffer.BlockCopy(tail, 0, output, prefix.Length + firstPart, tailCount - firstPart);
        return output;
    }
    public override void Write(byte[] buffer, int offset, int count) {
        BytesSeen += count;
        int prefixKeep = Math.Min(count, Math.Max(0, firstLimit - (int)first.Length));
        if (prefixKeep > 0) first.Write(buffer, offset, prefixKeep);
        for (int index = prefixKeep; index < count; index++) {
            tail[tailNext] = buffer[offset + index];
            tailNext = (tailNext + 1) % tail.Length;
            if (tailCount < tail.Length) tailCount++;
        }
    }
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) {
        Write(buffer, offset, count);
        return Task.CompletedTask;
    }
    public override bool CanRead { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return true; } }
    public override long Length { get { return Math.Min(BytesSeen, limit); } }
    public override long Position { get { return Length; } set { throw new NotSupportedException(); } }
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
        reasonCode = 'validation_error'
        artifactPaths = @("$relative/stdout.log", "$relative/stderr.log", "$relative/receipt.json")
        worktreeClean = $false; timeoutSeconds = (Get-ValidationTimeoutSeconds $Stage); workingDirectory = '.'; evidencePath = ''
        validationResult = $null
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
            $receipt.status = 'skipped'; $receipt.reasonCode = 'issue_already_resolved'; $receipt.exitCode = 0; $receipt.message = 'Issue already resolved.'
            return 0
        }
        $configPath = Join-Path $root '.ai/factory/factory.config.yaml'
        if (-not (Test-Path $configPath)) {
            $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_config_missing'
            $receipt.exitCode = 2; $receipt.message = "Project validation config is missing: $configPath"
            return 1
        }
        $config = Read-FactoryConfig $configPath
        $configStage = @{ changed = 'targeted'; full = 'full'; verify = 'verify' }[$Stage]
        if (-not $config.Contains('validation') -or $null -eq $config.validation) {
            $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_command_missing'
            $receipt.exitCode = 2; $receipt.message = "Configured validation.$configStage command is missing from $configPath."
            return 1
        }
        if (-not $config.validation.Contains($configStage)) {
            # Older project configs used `changed`; current templates call the
            # same targeted validation stage `targeted`.
            if ($Stage -eq 'changed' -and $config.validation.Contains('changed')) { $configStage = 'changed' }
            else {
                $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_command_missing'
                $receipt.exitCode = 2; $receipt.message = "Configured validation.$configStage command is missing from $configPath."
                return 1
            }
        }
        $stageConfig = $config.validation[$configStage]
        $command = ''
        $workingDirectory = '.'
        $prerequisites = @()
        $resultFormat = 'exit-code'
        if ($stageConfig -is [System.Collections.IDictionary]) {
            if ($stageConfig.Contains('command')) { $command = [string]$stageConfig.command }
            if ($stageConfig.Contains('workingDirectory') -and $stageConfig.workingDirectory) { $workingDirectory = [string]$stageConfig.workingDirectory }
            if ($stageConfig.Contains('resultFormat') -and $stageConfig.resultFormat) { $resultFormat = [string]$stageConfig.resultFormat }
            if ($stageConfig.Contains('timeoutSeconds')) {
                $timeout = [int]$stageConfig.timeoutSeconds
                if ($timeout -lt 1 -or $timeout -gt 7200) { throw "Configured validation.$Stage timeoutSeconds must be between 1 and 7200." }
                $receipt.timeoutSeconds = $timeout
            }
            if ($stageConfig.Contains('prerequisites')) { $prerequisites = @($stageConfig.prerequisites) }
            if ($stageConfig.Contains('evidencePath')) { $receipt.evidencePath = [string]$stageConfig.evidencePath }
        } else {
            $command = [string]$stageConfig
        }
        if ($resultFormat -notin 'json', 'exit-code') { throw "Configured validation.$Stage resultFormat must be json or exit-code." }
        $command = $command.Trim()
        if (-not $command) {
            $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_command_missing'
            $receipt.exitCode = 2; $receipt.message = "Configured validation.$Stage command is empty."
            return 1
        }
        if ($command -eq 'skip' -and $Stage -eq 'changed') {
            $receipt.status = 'skipped'; $receipt.reasonCode = 'targeted_validation_unsupported'; $receipt.exitCode = 0; $receipt.message = 'Targeted validation explicitly unsupported.'
            return 0
        }
        if ($command -eq 'skip') { throw "Required validation.$Stage cannot be skipped." }
        $receipt.command = $command
        $receipt.reasonCode = 'validation_completed'
        $workingPath = [IO.Path]::GetFullPath((Join-Path $root $workingDirectory))
        $rootPath = [IO.Path]::GetFullPath($root)
        $rootPrefix = $rootPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not [string]::Equals($workingPath, $rootPath, [StringComparison]::OrdinalIgnoreCase) -and
            -not $workingPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Configured validation.$Stage workingDirectory must stay inside the project worktree."
        }
        $receipt.workingDirectory = [IO.Path]::GetRelativePath($rootPath, $workingPath) -replace '\\', '/'
        if ($receipt.workingDirectory -eq '') { $receipt.workingDirectory = '.' }
        if (-not (Test-Path -LiteralPath $workingPath -PathType Container)) {
            $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_working_directory_missing'
            $receipt.exitCode = 2; $receipt.message = "Configured validation.$Stage workingDirectory does not exist: $($receipt.workingDirectory)"
            return 1
        }
        foreach ($prerequisite in $prerequisites) {
            if (-not (Get-Command ([string]$prerequisite) -ErrorAction SilentlyContinue)) {
                $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_prerequisite_missing'
                $receipt.exitCode = 2; $receipt.message = "Configured validation.$Stage prerequisite is unavailable: $prerequisite"
                return 1
            }
        }
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
        $start.WorkingDirectory = $workingPath
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.Environment['FACTORY_VALIDATION_ROOT'] = $root
        $start.Environment['FACTORY_VALIDATION_RESULT_FORMAT'] = $resultFormat
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
        if ($resultFormat -eq 'json') {
            $outputText = [Text.Encoding]::UTF8.GetString($stdout)
            $resultLine = @($outputText -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
            $result = $null
            $resultError = ''
            try {
                if ($resultLine.Count -eq 0) { throw 'No JSON result line was emitted.' }
                $result = $resultLine[0] | ConvertFrom-Json -ErrorAction Stop
                if (-not (Test-Json -Json ($result | ConvertTo-Json -Depth 10 -Compress) -SchemaFile (Join-Path $PSScriptRoot '../schemas/project-validation-result.schema.json') -ErrorAction Stop)) {
                    throw 'Result does not match project-validation-result/v1.'
                }
            } catch { $resultError = $_.Exception.Message }
            if ($resultError) {
                $receipt.status = 'error'; $receipt.reasonCode = 'validation_result_malformed'
                $receipt.exitCode = 1; $receipt.message = "Configured validation.$Stage emitted an invalid JSON result: $resultError"
            } else {
                $receipt.validationResult = $result
                if ($result.message) { $receipt.message = [string]$result.message }
                switch ([string]$result.status) {
                    'passed' {
                        if ($process.ExitCode -eq 0) {
                            $receipt.status = 'passed'; $receipt.reasonCode = 'validation_result_passed'
                        } else {
                            $receipt.status = 'error'; $receipt.reasonCode = 'validation_result_contradicts_exit_code'
                            $receipt.message = 'Structured result says passed while the command exited nonzero.'
                        }
                    }
                    'failed' {
                        $receipt.status = 'failed'; $receipt.reasonCode = 'validation_result_failed'
                        if ($receipt.exitCode -eq 0) { $receipt.exitCode = 1 }
                    }
                    'skipped' { $receipt.status = 'skipped'; $receipt.reasonCode = 'validation_result_skipped' }
                    'unavailable' { $receipt.status = 'unavailable'; $receipt.reasonCode = 'validation_result_unavailable'; $receipt.exitCode = 2 }
                    'no-matching-tests' { $receipt.status = 'no-matching-tests'; $receipt.reasonCode = 'validation_result_no_matching_tests'; $receipt.exitCode = 2 }
                }
            }
        } else {
            $receipt.status = if ($process.ExitCode -eq 0) { 'passed' } else { 'failed' }
            $receipt.reasonCode = if ($process.ExitCode -eq 0) { 'validation_passed' } else { 'validation_command_failed' }
        }
        if ($receipt.truncated) { $receipt.message = 'Output truncated to 64 KiB per stream.' }
    } catch {
        $receipt.status = 'error'; $receipt.exitCode = 1; $receipt.message = $_.Exception.Message
        $receipt.reasonCode = if ($receipt.message -match '^(Configured validation\.|Unsupported YAML indentation|Unexpected YAML list item|Unsupported factory\.config\.yaml syntax|Config not found:)') {
            'validation_config_invalid'
        } else { 'validation_infrastructure_error' }
    } finally {
        # A project runner can modify tracked files or create untracked files
        # after the initial snapshot. Keep the receipt clean only if both the
        # pre-run and post-run worktree are clean.
        $postRunStatus = @(& git -C $root status --porcelain 2>$null)
        $postRunStatusOk = ($LASTEXITCODE -eq 0)
        $postRunHead = @(& git -C $root rev-parse HEAD 2>$null)
        $headUnchanged = ($LASTEXITCODE -eq 0 -and $postRunHead.Count -gt 0 -and
            ([string]$postRunHead[0]).Trim() -eq $receipt.headSha)
        $receipt.worktreeClean = ($receipt.worktreeClean -and $postRunStatusOk -and
            $postRunStatus.Count -eq 0 -and $headUnchanged)
        if ($receipt.headSha -and -not $headUnchanged) {
            $receipt.status = 'error'; $receipt.exitCode = 1
            $receipt.reasonCode = 'validation_head_changed'
            $receipt.message = 'Project HEAD changed during validation.'
        }
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
$script:RuntimeScripts = @('validate-result.ps1', 'route-state.ps1', 'check-already-resolved.ps1', 'prepare-implementation.ps1', 'ensure-implementation-result.ps1', 'ensure-pr-closes-issue.ps1', 'factory-startup.ps1', 'sync-automations.ps1', 'watchdog-automations.ps1', 'create-labels.ps1', 'audit-backlog-labels.ps1', 'apply-backlog-label-audit.ps1', 'recover-audit-reservations.ps1', 'audit-factory-failures.ps1', 'refresh-stale-workable.ps1', 'maintain-repository.ps1', 'godot-upgrade.ps1', 'validate-automation-catalog.ps1', 'collect-backlog-snapshot.ps1', 'reconcile-backlog.ps1', 'lease.ps1', 'record-local-evaluation.ps1', 'evaluate-local-promotion.ps1', 'local/run-local-job.ps1', 'openhands/validate-job.ps1', 'hindsight/client.py', 'hindsight/recall.ps1', 'hindsight/retain.ps1')

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
    $backlogReconciliation = Get-FeatureOn $Config 'backlog_reconciliation'
    if ($backlogReconciliation -and $workflows -notcontains 'backlog-reconciliation') { $selected.Add('workflows/backlog-reconciliation.yaml') }
    if ($backlogReconciliation -and $skills -notcontains 'factory-work-backlog') { $selected.Add('skills/factory-work-backlog/SKILL.md') }
    # Automations: only those whose workflow is installed (maintenance only with the feature on).
    $allWorkflows = @($workflows) + $(if ($combinedMaintenance) { 'maintenance' }) + $(if ($godotUpgrade) { 'godot-upgrade' }) + $(if ($backlogReconciliation) { 'backlog-reconciliation' })
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
