[CmdletBinding()]
param(
    [string] $FactoryRuntimeRoot = $env:FACTORY_RUNTIME_ROOT,
    [string] $ProjectId,
    [string] $RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Fail([string] $Code, [string] $Message) {
    $result = [ordered]@{
        ok = $false
        code = $Code
        message = $Message
        repositoryRoot = $RepositoryRoot
    }
    $result | ConvertTo-Json -Depth 8 -Compress
    exit 1
}

try {
    $repo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
    $registryPath = Join-Path $repo 'config/factory-projects.json'
    if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
        Fail 'TARGET_REGISTRY_MISSING' "Required target registry is missing: $registryPath"
    }

    try {
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    } catch {
        Fail 'TARGET_REGISTRY_INVALID' "Target registry is not valid JSON: $registryPath"
    }

    $targets = if ($registry -is [System.Array]) {
        @($registry)
    } elseif ($registry.projects) {
        @($registry.projects)
    } elseif ($registry.targets) {
        @($registry.targets)
    } else {
        @()
    }
    if ($targets.Count -eq 0) {
        Fail 'TARGETS_EMPTY' 'Target registry contains no configured projects.'
    }

    if ([string]::IsNullOrWhiteSpace($FactoryRuntimeRoot)) {
        $localRuntime = Join-Path $repo '.ai/factory'
        $checkoutRuntime = Join-Path $repo 'scripts'
        if (Test-Path -LiteralPath (Join-Path $localRuntime 'scripts/route-state.ps1') -PathType Leaf) {
            $FactoryRuntimeRoot = $localRuntime
        } elseif (Test-Path -LiteralPath (Join-Path $checkoutRuntime 'route-state.ps1') -PathType Leaf) {
            # The Factory checkout is also a valid runtime when running before
            # installation into a target project.
            $FactoryRuntimeRoot = $repo
        } else {
            $FactoryRuntimeRoot = $localRuntime
        }
    }
    if (-not (Test-Path -LiteralPath $FactoryRuntimeRoot -PathType Container)) {
        Fail 'RUNTIME_ROOT_MISSING' "Factory runtime root was not found: $FactoryRuntimeRoot"
    }
    $runtime = (Resolve-Path -LiteralPath $FactoryRuntimeRoot).Path

    $routeCandidates = @(
        (Join-Path $runtime 'scripts/route-state.ps1'),
        (Join-Path $runtime 'route-state.ps1'),
        (Join-Path $runtime 'scripts/factory/route-state.ps1')
    )
    $routeState = $routeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $routeState) {
        Fail 'ROUTE_STATE_MISSING' "Could not find route-state.ps1 under the configured runtime root: $runtime"
    }

    $selected = if ([string]::IsNullOrWhiteSpace($ProjectId)) {
        if ($targets.Count -ne 1) { Fail 'TARGET_AMBIGUOUS' 'Multiple targets are configured; provide -ProjectId.' }
        $targets[0]
    } else {
        @($targets | Where-Object { $_.projectId -eq $ProjectId })
    }
    if (@($selected).Count -ne 1) {
        Fail 'TARGET_NOT_FOUND' "No unique target matched projectId '$ProjectId'."
    }
    $target = @($selected)[0]

    if ([string]::IsNullOrWhiteSpace([string]$target.apiUrl) -or
        [string]::IsNullOrWhiteSpace([string]$target.projectId)) {
        Fail 'TARGET_INVALID' 'Selected target must define both apiUrl and projectId.'
    }
    if ($target.projectPath) {
        if (-not [IO.Path]::IsPathRooted([string]$target.projectPath) -or
            -not [string]$target.projectPath.StartsWith(($env:SystemDrive + '\'), [StringComparison]::OrdinalIgnoreCase)) {
            Fail 'PROJECT_PATH_INVALID' 'projectPath must be an existing absolute Windows host path.'
        }
        if (-not (Test-Path -LiteralPath $target.projectPath -PathType Container)) {
            Fail 'PROJECT_PATH_MISSING' "Configured projectPath does not exist: $($target.projectPath)"
        }
    }

    [ordered]@{
        ok = $true
        code = 'READY'
        repositoryRoot = $repo
        runtimeRoot = $runtime
        routeStateScript = (Resolve-Path -LiteralPath $routeState).Path
        target = [ordered]@{ apiUrl = [string]$target.apiUrl; projectId = [string]$target.projectId }
        nextStep = 'Invoke the Factory route-state workflow, then start factory-impliment.'
    } | ConvertTo-Json -Depth 8 -Compress
    exit 0
} catch {
    Fail 'PREFLIGHT_EXCEPTION' $_.Exception.Message
}
