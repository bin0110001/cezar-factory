#!/usr/bin/env pwsh
# Test full
# Run the broader project suite
# Produce summarized output
# Store full artifacts separately
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
$logFile = Join-Path $artifactsDir "test-full-$timestamp.log"
$resultFile = Join-Path $artifactsDir "test-full-results.json"
$summaryFile = Join-Path $artifactsDir "test-full-summary.txt"

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

$passedCount = 0
$failedCount = 0
$failedTests = @()
$testFiles = @()
$startTime = Get-Date

try {
    Write-Verbose "Starting full test suite execution..."

    # --- Step 1: Find test files in common locations ---
    $testDirs = @(
        "tests",
        "test",
        "Tests",
        "Test",
        "spec",
        "Spec",
        "__tests__"
    )

    foreach ($dir in $testDirs) {
        if (Test-Path $dir) {
            $dirTests = Get-ChildItem -Path $dir -Recurse -Include "*.ps1", "*.cs", "*.java", "*.go", "*.rs", "*.ts", "*.js" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^(test|run-tests)' -or $_.Name -match '\.Tests\.' -or $_.Extension -ne '.ps1' }
            $testFiles += $dirTests
        }
    }

    Write-Verbose "Found $($testFiles.Count) test files"

    # --- Step 2: Run each test file ---
    foreach ($testFile in $testFiles) {
        Write-Verbose "Running test: $($testFile.FullName)"
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()

            if ($testFile.Extension -eq '.ps1') {
                # Run PowerShell test with Pester if available
                if (Get-Command Invoke-Pester -ErrorAction SilentlyContinue) {
                    $pesterResult = Invoke-Pester -Path $testFile.FullName -PassThru -ErrorAction Stop
                    $sw.Stop()

                    if ($pesterResult.FailedCount -gt 0 -or $pesterResult.Failed -gt 0) {
                        $failedCount += $pesterResult.FailedCount
                        $failedTests += @{
                            test     = $testFile.Name
                            message  = "$($pesterResult.FailedCount) test(s) failed in $($pesterResult.Duration) seconds"
                            artifact = $logFile
                        }
                    } else {
                        $passedCount += $pesterResult.PassedCount
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
                # Non-PowerShell test files - attempt execution
                switch ($testFile.Extension) {
                    '.cs' {
                        # C# test - try dotnet test
                        $projPath = Get-ChildItem -Path (Split-Path $testFile.Parent) -Filter "*.csproj" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                        if ($projPath) {
                            & dotnet test $projPath.FullName --filter "FullyQualifiedName~$($testFile.BaseName)" *>> $logFile 2>&1
                        } else {
                            # Fallback to generic execution
                            & $testFile.FullName *>> $logFile 2>&1
                        }
                    }
                    default {
                        & $testFile.FullName *>> $logFile 2>&1
                    }
                }
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

    $totalTests = $passedCount + $failedCount
    $duration = (Get-Date) - $startTime

    # --- Step 3: Output results ---
    $status = if ($failedCount -gt 0) { "failed" } else { "passed" }
    Write-Result -Status $status -Stage "test" -Passed $passedCount -Failed $failedCount -Total $totalTests -Failures $failedTests

    if (-not $Quiet) {
        Write-Host "Full test suite completed:"
        Write-Host "  Status:   $status"
        Write-Host "  Duration: $([math]::Round($duration.TotalSeconds, 2))s"
        Write-Host "  Total:    $totalTests"
        Write-Host "  Passed:   $passedCount"
        Write-Host "  Failed:   $failedCount"
        Write-Host "  Logs:     $logFile"
        Write-Host "  Results:  $resultFile"
    }

    # Write human-readable summary
    $summary = @"
Full Test Suite Results
======================
Status:     $status
Duration:   $([math]::Round($duration.TotalSeconds, 2))s
Total Tests:$totalTests
Passed:     $passedCount
Failed:     $failedCount

Log file:   $logFile
Result file:$resultFile
"@
    $summary | Set-Content -Path $summaryFile -Encoding utf8
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
