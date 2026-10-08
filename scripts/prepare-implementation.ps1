#!/usr/bin/env pwsh
<##
.SYNOPSIS
Prepares a bounded, worktree-local implementation context for one GitHub issue.

.DESCRIPTION
Fetches the selected issue through the authenticated GitHub CLI and records the
issue, nearest project instructions, repository state, and available project
tooling. This script does not edit source files or lifecycle labels.
##>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$Issue,
    [string]$GhCommand = 'gh',
    [string]$OutputPath = '.factory/implementation-context.json'
)

$ErrorActionPreference = 'Stop'

function Invoke-Gh([string[]]$Arguments) {
    $output = & $GhCommand @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh $($Arguments -join ' ') failed ($LASTEXITCODE): $($output -join "`n")"
    }
    [string]::Join("`n", [string[]]$output)
}

function Get-RepoRoot {
    $root = & git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($root -join ''))) { return $null }
    (Resolve-Path ([string]($root -join '').Trim())).Path
}

function Get-Instructions([string]$StartPath) {
    $items = @()
    $current = (Resolve-Path $StartPath).Path
    while ($current) {
        $candidate = Join-Path $current 'AGENTS.md'
        if (Test-Path $candidate) {
            $items += [ordered]@{ path = $candidate; content = [IO.File]::ReadAllText($candidate) }
        }
        $parent = Split-Path $current -Parent
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
    @($items)
}

function Get-Tooling([string]$Root) {
    $names = @('package.json','package-lock.json','pnpm-lock.yaml','yarn.lock',
        'pyproject.toml','requirements.txt','go.mod','Cargo.toml','Gemfile',
        '*.sln','*.slnx','*.csproj','Makefile','justfile')
    $files = @()
    foreach ($name in $names) {
        $files += @(Get-ChildItem -LiteralPath $Root -Filter $name -File -Force -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName)
    }
    @($files | Sort-Object -Unique)
}

$issueJson = Invoke-Gh @('issue','view',[string]$Issue,'--json','number,title,body,labels,comments,url,state')
$issueRecord = $issueJson | ConvertFrom-Json
if ([int]$issueRecord.number -ne $Issue) { throw "GitHub returned issue $($issueRecord.number), expected $Issue." }

$repoRoot = Get-RepoRoot
$workingDirectory = (Get-Location).Path
$context = [ordered]@{
    schemaVersion = 1
    preparedAt = (Get-Date).ToUniversalTime().ToString('o')
    issue = $issueRecord
    environment = [ordered]@{
        workingDirectory = $workingDirectory
        repositoryRoot = $repoRoot
        gitBranch = if ($repoRoot) { (& git -C $repoRoot branch --show-current 2>$null) -join '' } else { $null }
        gitStatus = if ($repoRoot) { @(& git -C $repoRoot status --short 2>$null) } else { @() }
        factoryRuntimeRoot = if ($env:FACTORY_RUNTIME_ROOT) { $env:FACTORY_RUNTIME_ROOT } else { $null }
        tools = [ordered]@{ git = [bool](Get-Command git -ErrorAction SilentlyContinue); gh = [bool](Get-Command $GhCommand -ErrorAction SilentlyContinue); pwsh = [bool](Get-Command pwsh -ErrorAction SilentlyContinue) }
        toolingFiles = if ($repoRoot) { Get-Tooling $repoRoot } else { @() }
    }
    instructions = Get-Instructions $workingDirectory
    handoff = [ordered]@{
        sourceOfTruth = 'issue and approved plan in issue.body/comments'
        implementationMustRead = @('This context artifact','The nearest applicable AGENTS.md files','The issue body and comments, including acceptance criteria and non-goals')
        generatedBy = 'scripts/prepare-implementation.ps1'
    }
}

$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$context | ConvertTo-Json -Depth 12 | Set-Content -Path $OutputPath -Encoding utf8
Write-Output ($context | ConvertTo-Json -Depth 12)
