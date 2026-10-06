#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$ProjectPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [int]$MaxRuns = 20,
    [switch]$CreateIssue,
    [switch]$RestartFailedIntake,
    [string]$ApiUrl = 'http://127.0.0.1:4321',
    [string]$ProjectId,
    [string]$FactoryRepo = 'bin0110001/cezar-factory',
    [int]$RestartCooldownMinutes = 60
)

$ErrorActionPreference = 'Stop'
if ($MaxRuns -lt 1 -or $MaxRuns -gt 20) { throw 'MaxRuns must be between 1 and 20.' }

if (-not $ProjectPath) {
    $cwd = (Get-Location).Path
    if ($cwd -match '^(?<root>.+)[\\/]\.ai[\\/]cezar[\\/]worktrees[\\/][^\\/]+$') { $ProjectPath = $Matches.root }
    else { throw 'ProjectPath is required outside a Cezar isolated worktree.' }
}
$project = [IO.Path]::GetFullPath($ProjectPath)
$projectName = Split-Path $project -Leaf
if (-not $ProjectId) { $ProjectId = $projectName.ToLowerInvariant() }
$runDir = Join-Path $project '.ai/cezar/runs'
$output = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path $output -Parent
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

$result = [ordered]@{
    status = 'ready'
    project = (Split-Path $project -Leaf)
    runsInspected = 0
    failures = @()
    limitations = @()
    issueCreated = $false
    issueNumber = $null
    factoryIssueCreated = $false
    factoryIssueNumber = $null
    restarted = $false
    restartRunId = $null
}

if (-not (Test-Path $runDir)) {
    $result.status = 'limited'
    $result.limitations = @("runtime run directory not found: $runDir")
    $result | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $output
    Write-Output (($result | ConvertTo-Json -Compress -Depth 8))
    exit 0
}

function Read-ApiArray([string]$Uri, [string]$PropertyName) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Get
    $payload = $response.Content | ConvertFrom-Json
    if ($PropertyName -and $payload.PSObject.Properties.Name -contains $PropertyName) { return @($payload.$PropertyName) }
    return @($payload)
}

