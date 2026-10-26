#!/usr/bin/env pwsh
# Fixture coverage for the watchdog's read-only parsing and eligibility path.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scriptPath = Join-Path $factory 'scripts/watchdog-automations.ps1'
$fixtures = Join-Path $PSScriptRoot 'fixtures'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("factory-watchdog-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$script:failures = 0

function Assert([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" }
    else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:failures++ }
}

function Invoke-WatchdogFixture([string]$Fixture, [string]$Name) {
    $report = Join-Path $temp "$Name.json"
    $output = & pwsh -NoProfile -File $scriptPath `
        -ApiUrl 'http://127.0.0.1:9' -ProjectId 'fixture' -DryRun `
        -RunsFixturePath (Join-Path $fixtures $Fixture) -OutputPath $report 2>&1 | Out-String
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output; Report = if (Test-Path $report) { Get-Content -Raw $report | ConvertFrom-Json } else { $null } }
}

try {
    $array = Invoke-WatchdogFixture 'watchdog-runs.json' 'array'
    Assert 'watchdog accepts live top-level array and completes dry-run' ($array.ExitCode -eq 0 -and $array.Report.status -eq 'complete')
    $stalled = @($array.Report.decisions | Where-Object id -eq 'stalled-owned-run') | Select-Object -First 1
    Assert 'watchdog identifies only the positively owned stalled issue run' ($stalled.decision -eq 'would-cancel' -and $stalled.reason -eq 'factory-run-stalled-past-deadline' -and ($stalled.evidence -contains 'lease.runId=stalled-owned-run'))
    $unrelated = @($array.Report.decisions | Where-Object id -eq 'unrelated-run') | Select-Object -First 1
    Assert 'watchdog skips an unrelated workflow' ($unrelated.decision -eq 'skipped' -and $unrelated.reason -eq 'not-positive-factory-workflow')
    $long = @($array.Report.decisions | Where-Object id -eq 'legitimate-long-run') | Select-Object -First 1
    Assert 'watchdog skips a legitimate long-running active run' ($long.decision -eq 'skipped' -and $long.reason -eq 'runner-not-confirmed-stalled')
    $legacy = @($array.Report.decisions | Where-Object id -eq 'current-cezar-record') | Select-Object -First 1
    Assert 'watchdog skips legacy run records without liveness evidence' ($legacy.decision -eq 'skipped' -and $legacy.reason -eq 'runner-not-confirmed-stalled')

    $envelope = Invoke-WatchdogFixture 'watchdog-runs-envelope.json' 'envelope'
    Assert 'watchdog accepts the explicit data.runs compatibility envelope' ($envelope.ExitCode -eq 0 -and $envelope.Report.status -eq 'complete' -and @($envelope.Report.decisions).Count -eq 0)
    $runsEnvelope = Invoke-WatchdogFixture 'watchdog-runs-envelope-simple.json' 'runs-envelope'
    Assert 'watchdog accepts the explicit runs compatibility envelope' ($runsEnvelope.ExitCode -eq 0 -and $runsEnvelope.Report.status -eq 'complete' -and @($runsEnvelope.Report.decisions).Count -eq 0)

    $malformed = Invoke-WatchdogFixture 'watchdog-runs-malformed.json' 'malformed'
    Assert 'watchdog rejects and reports an unsupported response shape' ($malformed.ExitCode -eq 1 -and $malformed.Report.status -eq 'failed' -and @($malformed.Report.failures).Count -eq 1 -and $malformed.Report.failures[0].error -match 'must be an array')

    $pythonRunner = if (Get-Command python.exe -ErrorAction SilentlyContinue) { (Get-Command python.exe).Source }
        elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' }
        elseif (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' }
        else { $null }
    if ($pythonRunner) {
        $statePath = Join-Path $temp 'api-state.json'
        $readyPath = Join-Path $temp 'api-ready.txt'
        $apiState = [ordered]@{
            runs = @((Get-Content -Raw (Join-Path $fixtures 'watchdog-runs.json') | ConvertFrom-Json) | Where-Object id -eq 'stalled-owned-run')
            cancelCount = 0
        }
        $apiState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding utf8
        $serverPath = Join-Path $PSScriptRoot 'watchdog-mock-api.py'
        $server = Start-Process -FilePath $pythonRunner -ArgumentList @($serverPath, '--state', $statePath, '--ready', $readyPath) -WindowStyle Hidden -PassThru
        try {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
            $readyPort = 0
            while ($readyPort -lt 1 -and [DateTimeOffset]::UtcNow -lt $deadline -and -not $server.HasExited) {
                if (Test-Path $readyPath) {
                    $readyText = Get-Content -Raw $readyPath -ErrorAction SilentlyContinue
                    [void][int]::TryParse(($readyText ?? '').Trim(), [ref]$readyPort)
                }
                if ($readyPort -lt 1) { Start-Sleep -Milliseconds 50 }
            }
            if ($readyPort -gt 0) {
                $apiUrl = "http://127.0.0.1:$readyPort"
                $firstReport = Join-Path $temp 'api-first.json'
                $firstOutput = & pwsh -NoProfile -File $scriptPath -ApiUrl $apiUrl -ProjectId fixture -OutputPath $firstReport 2>&1 | Out-String
                $firstCode = $LASTEXITCODE
                $first = if (Test-Path $firstReport) { Get-Content -Raw $firstReport | ConvertFrom-Json } else { $null }
                $stateAfterFirst = Get-Content -Raw $statePath | ConvertFrom-Json
                $cancelledDecision = @($first.decisions | Where-Object id -eq 'stalled-owned-run') | Select-Object -First 1
                Assert 'watchdog re-reads and confirms one eligible API cancellation' ($firstCode -eq 0 -and $first.status -eq 'complete' -and $cancelledDecision.decision -eq 'cancelled' -and $cancelledDecision.operator -and $stateAfterFirst.cancelCount -eq 1)

                $secondReport = Join-Path $temp 'api-second.json'
                $secondOutput = & pwsh -NoProfile -File $scriptPath -ApiUrl $apiUrl -ProjectId fixture -OutputPath $secondReport 2>&1 | Out-String
                $secondCode = $LASTEXITCODE
                $second = if (Test-Path $secondReport) { Get-Content -Raw $secondReport | ConvertFrom-Json } else { $null }
                $stateAfterSecond = Get-Content -Raw $statePath | ConvertFrom-Json
                $repeatDecision = @($second.decisions | Where-Object id -eq 'stalled-owned-run') | Select-Object -First 1
                Assert 'watchdog repeated invocation does not duplicate cancellation' ($secondCode -eq 0 -and $second.status -eq 'complete' -and $repeatDecision.reason -eq 'run-not-running' -and $stateAfterSecond.cancelCount -eq 1)
            } else {
                Assert 'watchdog mock API server starts for cancellation replay' $false
            }
        }
        finally {
            if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
            Wait-Process -Id $server.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host '  SKIP watchdog API re-read replay: Python is not installed.'
    }
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures) { exit 1 }
Write-Host 'Watchdog fixture tests passed.'
