#!/usr/bin/env pwsh
<##
.SYNOPSIS
Idempotently prepare a GitHub repository for Factory management.

.DESCRIPTION
Creates the integration branch, ensures Factory labels, registers the project in
the host-local Cezar target registry, and optionally seeds a bounded number of
open issues with factory:new. It never merges, enables live automations, or
dispatches work; those actions remain behind the validated Factory release gate.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [string]$CezarApiUrl = 'http://192.168.86.69:4321',
    [string]$ProjectId = '',
    [ValidateSet('generic', 'godot')][string]$ProjectType = 'generic',
    [string]$TargetsPath = (Join-Path $PSScriptRoot '../config/factory-projects.json'),
    [string]$GhCommand = 'gh',
    [switch]$SeedOpenIssues,
    [ValidateRange(0, 100)][int]$MaxSeedIssues = 3,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Gh([string[]]$Arguments) {
    $output = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh $($Arguments -join ' ') failed ($LASTEXITCODE): $($output -join "`n")" }
    $output
}

function Invoke-GhJson([string[]]$Arguments) {
    $raw = (Invoke-Gh $Arguments) -join "`n"
    if (-not $raw.Trim()) { return $null }
    $raw | ConvertFrom-Json
}

function Get-RepoName([string]$Value) {
    $candidate = $Value.Trim() -replace '\.git$', ''
    if ($candidate -match '^https?://github\.com/(?<repo>[^/]+/[^/#]+)') { $candidate = $Matches.repo }
    elseif ($candidate -match '^git@github\.com:(?<repo>[^/]+/[^/]+)$') { $candidate = $Matches.repo }
    if ($candidate -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Repo must be owner/name or a GitHub URL, got '$Value'." }
    $candidate
}

function Add-Label([string]$Name, [string]$Color, [string]$Description) {
    $args = @('label', 'create', $Name, '--repo', $script:repo, '--color', $Color, '--description', $Description, '--force')
    if ($DryRun) { Write-Host "[DRY-RUN] gh $($args -join ' ')"; return }
    Invoke-Gh $args | Out-Null
}

$script:repo = Get-RepoName $Repo
$projectId = if ($ProjectId) { $ProjectId } else { ($script:repo -split '/')[1] }
$metadata = Invoke-GhJson @('repo', 'view', $script:repo, '--json', 'nameWithOwner,defaultBranchRef,isEmpty')
if (-not $metadata -or $metadata.nameWithOwner -ne $script:repo) { throw "Could not resolve GitHub repository '$script:repo'." }
if ($metadata.isEmpty) { throw "Repository '$script:repo' is empty; create its default branch before onboarding." }
$defaultBranch = [string]$metadata.defaultBranchRef.name
if (-not $defaultBranch) { throw "Repository '$script:repo' has no default branch." }

$summary = [ordered]@{
    repo = $script:repo
    projectId = $projectId
    defaultBranch = $defaultBranch
    integrationBranch = 'dev'
    devBranch = 'unchanged'
    labels = 'pending'
    registered = 'pending'
    seededIssues = @()
    dryRun = [bool]$DryRun
}

$devRefArgs = @('api', "repos/$script:repo/git/ref/heads/dev")
$devExists = $true
try { Invoke-Gh $devRefArgs | Out-Null } catch { $devExists = $false }
if (-not $devExists) {
    $defaultRef = Invoke-GhJson @('api', "repos/$script:repo/git/ref/heads/$defaultBranch")
    if ($DryRun) { Write-Host "[DRY-RUN] gh api repos/$script:repo/git/refs --method POST -f ref=refs/heads/dev -f sha=$($defaultRef.object.sha)" }
    else { Invoke-Gh @('api', "repos/$script:repo/git/refs", '--method', 'POST', '--raw-field', 'ref=refs/heads/dev', '--raw-field', "sha=$($defaultRef.object.sha)") | Out-Null }
    $summary.devBranch = 'created'
}

$labelSpec = @(
    @('factory:new', '1d76db', 'Factory: newly filed, not yet triaged'),
    @('factory:needs-plan', '1d76db', 'Factory: ready for the planning agent'),
    @('factory:needs-help', '1d76db', 'Factory: a human decision or input is needed'),
    @('factory:ready', '1d76db', 'Factory: planned and ready for implementation'),
    @('factory:working', '1d76db', 'Factory: implementation in progress'),
    @('factory:review', '1d76db', 'Factory: PR awaiting independent review'),
    @('factory:changes-requested', '1d76db', 'Factory: review requested changes'),
    @('factory:human-review', '1d76db', 'Factory: awaiting human review / merge'),
    @('factory:blocked', '1d76db', 'Factory: blocked by an external dependency'),
    @('factory:done', '1d76db', 'Factory: complete'),
    @('factory:investigate', '1d76db', 'Factory: repeated failure awaiting investigation'),
    @('type:bug', '0e8a16', 'Factory issue type'), @('type:feature', '0e8a16', 'Factory issue type'),
    @('type:refactor', '0e8a16', 'Factory issue type'), @('type:test', '0e8a16', 'Factory issue type'),
    @('type:docs', '0e8a16', 'Factory issue type'), @('type:maintenance', '0e8a16', 'Factory issue type'),
    @('risk:low', '0e8a16', 'Factory risk'), @('risk:medium', 'fbca04', 'Factory risk'), @('risk:high', 'b60205', 'Factory risk'),
    @('complexity:small', 'd4c5f9', 'Factory complexity'), @('complexity:medium', 'd4c5f9', 'Factory complexity'), @('complexity:large', 'd4c5f9', 'Factory complexity')
)
foreach ($spec in $labelSpec) { Add-Label $spec[0] $spec[1] $spec[2] }
$summary.labels = if ($DryRun) { 'would-ensure' } else { 'ensured' }

$targets = @()
if (Test-Path -LiteralPath $TargetsPath) { $targets = @(Get-Content -Raw -LiteralPath $TargetsPath | ConvertFrom-Json) }
$existing = @($targets | Where-Object { $_.projectId -eq $projectId })
$entry = [ordered]@{
    apiUrl = $CezarApiUrl.TrimEnd('/')
    projectId = $projectId
    deployment = [ordered]@{ mode = 'remote-cezar-plus-bazzite-host'; bazziteSshTarget = 'bazzite'; bazziteAddress = '192.168.86.69'; litellmConfigPath = '/var/home/bin0110001/cezar-factory-litellm-config.yaml'; fullFactoryProjectPath = 'not-configured-on-windows' }
}
if ($ProjectType -eq 'godot') { $entry.projectType = 'godot' }
if (-not $existing) { $targets += [pscustomobject]$entry } else { $targets = @($targets | Where-Object { $_.projectId -ne $projectId }) + [pscustomobject]$entry }
if ($DryRun) { Write-Host "[DRY-RUN] Would register $projectId in $TargetsPath"; $summary.registered = 'would-register' }
else { $targets | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $TargetsPath -Encoding utf8; $summary.registered = if ($existing) { 'updated' } else { 'created' } }

if ($SeedOpenIssues) {
    $limit = if ($MaxSeedIssues -eq 0) { 100 } else { $MaxSeedIssues }
    $issues = @(Invoke-GhJson @('issue', 'list', '--repo', $script:repo, '--state', 'open', '--limit', [string]$limit, '--json', 'number,labels'))
    foreach ($issue in $issues) {
        $names = @($issue.labels | ForEach-Object { [string]$_.name })
        if ($names -contains 'factory:new' -or @($names | Where-Object { $_ -like 'factory:*' }).Count) { continue }
        if ($DryRun) { Write-Host "[DRY-RUN] Would add factory:new to issue #$($issue.number)" }
        else { Invoke-Gh @('issue', 'edit', [string]$issue.number, '--repo', $script:repo, '--add-label', 'factory:new') | Out-Null }
        $summary.seededIssues += [int]$issue.number
    }
}

$summary | ConvertTo-Json -Depth 8 -Compress
