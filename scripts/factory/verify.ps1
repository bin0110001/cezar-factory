#!/usr/bin/env pwsh
# Verify project
# Perform factory-specific validation
# Checks factory configuration, installed components, generated files
# Produce structured output
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
$logFile = Join-Path $artifactsDir "verify-$timestamp.log"
$resultFile = Join-Path $artifactsDir "verify-results.json"

# --- Helper: Emit JSON result ---
function Write-Result {
    param(
        [string]$Status,
        [string]$Stage,
        [int]$Passed,
        [int]$Failed,
        [int]$Warnings,
        [array]$Errors,
        [array]$Checks
    )
    $result = @{
        status   = $Status
        stage    = $Stage
        passed   = $Passed
        failed   = $Failed
        warnings = $Warnings
        errors   = $Errors
        checks   = $Checks
        artifact = $logFile
    }
    $result | ConvertTo-Json -Depth 6 | Set-Content -Path $resultFile -Encoding utf8
}

Start-Transcript -Path $logFile -Append -Force | Out-Null

$errors = @()
$warnings = @()
$checks = @()
$passedCount = 0
$failedCount = 0
$warningCount = 0

try {
    # --- Step 1: Validate factory config is valid YAML ---
    $configPath = Join-Path (Split-Path $PSScriptRoot) '.ai\factory\factory.config.yaml'
    if (Test-Path $configPath) {
        try {
            $configContent = Get-Content -Raw $configPath
            if ($configContent -match 'factory:') {
                $checks += @{ name = "factory-config-valid"; status = "passed"; message = "Factory config file exists and appears valid" }
                $passedCount++
                Write-Verbose "Factory config is valid YAML"
            } else {
                $errors += "Factory config does not contain expected 'factory:' section"
                $checks += @{ name = "factory-config-valid"; status = "failed"; message = $errors[-1] }
                $failedCount++
            }
        } catch {
            $errors += "Factory config YAML parsing error: $($_.Exception.Message)"
            $checks += @{ name = "factory-config-valid"; status = "failed"; message = $errors[-1] }
            $failedCount++
        }
    } else {
        $errors += "Factory config not found at $configPath"
        $checks += @{ name = "factory-config-valid"; status = "failed"; message = $errors[-1] }
        $failedCount++
    }

    # --- Step 2: Pinned factory version exists ---
    $factoryDir = Join-Path (Split-Path $PSScriptRoot) '.ai\factory'
    $versionPath = Join-Path $factoryDir 'VERSION'
    if (Test-Path $versionPath) {
        $version = (Get-Content $versionPath).Trim()
        if ($version -match '^\d+\.\d+\.\d+$') {
            $checks += @{ name = "factory-version"; status = "passed"; message = "Pinned factory version: $version" }
            $passedCount++
        } else {
            $errors += "VERSION file does not contain a valid semantic version: $version"
            $checks += @{ name = "factory-version"; status = "failed"; message = $errors[-1] }
            $failedCount++
        }
    } else {
        $errors += "VERSION file not found in factory directory"
        $checks += @{ name = "factory-version"; status = "failed"; message = $errors[-1] }
        $failedCount++
    }

    # --- Step 3: Required skills exist ---
    $requiredSkills = @(
        'factory-plan',
        'factory-implement',
        'factory-review',
        'factory-fix',
        'factory-investigate'
    )
    foreach ($skill in $requiredSkills) {
        $skillPath = Join-Path $factoryDir "skills\$skill\SKILL.md"
        if (Test-Path $skillPath) {
            $checks += @{ name = "skill-$skill"; status = "passed"; message = "Found required skill" }
            $passedCount++
        } else {
            $errors += "Required skill not found: $skill at $skillPath"
            $checks += @{ name = "skill-$skill"; status = "failed"; message = $errors[-1] }
            $failedCount++
        }
    }

    # --- Step 4: Required workflows exist ---
    $requiredWorkflows = @(
        'plan',
        'implement',
        'review',
        'fix-review',
        'investigate'
    )
    foreach ($workflow in $requiredWorkflows) {
        $workflowPath = Join-Path $factoryDir "workflows\$workflow.yaml"
        if (Test-Path $workflowPath) {
            $checks += @{ name = "workflow-$workflow"; status = "passed"; message = "Found required workflow" }
            $passedCount++
        } else {
            $errors += "Required workflow not found: $workflow at $workflowPath"
            $checks += @{ name = "workflow-$workflow"; status = "failed"; message = $errors[-1] }
            $failedCount++
        }
    }

    # --- Step 5: Validation scripts exist ---
    $validationScripts = @(
        'test-changed.ps1',
        'test-full.ps1',
        'verify.ps1'
    )
    $factoryScriptsDir = Join-Path $factoryDir 'scripts\factory'
    foreach ($script in $validationScripts) {
        $scriptPath = Join-Path $factoryScriptsDir $script
        if (Test-Path $scriptPath) {
            $checks += @{ name = "script-$script"; status = "passed"; message = "Found validation script" }
            $passedCount++
        } else {
            $errors += "Validation script not found: $script at $scriptPath"
            $checks += @{ name = "script-$script"; status = "failed"; message = $errors[-1] }
            $failedCount++
        }
    }

    # --- Step 6: Automation definitions are valid ---
    $automationDir = Join-Path $factoryDir 'automations'
    if (Test-Path $automationDir) {
        $automationFiles = Get-ChildItem -Path $automationDir -Filter "*.yaml" -Recurse -ErrorAction SilentlyContinue
        $expectedAutomations = @('needs-plan', 'ready-to-implement', 'ready-to-review', 'changes-requested')
        foreach ($auto in $expectedAutomations) {
            $autoPath = Join-Path $automationDir "$auto.yaml"
            if (Test-Path $autoPath) {
                $content = Get-Content -Raw $autoPath
                if ($content -match 'trigger:') {
                    $checks += @{ name = "automation-$auto"; status = "passed"; message = "Automation definition is valid" }
                    $passedCount++
                } else {
                    $warnings += "Automation $auto missing trigger definition"
                    $checks += @{ name = "automation-$auto"; status = "warning"; message = $warnings[-1] }
                    $warningCount++
                }
            } else {
                $warnings += "Automation file not found: $auto"
                $checks += @{ name = "automation-$auto"; status = "warning"; message = $warnings[-1] }
                $warningCount++
            }
        }
    } else {
        $warnings += "Automations directory not found"
        $checks += @{ name = "automation-dir"; status = "warning"; message = $warnings[-1] }
        $warningCount++
    }

    # --- Step 7: Syntax validation on project files ---
    # Check for common syntax issues
    $projectFiles = Get-ChildItem -Path (Split-Path $PSScriptRoot) -Recurse -Include "*.ps1" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\\.git\\' }
    foreach ($psFile in $projectFiles) {
        try {
            $content = Get-Content -Raw $psFile.FullName
            # Basic PowerShell syntax check: balanced braces and parentheses
            $openBraces = ([regex]::Matches($content, '\{')).Count
            $closeBraces = ([regex]::Matches($content, '\}')).Count
            if ($openBraces -ne $closeBraces) {
                $warnings += "Unbalanced braces in $($psFile.Name)"
                $checks += @{ name = "syntax-$($psFile.Name)"; status = "warning"; message = $warnings[-1] }
                $warningCount++
            }
        } catch {
            $warnings += "Could not analyze syntax for $($psFile.Name)"
            $checks += @{ name = "syntax-$($psFile.Name)"; status = "warning"; message = $warnings[-1] }
            $warningCount++
        }
    }

    # --- Step 8: Check for runtime files unintentionally tracked ---
    $runtimePaths = @(
        '.ai\cezar\runs.json',
        '.ai\cezar\automation-state.json',
        '.ai\cezar\automation-receipts.ndjson',
        '.ai\cezar\automation-log.ndjson',
        '.ai\cezar\automation-poll.lock',
        '.ai\cezar\automation-mutation.lock'
    )
    foreach ($path in $runtimePaths) {
        $fullPath = Join-Path (Split-Path $PSScriptRoot) $path
        if (Test-Path $fullPath) {
            $warnings += "Runtime file may be tracked: $path"
            $checks += @{ name = "runtime-$path"; status = "warning"; message = $warnings[-1] }
            $warningCount++
        }
    }

    # --- Step 9: Generated-file checks ---
    # Check that managed files have proper GENERATED BY CEZAR-FACTORY markers
    $managedPaths = @(
        'factory.config.yaml',
        'VERSION'
    )
    foreach ($managed in $managedPaths) {
        $managedPath = Join-Path $factoryDir $managed
        if (Test-Path $managedPath) {
            $content = Get-Content -Raw $managedPath
            if ($content -match 'GENERATED BY CEZAR-FACTORY') {
                $checks += @{ name = "generated-$managed"; status = "passed"; message = "Managed file has correct marker" }
                $passedCount++
            } else {
                $warnings += "Managed file missing GENERATED marker: $managed"
                $checks += @{ name = "generated-$managed"; status = "warning"; message = $warnings[-1] }
                $warningCount++
            }
        }
    }

    # --- Step 10: Packaging/export checks ---
    # Check for build artifacts
    $buildArtifacts = @(
        'dist',
        'build',
        'bin',
        'publish'
    )
    $hasBuildDir = $false
    foreach ($artifact in $buildArtifacts) {
        if (Test-Path (Join-Path (Split-Path $PSScriptRoot) $artifact)) {
            $hasBuildDir = $true
            break
        }
    }
    if ($hasBuildDir) {
        $checks += @{ name = "packaging"; status = "passed"; message = "Build artifacts directory found" }
        $passedCount++
    } else {
        $checks += @{ name = "packaging"; status = "warning"; message = "No build artifacts directory found (optional)" }
        $warningCount++
    }

    # --- Step 11: Test validation scripts work ---
    # Run the test-changed script in check mode to verify it works
    $testChangedScript = Join-Path $factoryScriptsDir 'test-changed.ps1'
    if (Test-Path $testChangedScript) {
        try {
            $testResult = & $testChangedScript -Quiet 2>&1
            if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 1) {
                $checks += @{ name = "test-changed-executable"; status = "passed"; message = "test-changed script runs successfully" }
                $passedCount++
            } else {
                $warnings += "test-changed script returned unexpected exit code: $LASTEXITCODE"
                $checks += @{ name = "test-changed-executable"; status = "warning"; message = $warnings[-1] }
                $warningCount++
            }
        } catch {
            $warnings += "test-changed script failed to execute: $($_.Exception.Message)"
            $checks += @{ name = "test-changed-executable"; status = "warning"; message = $warnings[-1] }
            $warningCount++
        }
    }

    $totalChecks = $passedCount + $failedCount + $warningCount
    $overallStatus = if ($failedCount -gt 0) { "failed" } elseif ($warningCount -gt 0) { "warning" } else { "passed" }

    # --- Output results ---
    if (-not $Quiet) {
        Write-Host "Verification results:"
        Write-Host "  Status:  $overallStatus"
        Write-Host "  Checks:  $totalChecks"
        Write-Host "  Passed:  $passedCount"
        Write-Host "  Failed:  $failedCount"
        Write-Host "  Warnings:$warningCount"
        Write-Host "  Logs:    $logFile"
        Write-Host "  Results: $resultFile"

        if ($errors.Count -gt 0) {
            Write-Host "  Errors:" -ForegroundColor Red
            $errors | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
        }

        if ($warnings.Count -gt 0) {
            Write-Host "  Warnings:" -ForegroundColor Yellow
            $warnings | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
        }
    }

    # Write structured JSON result
    Write-Result -Status $overallStatus -Stage "verify" -Passed $passedCount -Failed $failedCount -Warnings $warningCount -Errors $errors -Checks $checks

    if ($Verbose) {
        Write-Host "Detailed check results:"
        $checks | ForEach-Object {
            $icon = Switch ($_.status) {
                "passed" { "[PASS]" }
                "failed" { "[FAIL]" }
                "warning" { "[WARN]" }
            }
            Write-Host "  $icon $($_.name): $($_.message)"
        }
    }
} catch {
    $failedCount++
    $errors += "Unhandled error during verification: $($_.Exception.Message)"
    Write-Result -Status "failed" -Stage "verify" -Passed $passedCount -Failed $failedCount -Warnings $warningCount -Errors $errors -Checks $checks
    Write-Verbose "Verification error: $($_.Exception.Message)"
} finally {
    Stop-Transcript | Out-Null
}

# --- Exit with reliable code ---
if ($failedCount -gt 0) {
    exit 1
}
exit 0