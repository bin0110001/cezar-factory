#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $factory 'scripts/lib.ps1')
$peer = $null
$project = Join-Path ([IO.Path]::GetTempPath()) "factory validation $([guid]::NewGuid().ToString('N').Substring(0, 8))"
$failures = 0
function Check([string]$name, [bool]$condition) {
    if ($condition) { Write-Host "  ok   $name" }
    else { Write-Host "  FAIL $name"; $script:failures++ }
}
function Receipt([string]$stage) {
    Get-ChildItem (Join-Path $project ".factory/artifacts/validation/$stage") -Filter receipt.json -Recurse |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
        ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json }
}
function Run-Stage([string]$stage) {
    $file = @{ changed = 'test-changed.ps1'; full = 'test-full.ps1'; verify = 'verify.ps1' }[$stage]
    Push-Location $project
    try {
        $output = & pwsh -NoProfile -File (Join-Path $factory "scripts/factory/$file") -Task 7 2>&1 | Out-String
        $record = try { $output.Trim() | ConvertFrom-Json } catch { $null }
        [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output; Receipt = $record }
    } finally { Pop-Location }
}
Check 'diagnostic fingerprints ignore project roots, line numbers, and case' (
    (Get-ValidationDiagnosticFingerprint 'C:\work\game\Scripts\Player.gd:21:4: Invalid call' 'C:\work\game') -eq
    (Get-ValidationDiagnosticFingerprint 'D:\other\game\scripts\player.gd:99:2: INVALID CALL' 'D:\other\game'))
