#!/usr/bin/env pwsh
# Test changed files
# Run tests most relevant to changed files
# Produce compact output
# Store verbose logs separately
# Return reliable exit code

param(
    [switch]$Verbose,
    [switch]$Quiet
)

$VerbosePreference = if ($Verbose) { 'Continue' } else { 'SilentlyContinue' }
$DebugPreference = 'SilentlyContinue'

# --- Setup artifact directories ---
$artifactsDir = Join-Path (Split-Path $PSScriptRoot) 'artifacts'
if (-not (Test-Path $artifactsDir)) {
    New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null
}

$timestamp = (Get-Date -Format "yyyyMMdd-HHmmss")
$logFile = Join-Path $artifactsDir "test-changed-$timestamp.log"
$resultFile = Join-Path $artifactsDir "test-changed-results.json"

# --- Helper: Emit JSON result and write to file ---
function Write-Result {
    param(
        [string]$Status,
        [string]$Stage,
        [int]$Passed,
        [int]$Failed,
        [int]$Total,
        [array]$Failures,
        [string]$Message = ""
    )
    $result = @{
        status   = $Status
        stage    = $Stage
        passed   = $Passed
        failed   = $Failed
        total    = $Total
        failures = $Failures
        message  = $Message
        artifact = $logFile
    }
    $result | ConvertTo-Json -Depth 6 | Set-Content -Path $resultFile -Encoding utf8
}

Start-Transcript -Path $logFile -Append -Force | Out-Null

$changedFiles = @()
$passedCount = 0
$failedCount = 0
$failedTests = @()

try {
    # --- Step 1: Determine changed files ---
    if (Test-Path .git) {
        try {
            $gitOutput = git diff --name-only HEAD@{1} HEAD 2>&1
            if ($LASTEXITCODE -eq 0 -and $gitOutput) {
                $changedFiles = $gitOutput -split "`n" | Where-Object { $_ -and $_.Trim() -ne '' }
                Write-Verbose "Changed files from git diff: $($changedFiles.Count)"
            } else {
                # Fallback: git status
                $gitStatus = git status --porcelain 2>&1
                if ($LASTEXITCODE -eq 0) {
                    $changedFiles = $gitStatus -split "`n" |
                        Where-Object { $_ -and $_.Trim() -ne '' } |
                        ForEach-Object { ($_ -split '\s+')[-1] }
                    Write-Verbose "Changed files from git status: $($changedFiles.Count)"
                }
            }
        } catch {
            Write-Verbose "Git detection error: $($_.Exception.Message)"
        }
    }

    if ($changedFiles.Count -eq 0) {
        Write-Verbose "No changed files detected, scanning for test files"
        $changedFiles = Get-ChildItem -Path "tests" -Include "*.ps1" -Recurse -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName
    }

    # --- Step 2: Run relevant tests ---
    foreach ($changedFile in $changedFiles) {
        if ([IO.Path]::GetFileName($changedFile) -eq 'test-changed.ps1') { continue }
        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($changedFile)
        $testCandidates = @()

        # Look for matching test files in common locations
        $testDirs = @(
            "tests",
            "test",
            "Tests",
            "Test"
        )

        foreach ($dir in $testDirs) {
            if (Test-Path $dir) {
                $candidates = Get-ChildItem -Path $dir -Recurse -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.Name -match "$fileName" -and
                            $_.FullName -ne (Resolve-Path $changedFile -ErrorAction SilentlyContinue).Path -and
                            ($_.Name -match '^(test|run-tests)' -or $_.Name -match '\.Tests\.' ) -and
                        ($_.Extension -in @('.ps1', '.cs', '.java', '.go', '.rs', '.ts', '.js'))
                    }
                $testCandidates += $candidates
            }
        }

        if ($testCandidates.Count -gt 0) {
            foreach ($testFile in $testCandidates) {
                Write-Verbose "Running test: $($testFile.FullName)"
                try {
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()

                    if ($testFile.Extension -eq '.ps1') {
                        # Run PowerShell test with Pester if available
                        if (Get-Command Invoke-Pester -ErrorAction SilentlyContinue) {
                            $pesterResult = Invoke-Pester -Path $testFile.FullName -PassThru -ErrorAction Stop
                            $sw.Stop()

                            if ($pesterResult.FailedCount -gt 0 -or $pesterResult.Failed -gt 0) {
                                $failedCount++
                                $failedTests += @{
                                    test     = $testFile.Name
                                    message  = "$($pesterResult.FailedCount) test(s) failed"
                                    artifact = $logFile
                                }
                            } else {
                                $passedCount++
                            }
                        } else {
                            # Execute the file directly as a basic check
                            & $testFile.FullName *>> $logFile
                            $sw.Stop()
                            if ($LASTEXITCODE -ne 0) {
                                $failedCount++
                                $failedTests += @{
                                    test     = $testFile.Name
                                    message  = "Test exited with code $LASTEXITCODE"
                                    artifact = $logFile
                                }
                            } else {
                                $passedCount++
                            }
                        }
                    } else {
                        # Non-PowerShell test files - execute if possible
                        & $testFile.FullName *>> $logFile 2>&1
                        $sw.Stop()
                        if ($LASTEXITCODE -ne 0) {
                            $failedCount++
                            $failedTests += @{
                                test     = $testFile.Name
                                message  = "Test exited with code $LASTEXITCODE"
                                artifact = $logFile
                            }
                        } else {
                            $passedCount++
                        }
                    }
                } catch {
                    $failedCount++
                    $failedTests += @{
                        test     = $testFile.Name
                        message  = $_.Exception.Message
                        artifact = $logFile
                    }
                }
            }
        }
    }

    $totalTests = $passedCount + $failedCount

    if ($totalTests -gt 0) {
        $status = if ($failedCount -gt 0) { "failed" } else { "passed" }
        Write-Result -Status $status -Stage "test" -Passed $passedCount -Failed $failedCount -Total $totalTests -Failures $failedTests

        if (-not $Quiet) {
            $summary = @{
                status   = $status
                stage    = "test"
                passed   = $passedCount
                failed   = $failedCount
                total    = $totalTests
                failures = $failedTests
            }
            $summary | ConvertTo-Json -Depth 6 | Write-Host
        }
    } else {
        Write-Result -Status "skipped" -Stage "test" -Passed 0 -Failed 0 -Total 0 -Failures @() -Message "No test files found for changed files"
        if (-not $Quiet) {
            Write-Host "No test files found for changed files."
        }
    }
} catch {
    Write-Result -Status "failed" -Stage "test" -Passed $passedCount -Failed $failedCount -Total ($passedCount + $failedCount) -Failures $failedTests -Message $_.Exception.Message
    Write-Verbose "Unhandled error: $($_.Exception.Message)"
} finally {
    Stop-Transcript | Out-Null
}

# --- Exit with reliable code ---
if ($failedCount -gt 0) {
    exit 1
}
exit 0
