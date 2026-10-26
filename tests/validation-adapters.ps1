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
try {
    New-Item -ItemType Directory -Path (Join-Path $project '.ai/factory') -Force | Out-Null
    Set-Content (Join-Path $project '.gitignore') ".factory/"
    Set-Content (Join-Path $project 'runner.ps1') @'
param([string]$Stage)
Add-Content .factory/counter.txt $Stage
if ($env:ADAPTER_HUGE) { Write-Output ('x' * 120000) }
if ($env:ADAPTER_DIRTY) { Set-Content ./adapter-output.tmp dirty }
if ($env:ADAPTER_COMMIT) {
    Set-Content ./adapter-commit.txt changed
    & git add -- adapter-commit.txt
    & git commit -qm runner-change
}
if ($env:ADAPTER_EXIT) { exit [int]$env:ADAPTER_EXIT }
Write-Output "ran $Stage"
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
      - "*"
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

    foreach ($stage in 'changed', 'full', 'verify') {
        $run = Run-Stage $stage
        Check "$stage runs configured adapter" ($run.Code -eq 0 -and $run.Receipt.status -eq 'passed' -and $run.Receipt.stage -eq $stage)
        Check "$stage receipt carries a structured reason code" ($run.Receipt.reasonCode -eq 'validation_passed')
        if ($stage -ne 'verify') {
            $expectedEvidence = ".factory/artifacts/verification/$stage.json"
            Check "$stage receipt reflects structured workdir/evidence metadata" ($run.Receipt.workingDirectory -eq '.' -and $run.Receipt.evidencePath -eq $expectedEvidence)
        }
        Check "$stage receipt binds project head" ($run.Receipt.issue -eq 7 -and $run.Receipt.repository -eq 'example/project' -and $run.Receipt.headSha -eq (& git -C $project rev-parse HEAD))
        $expectedTimeout = if ($stage -eq 'changed') { 1200 } else { 7200 }
        Check "$stage declares bounded timeout" ($run.Receipt.timeoutSeconds -eq $expectedTimeout)
    }
    Check 'each configured adapter ran once' (@(Get-Content (Join-Path $project '.factory/counter.txt')).Count -eq 3)
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
    Remove-Item $configPath
    $run = Run-Stage full
    Check 'missing config is unavailable without discovery fallback' ($run.Code -ne 0 -and $run.Receipt.status -eq 'unavailable' -and $run.Receipt.reasonCode -eq 'validation_config_missing')
} finally {
    Remove-Item Env:ADAPTER_EXIT -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_HUGE -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_DIRTY -ErrorAction SilentlyContinue
    Remove-Item Env:ADAPTER_COMMIT -ErrorAction SilentlyContinue
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
