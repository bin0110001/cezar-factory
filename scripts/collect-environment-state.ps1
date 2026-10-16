#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$RegistryPath = (Join-Path $PSScriptRoot '..\config\factory-projects.json'),
    [string]$OutputDirectory = '.factory/environment-analysis',
    [int]$HistoryLimit = 50,
    [int]$ApiTimeoutSeconds = 15,
    [string]$Repository
)

$ErrorActionPreference = 'Stop'
if ($HistoryLimit -lt 1 -or $HistoryLimit -gt 100) { throw 'HistoryLimit must be between 1 and 100.' }

$outDir = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$jsonPath = Join-Path $outDir "environment-state-$stamp.json"
$mdPath = Join-Path $outDir "environment-state-$stamp.md"

function Add-Limitation([System.Collections.Generic.List[string]]$List, [string]$Message) {
    if ($Message -and -not $List.Contains($Message)) { $List.Add($Message) }
}
function Invoke-JsonGet([string]$Uri) {
    try {
        return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec $ApiTimeoutSeconds
    } catch {
        throw ($_.Exception.Message)
    }
}
function Get-ArrayProperty($Value, [string]$Property) {
    if ($null -eq $Value) { return @() }
    if ($Value.PSObject.Properties.Name -contains $Property) { return @($Value.$Property) }
    return @($Value)
}
function Invoke-GhJson([string[]]$Arguments) {
    $raw = & gh @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($raw -join ' ').Trim()) }
    if (-not $raw) { return @() }
    return @($raw -join "`n" | ConvertFrom-Json)
}
function Compact([string]$Text, [int]$Max = 240) {
    if ($null -eq $Text) { return $null }
    $value = ($Text -replace '\s+', ' ').Trim()
    if ($value.Length -gt $Max) { return $value.Substring(0, $Max) + '…' }
    return $value
}

$limitations = [System.Collections.Generic.List[string]]::new()
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Repository) {
    try { $Repository = ((& git -C $repoRoot remote get-url origin 2>$null) -join '').Trim() } catch { $Repository = $null }
}
$repoSlug = $null
if ($Repository -match '(?:github\.com[/:])(?<slug>[^/]+/[^/]+?)(?:\.git)?$') { $repoSlug = $Matches.slug }

$registry = @()
if (Test-Path -LiteralPath $RegistryPath) {
    $registry = @(Get-ArrayProperty (Get-Content -Raw $RegistryPath | ConvertFrom-Json) '')
} else {
    Add-Limitation $limitations "target registry not found: $RegistryPath"
}