$exitCases = @(
    @{ Name = 'test regression'; Status = 'failed'; Reason = 'test_regression'; Code = 1 },
    @{ Name = 'configuration failure'; Status = 'unavailable'; Reason = 'validation_config_missing'; Code = 10 },
    @{ Name = 'missing tool'; Status = 'unavailable'; Reason = 'tool_missing'; Code = 11 },
    @{ Name = 'authentication failure'; Status = 'unavailable'; Reason = 'authentication_failed'; Code = 12 },
    @{ Name = 'provider unavailable'; Status = 'unavailable'; Reason = 'provider_unavailable'; Code = 13 },
    @{ Name = 'provider quota'; Status = 'unavailable'; Reason = 'provider_quota'; Code = 14 },
    @{ Name = 'transient transport'; Status = 'error'; Reason = 'transient_transport'; Code = 15 },
    @{ Name = 'timeout'; Status = 'error'; Reason = 'validation_timeout'; Code = 16 },
    @{ Name = 'malformed result'; Status = 'error'; Reason = 'validation_result_malformed'; Code = 17 },
    @{ Name = 'unknown failure'; Status = 'failed'; Reason = 'unknown_test_failure'; Code = 18 }
)
foreach ($case in $exitCases) {
    $receipt = [pscustomobject]@{ status = $case.Status; reasonCode = $case.Reason; validationResult = $null }
    if ($case.Status -eq 'failed' -and $case.Reason -eq 'test_regression') {
        $receipt.validationResult = [pscustomobject]@{ status = 'failed'; reasonCode = $case.Reason }
    }
    Check "validation exit code classifies $($case.Name)" ((Get-FactoryValidationExitCode $receipt 'full') -eq $case.Code)
}
$legacyFailure = [pscustomobject]@{ status = 'failed'; reasonCode = 'validation_command_failed'; validationResult = $null }
Check 'legacy exit-code failure is unknown and non-retryable' ((Get-FactoryValidationExitCode $legacyFailure 'full') -eq 18)
try {
    New-Item -ItemType Directory -Path (Join-Path $project '.ai/factory') -Force | Out-Null
    Set-Content (Join-Path $project '.gitignore') ".factory/"
    Set-Content (Join-Path $project 'runner.ps1') @'
param([string]$Stage)
Add-Content .factory/counter.txt $Stage
if ($env:ADAPTER_HUGE) { Write-Output ('x' * 120000) }
if ($env:ADAPTER_FAILURE_LOG) { [Console]::Error.WriteLine($env:ADAPTER_FAILURE_LOG) }
if ($env:ADAPTER_SLEEP) { Start-Sleep -Seconds ([int]$env:ADAPTER_SLEEP) }
if ($env:ADAPTER_DIRTY) { Set-Content ./adapter-output.tmp dirty }
if ($env:ADAPTER_EXPECT_CHANGED_FILE) {
    $changedFiles = @((ConvertFrom-Json -InputObject $env:FACTORY_VALIDATION_CHANGED_FILES))
    if ($env:FACTORY_VALIDATION_CHANGED_FILES_KNOWN -ne 'True' -or $changedFiles -notcontains $env:ADAPTER_EXPECT_CHANGED_FILE) { Write-Error 'Changed-file evidence was not passed to the project verifier.'; exit 9 }
}
if ($env:ADAPTER_COMMIT) {
    Set-Content ./adapter-commit.txt changed
    & git add -- adapter-commit.txt
    & git commit -qm runner-change
}
if ($env:ADAPTER_RESULT_FILE) {
    $fixtureResult = Get-Content -Raw $env:ADAPTER_RESULT_FILE | ConvertFrom-Json
    Write-Output ($fixtureResult | ConvertTo-Json -Compress)
    exit 0
}
$status = if ($env:ADAPTER_RESULT_STATUS) { $env:ADAPTER_RESULT_STATUS } else { 'passed' }
if ($env:ADAPTER_EXIT -and [int]$env:ADAPTER_EXIT -ne 0) { $status = 'failed' }
if ($env:ADAPTER_MALFORMED) { Write-Output 'not-json'; exit 0 }
$reason = @{ passed = 'tests_passed'; failed = 'test_failure'; skipped = 'not_applicable'; unavailable = 'tool_missing'; 'no-matching-tests' = 'no_matching_tests' }[$status]
$result = [ordered]@{ schemaVersion = 1; status = $status; reasonCode = $reason; message = "fixture ${Stage}: $status"; matchedTests = 3; passedTests = 3; failedTests = 0; skippedTests = 0 }
if ($env:ADAPTER_DIAGNOSTIC) { $result.diagnostics = @($env:ADAPTER_DIAGNOSTIC -split '\|\|') }
if ($status -eq 'no-matching-tests') { $result.matchedTests = 0; $result.passedTests = 0 }
if ($status -eq 'failed') { $result.failedTests = 1; $result.passedTests = 2 }
Write-Output ($result | ConvertTo-Json -Compress)
if ($env:ADAPTER_EXIT) { exit [int]$env:ADAPTER_EXIT }
if ($status -eq 'failed') { exit 1 }
exit 0
'@
    $configPath = Join-Path $project '.ai/factory/factory.config.yaml'
    $configText = @'
factory:
  source: "cezar-factory"
  version: "__FACTORY_VERSION__"
validation:
  targeted:
    command: "pwsh ./runner.ps1 changed"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites: ["pwsh"]
    timeoutSeconds: 1200
    evidencePath: ".factory/artifacts/verification/changed.json"
    appliesTo:
      - "src/**"
  full:
    command: "pwsh ./runner.ps1 full"
    resultFormat: "json"
    workingDirectory: "."
    prerequisites: ["pwsh"]
    timeoutSeconds: 7200
    evidencePath: ".factory/artifacts/verification/full.json"
    appliesTo:
      - "*"
  verify: "pwsh ./runner.ps1 verify"
'@
    Set-Content $configPath ($configText.Replace('__FACTORY_VERSION__', (Get-Content -Raw (Join-Path $factory 'VERSION')).Trim()))
    & git -C $project init -q | Out-Null
    & git -C $project config user.email factory-tests@example.com
    & git -C $project config user.name FactoryTests
    & git -C $project remote add origin https://github.com/example/project.git
    & git -C $project add .
    & git -C $project commit -qm init
    $baselineSourceHead = (& git -C $project rev-parse HEAD).Trim()
    $knownDiagnostic = 'C:\fixture\src\legacy.ts:10:2: Known fixture defect'
    $knownFingerprint = Get-ValidationDiagnosticFingerprint $knownDiagnostic $project
    $baselinePath = '.factory/validation-baseline.json'
    $baselineFile = Join-Path $project $baselinePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $baselineFile) -Force | Out-Null
    @{ schemaVersion = 1; createdAt = [DateTimeOffset]::UtcNow.ToString('o'); expiresAt = [DateTimeOffset]::UtcNow.AddDays(30).ToString('o'); sourceHeadSha = $baselineSourceHead; reason = 'Adapter test fixture'; diagnosticFingerprints = @($knownFingerprint) } |
        ConvertTo-Json -Depth 4 | Set-Content $baselineFile
    & git -C $project add -f -- $baselinePath
    & git -C $project commit -qm 'add pinned validation baseline'
    $baselineHash = (Get-FileHash -LiteralPath $baselineFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $configText = $configText.Replace('    appliesTo:' + "`n" + '      - "src/**"', "    baselinePath: `"$baselinePath`"`n    baselineSha256: `"$baselineHash`"`n    appliesTo:`n      - `"src/**`"")
    $configText = $configText.Replace('    command: "pwsh ./runner.ps1 full"', "    command: `"pwsh ./runner.ps1 full`"`n    baselinePath: `"$baselinePath`"`n    baselineSha256: `"$baselineHash`"")
    Set-Content $configPath ($configText.Replace('__FACTORY_VERSION__', (Get-Content -Raw (Join-Path $factory 'VERSION')).Trim()))
    & git -C $project add -- .ai/factory/factory.config.yaml
    & git -C $project commit -qm 'pin validation baseline'
    $baselineHead = (& git -C $project rev-parse HEAD).Trim()
    New-Item -ItemType Directory -Path (Join-Path $project '.factory') -Force | Out-Null
    @{ schemaVersion = 1; environment = @{ repositoryHeadSha = $baselineHead; projectFactoryConfigSha256 = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() } } |
        ConvertTo-Json -Depth 4 | Set-Content (Join-Path $project '.factory/implementation-context.json')
    New-Item -ItemType Directory -Path (Join-Path $project 'src') -Force | Out-Null
    Set-Content (Join-Path $project 'src/fixture.ts') 'export const validationFixture = true'
    & git -C $project add src/fixture.ts
    & git -C $project commit -qm 'fixture project change'
    $templateConfig = Read-FactoryConfig (Join-Path $factory 'templates/factory.config.yaml')
    Check 'factory template parser reads nested targeted verification contract' (
        $templateConfig.validation.targeted.command -eq '' -and
        $templateConfig.validation.targeted.timeoutSeconds -eq 600 -and
        $templateConfig.validation.targeted.appliesTo.Count -eq 1 -and
        $templateConfig.validation.targeted.appliesTo[0] -eq '*')
    Check 'template does not point its verifier back at the Factory wrapper' ($templateConfig.validation.verify -eq '')
    $templateJson = $templateConfig | ConvertTo-Json -Depth 12
    Check 'factory template validates against the factory config schema' (
        [bool](Test-Json -Json $templateJson -SchemaFile (Join-Path $factory 'schemas/factory.config.schema.json')))
    New-Item -ItemType Directory -Path (Join-Path $project '.factory') -Force | Out-Null
    @{ issue = 7; pr = 'https://github.com/example/project/pull/1' } |
        ConvertTo-Json | Set-Content (Join-Path $project '.factory/implement-result.json')

    $env:ADAPTER_EXPECT_CHANGED_FILE = 'src/fixture.ts'
    foreach ($stage in 'changed', 'full', 'verify') {
        $run = Run-Stage $stage
        Check "$stage runs configured adapter" ($run.Code -eq 0 -and $run.Receipt.status -eq 'passed' -and $run.Receipt.stage -eq $stage)
        $expectedReason = if ($stage -eq 'verify') { 'validation_passed' } else { 'validation_result_passed' }
        Check "$stage receipt carries a structured reason code" ($run.Receipt.reasonCode -eq $expectedReason)
        if ($stage -ne 'verify') {
            $expectedEvidence = ".factory/artifacts/verification/$stage.json"
            Check "$stage receipt reflects structured workdir/evidence metadata" ($run.Receipt.workingDirectory -eq '.' -and $run.Receipt.evidencePath -eq $expectedEvidence)
        }
        if ($stage -eq 'changed') {
            Check 'targeted receipt records bounded changed-file evidence' ($run.Receipt.changedFilesKnown -and $run.Receipt.changedFiles -contains 'src/fixture.ts')
        }
        Check "$stage receipt binds project head" ($run.Receipt.issue -eq 7 -and $run.Receipt.repository -eq 'example/project' -and $run.Receipt.headSha -eq (& git -C $project rev-parse HEAD))
        $expectedTimeout = if ($stage -eq 'changed') { 1200 } else { 7200 }
        Check "$stage declares bounded timeout" ($run.Receipt.timeoutSeconds -eq $expectedTimeout)
    }
    Remove-Item Env:ADAPTER_EXPECT_CHANGED_FILE
    Check 'each configured adapter ran once' (@(Get-Content (Join-Path $project '.factory/counter.txt')).Count -eq 3)
    $env:ADAPTER_DIAGNOSTIC = $knownDiagnostic + '||   '
    $run = Run-Stage full
    Check 'pinned baseline classifies a known diagnostic in the receipt' (
        $run.Code -eq 0 -and $run.Receipt.diagnosticComparison.status -eq 'compared' -and
        $run.Receipt.diagnosticComparison.knownFingerprints.Count -eq 1 -and
        $run.Receipt.diagnosticComparison.newFingerprints.Count -eq 0 -and $run.Receipt.diagnosticComparison.unclassifiedCount -eq 1)
    $env:ADAPTER_RESULT_STATUS = 'failed'
    $env:ADAPTER_DIAGNOSTIC = $knownDiagnostic
    $run = Run-Stage full
    Check 'known baseline diagnostics never turn a failing validation into a pass' (
        $run.Code -ne 0 -and $run.Receipt.status -eq 'failed' -and $run.Receipt.diagnosticComparison.knownFingerprints.Count -eq 1)
    Remove-Item Env:ADAPTER_RESULT_STATUS -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_DIAGNOSTIC -ErrorAction SilentlyContinue
    $run = Run-Stage full
    Check 'resolved baseline diagnostic is absent from the current comparison' (
        $run.Code -eq 0 -and $run.Receipt.diagnosticComparison.status -eq 'compared' -and
        $run.Receipt.diagnosticComparison.knownFingerprints.Count -eq 0 -and
        $run.Receipt.diagnosticComparison.newFingerprints.Count -eq 0)
    $env:ADAPTER_DIAGNOSTIC = 'src/new.ts:42:7: New fixture defect'
    $env:ADAPTER_RESULT_STATUS = 'failed'
    $run = Run-Stage full
    Check 'new regression remains visible and fails validation' (
        $run.Code -ne 0 -and $run.Receipt.status -eq 'failed' -and $run.Receipt.diagnosticComparison.newFingerprints.Count -eq 1)
    Remove-Item Env:ADAPTER_RESULT_STATUS -ErrorAction SilentlyContinue
    $env:ADAPTER_DIAGNOSTIC = $knownDiagnostic
    Add-Content -LiteralPath $baselineFile -Value 'tampered'
    $run = Run-Stage full
    Check 'modified baseline is unavailable and cannot classify defects as known' (
        $run.Receipt.diagnosticComparison.status -eq 'unavailable' -and
        $run.Receipt.diagnosticComparison.reasonCode -eq 'baseline_hash_mismatch' -and
        $run.Receipt.diagnosticComparison.knownFingerprints.Count -eq 0)
    Remove-Item Env:ADAPTER_DIAGNOSTIC -ErrorAction SilentlyContinue

    $originalConfig = Get-Content -Raw $configPath
    $originalConfig.Replace('- "src/**"', '- "docs/**"') | Set-Content $configPath
    $beforeCount = @(Get-Content (Join-Path $project '.factory/counter.txt')).Count
    $run = Run-Stage changed
    Check 'non-applicable targeted changes skip without running tests' ($run.Code -eq 0 -and $run.Receipt.status -eq 'skipped' -and $run.Receipt.reasonCode -eq 'validation_not_applicable' -and @(Get-Content (Join-Path $project '.factory/counter.txt')).Count -eq $beforeCount)
    $originalConfig | Set-Content $configPath

    foreach ($statusCase in @(
        @{ Status = 'no-matching-tests'; Reason = 'validation_result_no_matching_tests'; Fixture = 'validation-result-no-matching-tests.json'; ExitCode = 18 },
        @{ Status = 'unavailable'; Reason = 'validation_result_unavailable'; Fixture = 'validation-result-unavailable.json'; ExitCode = 11 },
        @{ Status = 'skipped'; Reason = 'validation_result_skipped'; Fixture = 'validation-result-skipped.json'; ExitCode = 18 }
    )) {
        $env:ADAPTER_RESULT_FILE = Join-Path $PSScriptRoot "fixtures/$($statusCase.Fixture)"
        $run = Run-Stage full
        Check "structured $($statusCase.Status) uses its normalized stop code (code=$($run.Code), status=$($run.Receipt.status), reason=$($run.Receipt.reasonCode))" ($run.Code -eq $statusCase.ExitCode -and $run.Receipt.status -eq $statusCase.Status -and $run.Receipt.reasonCode -eq $statusCase.Reason)
    }
    Remove-Item Env:ADAPTER_RESULT_FILE
    $env:ADAPTER_RESULT_FILE = Join-Path $PSScriptRoot 'fixtures/validation-result-failed.json'
    $run = Run-Stage full
    Check 'structured test regression returns the only repairable validation code' ($run.Code -eq 1 -and $run.Receipt.validationResult.reasonCode -eq 'test_regression')
    Remove-Item Env:ADAPTER_RESULT_FILE
    foreach ($projectCase in @(
        @{ Name = 'Node'; Fixture = 'validation-result-node-failure.json'; Diagnostic = 'test/unit/player.test.ts'; Failed = 1 },
        @{ Name = 'Godot parser'; Fixture = 'validation-result-godot-parse-error.json'; Diagnostic = 'res://Scripts/Player.gd:12'; Failed = 1 },
        @{ Name = 'GdUnit'; Fixture = 'validation-result-gdunit-failure.json'; Diagnostic = 'res://test/player_test.gd::test_jump'; Failed = 1 }
    )) {
        $fixturePath = Join-Path $PSScriptRoot "fixtures/$($projectCase.Fixture)"
        $env:ADAPTER_RESULT_FILE = $fixturePath
        $run = Run-Stage full
        $capturedStdout = Get-Content -Raw (Join-Path $project $run.Receipt.artifactPaths[0])
        $capturedBytes = (Get-Item (Join-Path $project $run.Receipt.artifactPaths[0])).Length
        $started = [DateTimeOffset]::Parse($run.Receipt.startedAt)
        $finished = [DateTimeOffset]::Parse($run.Receipt.finishedAt)
        Check "$($projectCase.Name) failure maps to a work regression and preserves failing diagnostics" (
            $run.Code -eq 1 -and $run.Receipt.status -eq 'failed' -and
            $run.Receipt.validationResult.failedTests -eq $projectCase.Failed -and
            $run.Receipt.validationResult.diagnostics[0].Contains($projectCase.Diagnostic) -and
            $capturedStdout.Contains($projectCase.Diagnostic))
        Check "$($projectCase.Name) failure receipt preserves bounded output and execution timestamps (bytes=$capturedBytes, start=$started, finish=$finished)" (
            $capturedBytes -le 65536 -and $finished -ge $started)
        $fixtureJson = Get-Content -Raw $fixturePath
        Check "$($projectCase.Name) result fixture matches the project-validation schema" (
            [bool](Test-Json -Json $fixtureJson -SchemaFile (Join-Path $factory 'schemas/project-validation-result.schema.json')))
    }
    Remove-Item Env:ADAPTER_RESULT_FILE
    $env:ADAPTER_RESULT_FILE = Join-Path $PSScriptRoot 'fixtures/validation-result-malformed.json'
    $run = Run-Stage full
    Check 'malformed structured result is a non-retryable contract error' ($run.Code -eq 17 -and $run.Receipt.status -eq 'error' -and $run.Receipt.reasonCode -eq 'validation_result_malformed')
    Remove-Item Env:ADAPTER_RESULT_FILE
    $validResult = Get-Content -Raw (Join-Path $PSScriptRoot 'fixtures/validation-result-passed.json')
    $invalidResult = Get-Content -Raw (Join-Path $PSScriptRoot 'fixtures/validation-result-malformed.json')
    Check 'valid project result fixture matches its contract schema' ([bool](Test-Json -Json $validResult -SchemaFile (Join-Path $factory 'schemas/project-validation-result.schema.json')))
    $invalidResultValid = $true
    try { $invalidResultValid = [bool](Test-Json -Json $invalidResult -SchemaFile (Join-Path $factory 'schemas/project-validation-result.schema.json') -ErrorAction Stop) } catch { $invalidResultValid = $false }
    Check 'malformed project result fixture fails contract schema' (-not $invalidResultValid)
    $priorValidationRoot = $env:FACTORY_VALIDATION_ROOT
    $env:FACTORY_VALIDATION_ROOT = $factory
    try { $otherWorktreeRun = Run-Stage full }
    finally {
        if ($priorValidationRoot) { $env:FACTORY_VALIDATION_ROOT = $priorValidationRoot }
        else { Remove-Item Env:FACTORY_VALIDATION_ROOT -ErrorAction SilentlyContinue }
    }
    Check 'nested suite may validate a different worktree' ($otherWorktreeRun.Code -eq 0 -and $otherWorktreeRun.Receipt.status -eq 'passed')
    $full = Receipt full
    Check 'receipt validates against versioned schema' (Test-Json -Json ($full | ConvertTo-Json -Depth 8) -SchemaFile (Join-Path $factory 'schemas/validation-receipt.schema.json'))
    Check 'artifacts stay in the worktree' ((Test-Path (Join-Path $project '.factory/artifacts/validation/full')) -and -not (Test-Path (Join-Path $factory 'scripts/artifacts')))

    foreach ($projectType in @('powershell', 'dotnet', 'js-ts', 'godot')) {
        $original = Get-Content -Raw $configPath
        $original.Replace('pwsh ./runner.ps1 full', "pwsh ./runner.ps1 $projectType") | Set-Content $configPath
        $beforeCount = @(Get-Content (Join-Path $project '.factory/counter.txt')).Count
        $run = Run-Stage full
        $lastRun = (Get-Content (Join-Path $project '.factory/counter.txt'))[-1]
        Check "$projectType adapter command runs once" ($run.Code -eq 0 -and (@(Get-Content (Join-Path $project '.factory/counter.txt')).Count -eq ($beforeCount + 1)) -and $lastRun -eq $projectType)
        Check "$projectType dirty worktree cannot look clean" (-not $run.Receipt.worktreeClean)
        Set-Content $configPath $original
    }

    $env:ADAPTER_EXIT = '7'
    $run = Run-Stage full
    Check 'nonzero adapter exit fails with matching receipt' ($run.Code -ne 0 -and $run.Receipt.status -eq 'failed' -and $run.Receipt.exitCode -ne 0)
    Remove-Item Env:ADAPTER_EXIT

    $env:ADAPTER_EXIT = '7'
    $env:ADAPTER_FAILURE_LOG = "test failed at $project; token=ghp_abcdefghijklmnop12345 API_KEY=private-value"
    $run = Run-Stage full
    Check 'failed validation exposes a bounded sanitized diagnostic excerpt' (
        $run.Code -ne 0 -and $run.Receipt.diagnosticExcerpt -match 'test failed' -and
        $run.Receipt.diagnosticExcerpt -notmatch [regex]::Escape($project) -and
        $run.Receipt.diagnosticExcerpt -notmatch 'ghp_abcdefghijklmnop12345|private-value' -and
        $run.Receipt.diagnosticExcerpt.Length -le 1801)
    Remove-Item Env:ADAPTER_EXIT
    Remove-Item Env:ADAPTER_FAILURE_LOG

    $env:ADAPTER_HUGE = '1'
    $run = Run-Stage full
    $logPath = Join-Path $project $run.Receipt.artifactPaths[0]
    Check 'huge output is bounded and marked truncated' ($run.Code -eq 0 -and $run.Receipt.truncated -and (Get-Item $logPath).Length -le 65536)
    Remove-Item Env:ADAPTER_HUGE

    $originalConfig = Get-Content -Raw $configPath
    $originalConfig.Replace('prerequisites: ["pwsh"]', 'prerequisites: ["factory-missing-tool"]') | Set-Content $configPath
    $beforeCount = @(Get-Content (Join-Path $project '.factory/counter.txt')).Count
    $run = Run-Stage full
    Check 'missing configured prerequisite is unavailable and never runs tests' ($run.Code -ne 0 -and $run.Receipt.status -eq 'unavailable' -and $run.Receipt.reasonCode -eq 'validation_prerequisite_missing' -and @(Get-Content (Join-Path $project '.factory/counter.txt')).Count -eq $beforeCount)
    $originalConfig | Set-Content $configPath

    $originalConfig.Replace('workingDirectory: "."', 'workingDirectory: "../outside"') | Set-Content $configPath
    $run = Run-Stage full
    Check 'validation working directory cannot escape its project worktree' ($run.Code -ne 0 -and $run.Receipt.status -eq 'error' -and $run.Receipt.reasonCode -eq 'validation_config_invalid')
    $originalConfig | Set-Content $configPath

    $env:ADAPTER_DIRTY = '1'
    $run = Run-Stage full
    Check 'runner-created untracked file makes receipt dirty' ($run.Code -eq 0 -and $run.Receipt.status -eq 'passed' -and -not $run.Receipt.worktreeClean)
    Remove-Item Env:ADAPTER_DIRTY
    Remove-Item (Join-Path $project 'adapter-output.tmp')

    $headBefore = & git -C $project rev-parse HEAD
    $env:ADAPTER_COMMIT = '1'
    $run = Run-Stage full
    Check 'runner commit invalidates the old-head receipt' ($run.Code -ne 0 -and
        $run.Receipt.status -eq 'error' -and $run.Receipt.headSha -eq $headBefore -and
        -not $run.Receipt.worktreeClean -and $run.Receipt.message -match 'HEAD changed' -and
        (& git -C $project rev-parse HEAD) -ne $headBefore)
    Remove-Item Env:ADAPTER_COMMIT

    $peer = Join-Path ([IO.Path]::GetTempPath()) "factory validation peer $([guid]::NewGuid().ToString('N').Substring(0, 8))"
    & git -C $project worktree add -q --detach $peer HEAD
    New-Item -ItemType Directory -Path (Join-Path $peer '.factory') -Force | Out-Null
    Copy-Item (Join-Path $project '.factory/implement-result.json') (Join-Path $peer '.factory/implement-result.json')
    $before = @(Get-ChildItem (Join-Path $project '.factory/artifacts/validation/full') -Directory).Count
    $children = @()
    foreach ($worktree in @($project, $peer)) {
        $start = [Diagnostics.ProcessStartInfo]::new('pwsh')
        foreach ($argument in @('-NoProfile', '-File', (Join-Path $factory 'scripts/factory/test-full.ps1'), '-Task', '7')) { $start.ArgumentList.Add($argument) }
        $start.WorkingDirectory = $worktree; $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $child = [Diagnostics.Process]::new(); $child.StartInfo = $start
        [void]$child.Start(); $children += $child
    }
    foreach ($child in $children) { $child.WaitForExit(); $child.Dispose() }
    $after = @(Get-ChildItem (Join-Path $project '.factory/artifacts/validation/full') -Directory).Count
    $peerReceipts = @(Get-ChildItem (Join-Path $peer '.factory/artifacts/validation/full') -Filter receipt.json -Recurse)
    Check 'concurrent worktrees keep distinct artifact directories' ($after -eq ($before + 1) -and $peerReceipts.Count -eq 1)
    $resolvedPeer = [IO.Path]::GetFullPath($peer)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedPeer.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { & git -C $project worktree remove --force $resolvedPeer }

    $configText = Get-Content -Raw $configPath
    $wrapper = (Join-Path $factory 'scripts/factory/test-full.ps1') -replace '\\', '/'
    $configText.Replace('pwsh ./runner.ps1 full', "pwsh '$wrapper'") | Set-Content $configPath
    $run = Run-Stage full
    Check 'same-wrapper recursion fails closed' ($run.Code -ne 0 -and $run.Receipt.status -eq 'error' -and $run.Receipt.message -match 'recursively')

    $configText.Replace('pwsh ./runner.ps1 full', 'skip') | Set-Content $configPath
    $run = Run-Stage full
    Check 'required full stage cannot be skipped' ($run.Code -ne 0 -and $run.Receipt.status -eq 'error')
    $configText.Replace('pwsh ./runner.ps1 changed', 'skip') | Set-Content $configPath
    $run = Run-Stage changed
    Check 'explicit unsupported targeted stage is skipped, not passed' ($run.Code -eq 0 -and $run.Receipt.status -eq 'skipped')
    [regex]::Replace($configText, '(?ms)^  full:\r?\n.*?(?=^  verify:)', '') | Set-Content $configPath
    $run = Run-Stage full
    Check 'missing full command is unavailable and fails closed' ($run.Code -ne 0 -and $run.Receipt.status -eq 'unavailable' -and $run.Receipt.reasonCode -eq 'validation_command_missing')
    $configText.Replace('command: "pwsh ./runner.ps1 full"', 'command: ""') | Set-Content $configPath
    $run = Run-Stage full
    Check 'blank full command is unavailable and fails closed' ($run.Code -ne 0 -and $run.Receipt.status -eq 'unavailable' -and $run.Receipt.reasonCode -eq 'validation_command_missing')
    Remove-Item $configPath
    $run = Run-Stage full
    Check 'missing config is unavailable without discovery fallback' ($run.Code -ne 0 -and $run.Receipt.status -eq 'unavailable' -and $run.Receipt.reasonCode -eq 'validation_config_missing')
    Set-Content $configPath ($configText.Replace('__FACTORY_VERSION__', (Get-Content -Raw (Join-Path $factory 'VERSION')).Trim()).Replace('timeoutSeconds: 7200', 'timeoutSeconds: 1'))
    $env:ADAPTER_SLEEP = '3'
    $env:ADAPTER_FAILURE_LOG = 'timeout diagnostic remains available'
    $run = Run-Stage full
    Check 'timed out verifier uses the normalized non-retry timeout code' (
        $run.Code -eq 16 -and $run.Receipt.status -eq 'error' -and
        $run.Receipt.reasonCode -eq 'validation_timeout' -and $run.Receipt.message -match 'exceeded the 1-second limit' -and
        $run.Receipt.diagnosticExcerpt -match 'timeout diagnostic remains available')
    Remove-Item Env:ADAPTER_SLEEP -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_FAILURE_LOG -ErrorAction SilentlyContinue
} finally {
    Remove-Item Env:ADAPTER_EXIT -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_HUGE -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_DIRTY -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_COMMIT -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_EXPECT_CHANGED_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_RESULT_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_DIAGNOSTIC -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_FAILURE_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_RESULT_STATUS -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_SLEEP -ErrorAction SilentlyContinue
    $resolvedProject = [IO.Path]::GetFullPath($project)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($peer -and (Test-Path -LiteralPath $peer)) {
        $resolvedPeer = [IO.Path]::GetFullPath($peer)
        if ($resolvedPeer.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            & git -C $project worktree remove --force $resolvedPeer 2>$null
        }
    }
    if ($resolvedProject.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedProject -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if ($failures) { exit 1 }
