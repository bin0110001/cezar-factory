#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('quick', 'targeted', 'full')][string]$Level,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Get-Location).Path).Path
$configPath = Join-Path $projectRoot '.ai/factory/factory.config.yaml'
$defaultEvidence = Join-Path $projectRoot ".factory/artifacts/verification-$Level.json"

function Write-Outcome([string]$Status, [string]$Reason, [hashtable]$Extra = @{}) {
    $result = [ordered]@{
        status = $Status
        level = $Level
        reason = $Reason
        project = $projectRoot
        command = $contract.command
        durationSeconds = $durationSeconds
        evidence = $evidencePath
    }
    foreach ($key in $Extra.Keys) { $result[$key] = $Extra[$key] }
    $evidenceDirectory = Split-Path -Parent $evidencePath
    if ($evidenceDirectory) { New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null }
    $json = $result | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $evidencePath -Value $json -Encoding utf8
    if (-not $Quiet) { Write-Output $json }
}

function Read-ProjectContract([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ error = 'project_config_missing' } }
    $validation = @{}
    $projectType = ''
    $section = ''
    $currentLevel = ''
    $currentField = ''
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*(#.*)?$') { continue }
        if ($line -match '^(\w+):\s*(.*?)\s*$') {
            $section = $Matches[1]
            $currentLevel = ''
            $currentField = ''
            if ($section -eq 'validation' -or $section -eq 'project') { continue }
            $section = ''
            continue
        }
        if ($section -eq 'project' -and $line -match '^\s{2}type:\s*(.*?)\s*$') {
            $projectType = $Matches[1].Trim().Trim('"').Trim("'")
            continue
        }
        if ($section -ne 'validation') { continue }
        if ($line -match '^\s{2}(quick|targeted|full):\s*(.*?)\s*$') {
            $currentLevel = $Matches[1]
            $validation[$currentLevel] = @{}
            $currentField = ''
            continue
        }
        if ($line -match '^\s{4}(\w+):\s*(.*?)\s*$' -and $currentLevel) {
            $currentField = $Matches[1]
            $value = $Matches[2].Trim().Trim('"').Trim("'")
            $validation[$currentLevel][$currentField] = if ($value -eq '[]' -or -not $value) { @() } else { $value }
            continue
        }
        if ($line -match '^\s{6}-\s*(.*?)\s*$' -and $currentLevel -and $currentField) {
            $items = @($validation[$currentLevel][$currentField])
            $items += $Matches[1].Trim().Trim('"').Trim("'")
            $validation[$currentLevel][$currentField] = $items
            continue
        }
        if ($line -match '^\s{4}\S') { return @{ error = 'verification_contract_invalid' } }
    }
    @{ validation = $validation; projectType = $projectType }
}

function Resolve-ProjectPath([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Path))
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        -not $full.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'configured path escapes the project root'
    }
    $full
}

function Protect-Diagnostic([string]$Value) {
    $safe = $Value -replace '(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+', '$1=[redacted]'
    $safe = $safe -replace '(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*', 'Bearer [redacted]'
    $safe = $safe -replace '\bgh[pousr]_[A-Za-z0-9_]{20,}\b', '[redacted-github-token]'
    if ($safe.Length -gt 50000) { $safe = $safe.Substring($safe.Length - 50000) }
    $safe
}

$contract = @{ command = ''; workingDirectory = '.'; prerequisites = @(); timeoutSeconds = 0; evidencePath = ''; appliesTo = @('*') }
$evidencePath = $defaultEvidence
$durationSeconds = 0.0
$parsed = Read-ProjectContract $configPath
if ($parsed.error) {
    Write-Outcome 'unavailable' $parsed.error @{ message = 'A project factory.config.yaml with an explicit verification contract is required.' }
    exit 4
}
$projectLevel = $parsed.validation[$Level]
if (-not $projectLevel) {
    Write-Outcome 'unavailable' 'verification_level_not_configured' @{ message = "validation.$Level is not configured." }
    exit 4
}
$contract = $projectLevel
if (-not $contract.command -or $contract.command -is [array] -or [string]::IsNullOrWhiteSpace([string]$contract.command)) {
    Write-Outcome 'unavailable' 'verification_command_missing' @{ message = "validation.$Level.command must name a project-supported command." }
    exit 4
}
if (-not $contract.timeoutSeconds -or [int]$contract.timeoutSeconds -lt 1) {
    Write-Outcome 'unavailable' 'verification_timeout_missing' @{ message = "validation.$Level.timeoutSeconds must be a positive integer." }
    exit 2
}
if ($contract.resultFormat -ne 'json') {
    Write-Outcome 'unavailable' 'verification_result_format_missing' @{ message = "validation.$Level.resultFormat must be 'json'." }
    exit 2
}
if ($contract.appliesTo -and @($contract.appliesTo) -notcontains '*' -and @($contract.appliesTo) -notcontains [string]$parsed.projectType) {
    Write-Outcome 'skipped' 'project_not_applicable' @{
        projectType = $parsed.projectType
        appliesTo = @($contract.appliesTo)
        '$cezar' = @{ action = 'skip_step'; reasonCode = 'precondition_not_met' }
    }
    exit 0
}
if ($contract.evidencePath -and $contract.evidencePath -is [string]) {
    try { $evidencePath = Resolve-ProjectPath ([string]$contract.evidencePath) $projectRoot }
    catch { Write-Outcome 'unavailable' 'evidence_path_invalid' @{ message = $_.Exception.Message }; exit 2 }
}
try { $workingDirectory = Resolve-ProjectPath ([string]$contract.workingDirectory) $projectRoot }
catch { Write-Outcome 'unavailable' 'working_directory_invalid' @{ message = $_.Exception.Message }; exit 2 }
if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
    Write-Outcome 'unavailable' 'working_directory_missing' @{ message = "Configured working directory does not exist: $($contract.workingDirectory)" }
    exit 2
}
foreach ($requiredCommand in @($contract.prerequisites)) {
    if ([string]::IsNullOrWhiteSpace([string]$requiredCommand)) { continue }
    if (-not (Get-Command ([string]$requiredCommand) -ErrorAction SilentlyContinue)) {
        Write-Outcome 'unavailable' 'prerequisite_missing' @{ missingPrerequisite = [string]$requiredCommand }
        exit 4
    }
}