$handoffs = @(Get-ChildItem -LiteralPath $runDir -Filter '*.handoff.md' -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First $MaxRuns)
$failurePattern = '(?i)(failed|failure|error|cancelled|canceled|unknown workflow|timed out|timeout)'
$failures = [System.Collections.Generic.List[object]]::new()
function Compact([string]$Text) {
    $clean = ($Text -replace '\s+', ' ').Trim()
    if ($clean.Length -gt 400) { return $clean.Substring(0, 400) + '…' }
    return $clean
}
foreach ($handoff in $handoffs) {
    $runId = $handoff.BaseName -replace '\.handoff$',''
    $eventPath = Join-Path $runDir "$runId.ndjson"
    $handoffText = Get-Content -LiteralPath $handoff.FullName -Raw
    $tail = if (Test-Path $eventPath) { @(Get-Content -LiteralPath $eventPath -Tail 200) } else { @() }
    $knownEvidence = @($handoffText -split "`r?`n" | Where-Object { $_ -match '(?i)(unknown workflow|workflow.*not found|missing.*(skill|workflow)|validate-result.*kind)' } | Select-Object -First 4 | ForEach-Object { Compact $_ })
    $evidence = @($knownEvidence)
    $evidence += @($handoffText -split "`r?`n" | Where-Object { $_ -match $failurePattern -and $_ -notmatch '(?i)(unknown workflow|workflow.*not found|missing.*(skill|workflow)|validate-result.*kind)' } | Select-Object -First 4 | ForEach-Object { Compact $_ })
    $evidence += @($tail | Where-Object { $_ -match $failurePattern } | Select-Object -Last 6 | ForEach-Object { Compact $_ })
    if ($evidence.Count -gt 0) {
        $failures.Add([ordered]@{
            runId = $runId
            lastWriteUtc = $handoff.LastWriteTimeUtc.ToString('o')
            handoffPath = $handoff.FullName
            eventPath = if (Test-Path $eventPath) { $eventPath } else { $null }
            evidence = @($evidence | Select-Object -Unique)
        })
    }
}
$result.runsInspected = $handoffs.Count
$result.failures = @($failures | Select-Object -First 8)
$factorySignature = '(?i)(unknown workflow|workflow.*not found|missing.*(skill|workflow)|validate-result.*kind|factory[- ]intake|intake.*validate|validate.*intake|kind intake)'
$factoryFailures = @($result.failures | Where-Object { (@($_.evidence) -join "`n") -match $factorySignature })
$intakeFailures = @($factoryFailures | Where-Object { (@($_.evidence) -join "`n") -match '(?i)(factory[- ]intake|intake.*validate|validate.*intake|kind intake)' })
try {
    $apiBase = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
    $apiRuns = @(Read-ApiArray "$apiBase/runs" 'runs')
    $failedIntakeRuns = @($apiRuns | Where-Object { $_.workflow -eq 'factory-intake' -and $_.status -eq 'failed' } | Sort-Object createdAt -Descending | Select-Object -First 8)
    $apiFailures = [System.Collections.Generic.List[object]]::new()
    foreach ($apiRun in $failedIntakeRuns) {
        $stepSummary = @($apiRun.steps | ForEach-Object { "$($_.id):$($_.status)" }) -join ','
        $synthetic = [ordered]@{
            runId = [string]$apiRun.id
            lastWriteUtc = ([datetime]$apiRun.createdAt).ToUniversalTime().ToString('o')
            handoffPath = $null
            eventPath = $null
            evidence = @("workflow=factory-intake status=failed steps=$stepSummary title=$([string]$apiRun.titleSummary)")
        }
        if (-not (@($result.failures | Where-Object runId -eq $synthetic.runId)).Count) { $apiFailures.Add($synthetic) }
    }
    $result.failures = @(@($apiFailures) + @($result.failures) | Select-Object -First 8)
    $factoryFailures = @($result.failures | Where-Object { (@($_.evidence) -join "`n") -match $factorySignature })
    $intakeFailures = @($factoryFailures | Where-Object { (@($_.evidence) -join "`n") -match '(?i)(factory[- ]intake|intake.*validate|validate.*intake|kind intake)' })
} catch {
    $result.limitations += 'Cezar run API unavailable: ' + $_.Exception.Message
}
if ($RestartFailedIntake -and $intakeFailures.Count -gt 0) {
    $latestFailure = $intakeFailures | Sort-Object lastWriteUtc -Descending | Select-Object -First 1
    try {
        $apiBase = "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))"
        $automations = @(Read-ApiArray "$apiBase/automations" 'automations')
        $intakeAutomation = $automations | Where-Object name -eq '[factory] intake' | Select-Object -First 1
        $runs = @(Read-ApiArray "$apiBase/runs" 'runs')
        $newerIntake = @($runs | Where-Object { $_.workflow -eq 'factory-intake' -and ([datetime]$_.createdAt) -gt ([datetime]$latestFailure.lastWriteUtc) })
        $recentIntake = @($runs | Where-Object { $_.workflow -eq 'factory-intake' } | Sort-Object createdAt -Descending | Select-Object -First 1)
        $cooldownActive = $recentIntake.Count -gt 0 -and $recentIntake[0].status -ne 'failed' -and (([datetime]::UtcNow - [datetime]$recentIntake[0].createdAt).TotalMinutes -lt $RestartCooldownMinutes)
        if ($intakeAutomation -and $newerIntake.Count -eq 0 -and -not $cooldownActive) {
            if ($intakeAutomation.kind -eq 'github') {
                $check = Invoke-RestMethod -Method Post -Uri "$apiBase/automations/$([uri]::EscapeDataString([string]$intakeAutomation.id))/check" -ContentType 'application/json' -Body '{"mode":"execute"}'
                for ($attempt = 0; $attempt -lt 15; $attempt++) {
                    Start-Sleep -Seconds 2
                    $checkState = Invoke-RestMethod -Method Get -Uri "$apiBase/automation-checks/$([uri]::EscapeDataString([string]$check.checkId))"
                    if ($checkState.status -in @('complete','error')) { break }
                }
                $runs = @(Read-ApiArray "$apiBase/runs" 'runs')
                $recovery = @($runs | Where-Object { $_.workflow -eq 'factory-intake' -and ([datetime]$_.createdAt) -gt ([datetime]$latestFailure.lastWriteUtc) } | Sort-Object createdAt -Descending | Select-Object -First 1)
                if ($recovery.Count -gt 0) {
                    $result.restarted = $true
                    $result.restartRunId = $recovery[0].id
                } else { $result.limitations += 'intake check completed but launched no recovery run' }
            } else {
                $restart = Invoke-RestMethod -Method Post -Uri "$apiBase/automations/$([uri]::EscapeDataString([string]$intakeAutomation.id))/run" -ContentType 'application/json' -Body '{}'
                $result.restarted = $true
                $result.restartRunId = $restart.runId
            }
        } elseif ($newerIntake.Count -gt 0) {
            $result.limitations += 'intake restart skipped: a newer intake run already exists'
        } elseif ($cooldownActive) {
            $result.limitations += "intake restart skipped: cooldown of $RestartCooldownMinutes minutes is active"
        } else {
            $result.limitations += 'intake restart skipped: [factory] intake automation was not found'
        }
    } catch { $result.limitations += 'intake restart failed: ' + $_.Exception.Message }
}
if ($CreateIssue -and $factoryFailures.Count -gt 0) {
    $title = if ($intakeFailures.Count -gt 0) { "[Factory audit] factory-intake validation failures in $($result.project)" } else { "[Factory audit] runtime/workflow failures detected in $($result.project)" }
    $existing = @()
    try { $existing = @((& gh issue list --state open --limit 100 --search $title --json number,title 2>$null | ConvertFrom-Json)) } catch { $existing = @() }
    if ($existing.Count -eq 0) {
        $evidenceText = @($factoryFailures | ForEach-Object { "- run $($_.runId): $((@($_.evidence) -join ' | '))" }) -join "`n"
        $body = @(
            "The bounded Factory failure audit detected likely Factory-managed runtime/workflow defects in **$($result.project)**.",
            '',
            "Runs inspected: $($result.runsInspected)",
            "Recovery rerun: $($result.restartRunId)",
            "", $evidenceText,
            '',
            'Acceptance criteria:',
            '- Identify the affected Factory skill, workflow, automation, or runtime contract.',
            '- Fix and validate the Factory source checkout.',
            '- Run the factory-release procedure and synchronize every target in config/factory-projects.json.',
            '- Verify the corrected workflow end to end in this project.'
        ) -join "`n"
        $created = & gh issue create --title $title --body $body --label 'factory:new' --label 'type:maintenance' --label 'risk:medium' 2>&1
        if ($LASTEXITCODE -eq 0) {
            $result.issueCreated = $true
            if (($created -join "`n") -match '/issues/(\d+)') { $result.issueNumber = [int]$Matches[1] }
        } else { $result.limitations += 'could not create GitHub issue: ' + (($created -join ' ').Trim()) }
    } else { $result.limitations += "deduplicated against open issue #$($existing[0].number)" }

    $factoryTitle = if ($intakeFailures.Count -gt 0) { "[Factory audit] intake validation defect affecting $($result.project)" } else { "[Factory audit] Factory-managed runtime defect affecting $($result.project)" }
    $factoryExisting = @()
    try { $factoryExisting = @((& gh issue list --repo $FactoryRepo --state open --limit 100 --search $factoryTitle --json number,title 2>$null | ConvertFrom-Json)) } catch { $factoryExisting = @() }
    if ($factoryExisting.Count -eq 0) {
        $factoryBody = @(
            "The Factory failure audit detected a Factory-managed defect affecting **$($result.project)**.",
            '',
            "Affected project issue: $($result.issueNumber)",
            "Recovery rerun: $($result.restartRunId)",
            "Runs inspected: $($result.runsInspected)",
            '', $evidenceText,
            '',
            'Acceptance criteria:',
            '- Identify and fix the affected Factory skill, workflow, automation, or runtime contract in this repository.',
            '- Validate the Factory source checkout.',
            '- Run factory-release and synchronize every target in config/factory-projects.json.',
            '- Verify the corrected workflow end to end in the affected project.'
        ) -join "`n"
        $factoryCreated = & gh issue create --repo $FactoryRepo --title $factoryTitle --body $factoryBody --label 'factory:new' --label 'type:maintenance' --label 'risk:medium' 2>&1
        if ($LASTEXITCODE -ne 0 -and (($factoryCreated -join ' ') -match '(?i)label.*not found')) {
            $factoryCreated = & gh issue create --repo $FactoryRepo --title $factoryTitle --body $factoryBody 2>&1
        }
        if ($LASTEXITCODE -eq 0) {
            $result.factoryIssueCreated = $true
            if (($factoryCreated -join "`n") -match '/issues/(\d+)') { $result.factoryIssueNumber = [int]$Matches[1] }
        } else { $result.limitations += 'could not create Factory GitHub issue: ' + (($factoryCreated -join ' ').Trim()) }
    } else { $result.limitations += "deduplicated against Factory issue #$($factoryExisting[0].number)" }
}
$result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $output
Write-Output (($result | ConvertTo-Json -Compress -Depth 10))