$workflows = @(Get-ChildItem (Join-Path $repoRoot 'workflows') -Filter '*.yaml' -File -ErrorAction SilentlyContinue | ForEach-Object {
    $content = Get-Content -Raw $_.FullName
    [ordered]@{
        name = $_.BaseName
        path = $_.FullName
        startup = [bool]($content -match 'id:\s+startup')
        commands = @([regex]::Matches($content, '(?m)^\s+command:\s+(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() })
        skills = @([regex]::Matches($content, '(?m)^\s+skill:\s+(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() })
    }
})
$automations = @(Get-ChildItem (Join-Path $repoRoot 'automations') -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    $a = Get-Content -Raw $_.FullName | ConvertFrom-Json
    [ordered]@{ file = $_.Name; name = $a.name; kind = $a.kind; schedule = $a.schedule; workflow = $a.task.workflow; enabled = $a.enabled }
})

$github = [ordered]@{ available = [bool](Get-Command gh -ErrorAction SilentlyContinue); repository = $repoSlug; workflows = @(); runs = @(); schedules = @(); workflowFiles = @(); limitations = @() }
if ($github.available -and $repoSlug) {
    try {
        $github.workflows = @(Invoke-GhJson @('workflow','list','--repo',$repoSlug,'--all','--limit','100','--json','id,name,state,path'))
        $github.runs = @(Invoke-GhJson @('run','list','--repo',$repoSlug,'--limit',[string]$HistoryLimit,'--json','databaseId,workflowName,event,status,conclusion,createdAt,updatedAt,headBranch,headSha,url,displayTitle'))
        $github.schedules = @($github.workflows | ForEach-Object {
            $workflow = $_
            try {
                $detail = Invoke-GhJson @('api',"repos/$repoSlug/actions/workflows/$($workflow.id)")
                [ordered]@{ name = $workflow.name; path = $workflow.path; state = $workflow.state; workflowId = $workflow.id; detail = $detail }
            } catch { [ordered]@{ name = $workflow.name; path = $workflow.path; state = $workflow.state; workflowId = $workflow.id; detail = $null; error = (Compact $_.Exception.Message) } }
        })
    } catch { Add-Limitation $github.limitations ("GitHub history unavailable: " + (Compact $_.Exception.Message)) }
} elseif (-not $github.available) { Add-Limitation $github.limitations 'GitHub CLI (gh) is unavailable.' }
elseif (-not $repoSlug) { Add-Limitation $github.limitations 'GitHub repository could not be derived from origin.' }

$github.workflowFiles = @(Get-ChildItem (Join-Path $repoRoot '.github\workflows') -File -ErrorAction SilentlyContinue | ForEach-Object {
    $content = Get-Content -Raw $_.FullName
    [ordered]@{
        file = $_.Name
        hasSchedule = [bool]($content -match '(?m)^\s{2,}schedule:\s*$')
        scheduleLines = @($content -split "`r?`n" | Where-Object { $_ -match '(?i)cron:|schedule:' } | ForEach-Object { $_.Trim() })
        triggers = @($content -split "`r?`n" | Select-Object -First 20 | Where-Object { $_ -match '^\s{0,4}(push|pull_request|workflow_dispatch|schedule):' } | ForEach-Object { $_.Trim() })
    }
})

$projects = [System.Collections.Generic.List[object]]::new()
foreach ($target in $registry) {
    $projectId = [string]$target.projectId
    $apiUrl = [string]$target.apiUrl
    $entry = [ordered]@{ projectId = $projectId; apiUrl = $apiUrl; projectType = $target.projectType; runs = @(); automations = @(); status = 'limited'; limitations = @() }
    if (-not $apiUrl -or -not $projectId) { $entry.limitations = @('registry entry lacks apiUrl or projectId'); $projects.Add($entry); continue }
    $base = "$($apiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($projectId))"
    try { $entry.runs = @(Get-ArrayProperty (Invoke-JsonGet "$base/runs") 'runs' | Sort-Object createdAt -Descending | Select-Object -First $HistoryLimit) } catch { $entry.limitations += "runs unavailable: $(Compact $_.Exception.Message)" }
    try { $entry.automations = @(Get-ArrayProperty (Invoke-JsonGet "$base/automations") 'automations') } catch { $entry.limitations += "automations unavailable: $(Compact $_.Exception.Message)" }
    $entry.status = if ($entry.runs.Count -gt 0 -or $entry.automations.Count -gt 0) { 'ready' } else { 'limited' }
    $projects.Add($entry)
}
if ($registry.Count -eq 0) { Add-Limitation $limitations 'No configured Factory targets were available for collection.' }

$local = [ordered]@{
    branch = ((& git -C $repoRoot branch --show-current 2>$null) -join '').Trim()
    commit = ((& git -C $repoRoot rev-parse HEAD 2>$null) -join '').Trim()
    status = @((& git -C $repoRoot status --short 2>$null) | Select-Object -First 100)
    version = (Get-Content (Join-Path $repoRoot 'VERSION') -Raw).Trim()
    workflowCount = $workflows.Count
    automationCount = $automations.Count
}

$result = [ordered]@{
    schemaVersion = 1
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    repository = $repoSlug
    local = $local
    factory = [ordered]@{ workflows = $workflows; automations = $automations }
    github = $github
    projects = @($projects)
    limitations = @($limitations)
}
$result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $jsonPath -Encoding utf8

$allRuns = @($projects | ForEach-Object { $_.runs })
$failedRuns = @($allRuns | Where-Object { $_.status -in @('failed','error','cancelled','canceled') -or $_.conclusion -in @('failure','cancelled','timed_out') })
$ghFailed = @($github.runs | Where-Object { $_.conclusion -in @('failure','cancelled','timed_out') -or $_.status -in @('failure','cancelled') })
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# Factory environment state')
$lines.Add('')
$lines.Add("Collected: $($result.collectedAt)  |  Repository: $($repoSlug ?? 'unknown')  |  Factory version: $($local.version)")
$lines.Add('')
$lines.Add('## Snapshot')
$lines.Add('')
$lines.Add("- Configured Cezar targets: $($registry.Count)")
$lines.Add("- Factory workflows / automations: $($workflows.Count) / $($automations.Count)")
$lines.Add("- Cezar runs collected / failed: $($allRuns.Count) / $($failedRuns.Count)")
$lines.Add("- GitHub runs collected / failed: $($github.runs.Count) / $($ghFailed.Count)")
$lines.Add("- Local worktree changes: $($local.status.Count)")
$lines.Add('')
$lines.Add('## Cezar targets')
$lines.Add('')
foreach ($project in $projects) { $lines.Add("- **$($project.projectId)** — $($project.status); runs=$(@($project.runs).Count), automations=$(@($project.automations).Count), limitations=$(@($project.limitations).Count)") }
$lines.Add('')
$lines.Add('## Failure leads')
$lines.Add('')
foreach ($run in @($failedRuns | Select-Object -First 20)) { $lines.Add("- Cezar `$($run.id)` — workflow=$($run.workflow), status=$($run.status), created=$($run.createdAt), title=$(Compact ([string]$run.titleSummary))") }
foreach ($run in @($ghFailed | Select-Object -First 20)) { $lines.Add("- GitHub `$($run.databaseId)` — workflow=$($run.workflowName), conclusion=$($run.conclusion), created=$($run.createdAt), title=$(Compact ([string]$run.displayTitle))") }
if ($failedRuns.Count -eq 0 -and $ghFailed.Count -eq 0) { $lines.Add('- No failures were present in the bounded history, or the history endpoints were unavailable.') }
$lines.Add('')
$lines.Add('## Limitations')
$lines.Add('')
foreach ($item in @($limitations + $github.limitations + ($projects | ForEach-Object { $_.limitations })) | Where-Object { $_ }) { $lines.Add("- $item") }
$lines.Add('')
$lines.Add(('Machine-readable export: ' + [IO.Path]::GetFileName($jsonPath)))
$lines -join "`n" | Set-Content -LiteralPath $mdPath -Encoding utf8

[ordered]@{ status = 'ready'; json = $jsonPath; markdown = $mdPath; projects = $registry.Count; cezarRuns = $allRuns.Count; cezarFailures = $failedRuns.Count; githubRuns = $github.runs.Count; githubFailures = $ghFailed.Count; limitations = @($limitations + $github.limitations) } | ConvertTo-Json -Compress -Depth 8