$logPath = [IO.Path]::ChangeExtension($evidencePath, '.log')
$logDirectory = Split-Path -Parent $logPath
if ($logDirectory) { New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null }
$runner = (Get-Command pwsh -ErrorAction Stop).Source
$process = [Diagnostics.Process]::new()
$process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
$process.StartInfo.FileName = $runner
$process.StartInfo.WorkingDirectory = $workingDirectory
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
$process.StartInfo.ArgumentList.Add('-NoProfile')
$process.StartInfo.ArgumentList.Add('-Command')
$process.StartInfo.ArgumentList.Add([string]$contract.command)
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
    if (-not $process.Start()) { throw 'Could not start the configured verification command.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit(([int]$contract.timeoutSeconds) * 1000)
    if (-not $completed) {
        try { $process.Kill($true) } catch { }
        try { $process.WaitForExit() } catch { }
        $timer.Stop(); $durationSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
        $timedOutOutput = Protect-Diagnostic ($stdoutTask.GetAwaiter().GetResult() + "`n" + $stderrTask.GetAwaiter().GetResult())
        Set-Content -LiteralPath $logPath -Value $timedOutOutput -Encoding utf8
        Write-Outcome 'failed' 'verification_timeout' @{ category = 'timeout'; timeoutSeconds = [int]$contract.timeoutSeconds; log = $logPath }
        exit 3
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $timer.Stop(); $durationSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
    $output = Protect-Diagnostic (($stdout + "`n" + $stderr).Trim())
    Set-Content -LiteralPath $logPath -Value $output -Encoding utf8
    try { $projectResult = $stdout.Trim() | ConvertFrom-Json -ErrorAction Stop }
    catch { Write-Outcome 'failed' 'verification_result_malformed' @{ category = 'malformed_result'; log = $logPath; exitCode = 9 }; exit 9 }
    $validStatuses = @('passed', 'failed', 'skipped', 'unavailable', 'no_matching_tests')
    if (-not $projectResult.status -or $validStatuses -notcontains [string]$projectResult.status -or [string]$projectResult.reason -notmatch '^[a-z][a-z0-9_]*$' -or
        ([string]$projectResult.status -eq 'failed' -and -not $projectResult.category)) {
        Write-Outcome 'failed' 'verification_result_malformed' @{ category = 'malformed_result'; log = $logPath; exitCode = 9 }
        exit 9
    }
    $projectStatus = [string]$projectResult.status
    $projectCategory = if ($projectResult.category) { [string]$projectResult.category } else { 'configuration' }
    $categoryExit = @{
        work_verdict = 1; test_regression = 1; configuration = 2; timeout = 3;
        missing_command = 4; authentication = 5; provider_unavailable = 6; provider_quota = 6;
        transient_transport = 7; cancelled = 8; malformed_result = 9; unknown = 10
    }
    if ($projectStatus -eq 'passed') {
        if ($process.ExitCode -ne 0) {
            Write-Outcome 'failed' 'verification_result_conflicts_with_exit_code' @{ category = 'malformed_result'; log = $logPath; exitCode = 9 }
            exit 9
        }
        Write-Outcome 'passed' ([string]$projectResult.reason) @{ projectEvidence = $projectResult.evidence; exitCode = 0; log = $logPath }
        exit 0
    }
    if ($projectStatus -eq 'skipped') {
        Write-Outcome 'skipped' ([string]$projectResult.reason) @{
            category = 'configuration'
            projectReason = [string]$projectResult.reason
            projectEvidence = $projectResult.evidence
            '$cezar' = @{ action = 'skip_step'; reasonCode = 'precondition_not_met' }
            log = $logPath
        }
        exit 0
    }
    if ($projectStatus -eq 'no_matching_tests') { $projectCategory = 'configuration' }
    if ($projectStatus -eq 'unavailable' -and $projectCategory -eq 'configuration') { $projectCategory = 'missing_command' }
    if (-not $categoryExit.ContainsKey($projectCategory)) {
        Write-Outcome 'failed' 'verification_result_category_invalid' @{ category = 'malformed_result'; log = $logPath; exitCode = 9 }
        exit 9
    }
    $normalizedExit = [int]$categoryExit[$projectCategory]
    Write-Outcome $projectStatus ([string]$projectResult.reason) @{
        category = $projectCategory
        projectReason = [string]$projectResult.reason
        projectEvidence = $projectResult.evidence
        exitCode = $normalizedExit
        log = $logPath
        outputSummary = $output.Substring([Math]::Max(0, $output.Length - 4000))
    }
    exit $normalizedExit
} catch {
    $timer.Stop(); $durationSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
    Write-Outcome 'unavailable' 'verification_runner_error' @{ message = $_.Exception.Message }
    exit 2
} finally {
    $process.Dispose()
}
