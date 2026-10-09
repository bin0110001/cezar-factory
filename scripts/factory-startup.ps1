#!/usr/bin/env pwsh
<##
.SYNOPSIS
Performs the bounded environment check shared by every Factory workflow.

.DESCRIPTION
Validates the registered Factory runtime, required commands, and workflow-specific
runtime scripts before an agent or task command starts. Writes a small worktree-local
startup receipt without exposing credentials or issue contents.
##>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Workflow,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Step,
    [string]$FactoryRuntimeRoot = $env:FACTORY_RUNTIME_ROOT,
    [switch]$RequireGh,
    [string[]]$RequiredScripts = @(),
    [string]$OutputPath = ".factory/startup/$Workflow-$Step.json"
)

# IMPORTANT: Factory workflow commands run inside the Cezar Linux container.
# FACTORY_RUNTIME_ROOT is therefore a container path (normally
# /projects/cezar-factory), even when the checkout is maintained on Windows.
# Do not translate this path to a Windows drive; repair the container mount.

$ErrorActionPreference = 'Stop'

# Cezar supplies command arguments as shell text. A YAML value such as
# "a.ps1,b.ps1" therefore reaches PowerShell as one argument rather than an
# array. Normalize both forms before validating files or writing the receipt.
$RequiredScripts = @($RequiredScripts | ForEach-Object {
    @($_ -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
})

function Fail([string]$Code, [string]$Message) {
    $result = [ordered]@{
        ok = $false
        code = $Code
        message = $Message
        workflow = $Workflow
        step = $Step
    }
    $result | ConvertTo-Json -Depth 8 -Compress
    exit 1
}

try {
    if ([string]::IsNullOrWhiteSpace($FactoryRuntimeRoot)) {
        $FactoryRuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    } else {
        $FactoryRuntimeRoot = (Resolve-Path -LiteralPath $FactoryRuntimeRoot -ErrorAction Stop).Path
    }

    $scriptsRoot = Join-Path $FactoryRuntimeRoot 'scripts'
    if (-not (Test-Path -LiteralPath $scriptsRoot -PathType Container)) {
        Fail 'RUNTIME_ROOT_INVALID' "Factory runtime scripts directory was not found: $scriptsRoot"
    }

    foreach ($script in $RequiredScripts) {
        if ([IO.Path]::IsPathRooted($script) -or $script.Contains('..')) {
            Fail 'REQUIRED_SCRIPT_INVALID' "Required runtime script must be relative: $script"
        }
        $path = Join-Path $scriptsRoot $script
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Fail 'REQUIRED_SCRIPT_MISSING' "Required runtime script was not found: $path"
        }
    }

    $tools = [ordered]@{
        pwsh = [bool](Get-Command pwsh -ErrorAction SilentlyContinue)
        git = [bool](Get-Command git -ErrorAction SilentlyContinue)
        gh = [bool](Get-Command gh -ErrorAction SilentlyContinue)
    }
    if (-not $tools.pwsh) { Fail 'PWSH_MISSING' 'PowerShell is unavailable in the Factory runtime.' }
    if (-not $tools.git) { Fail 'GIT_MISSING' 'Git is unavailable in the Factory runtime.' }
    if ($RequireGh -and -not $tools.gh) { Fail 'GH_MISSING' 'GitHub CLI is required but unavailable in the Factory runtime.' }

    $repoRoot = $null
    $branch = $null
    if ($tools.git) {
        $candidate = (& git rev-parse --show-toplevel 2>$null) -join ''
        if ($LASTEXITCODE -eq 0 -and $candidate) {
            $repoRoot = (Resolve-Path $candidate.Trim()).Path
            $branch = (& git -C $repoRoot branch --show-current 2>$null) -join ''
        }
    }

    $directory = Split-Path -Parent $OutputPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $result = [ordered]@{
        ok = $true
        code = 'READY'
        workflow = $Workflow
        step = $Step
        preparedAt = (Get-Date).ToUniversalTime().ToString('o')
        workingDirectory = (Get-Location).Path
        repositoryRoot = $repoRoot
        gitBranch = $branch
        factoryRuntimeRoot = $FactoryRuntimeRoot
        requiredScripts = @($RequiredScripts)
        tools = $tools
    }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
    $result | ConvertTo-Json -Depth 8 -Compress
    exit 0
} catch {
    Fail 'STARTUP_EXCEPTION' $_.Exception.Message
}
