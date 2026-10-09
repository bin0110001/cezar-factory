#!/usr/bin/env pwsh
<#
.SYNOPSIS
Reconcile the factory's automation definitions (.ai/factory/automations/*.json) with a running Cezar cockpit.
.DESCRIPTION
Cezar keeps live automations in a gitignored store managed through its HTTP API, so the definitions are
declarative files here and this script converges the cockpit onto them:
  - creates missing automations (paused unless -Enable),
  - updates factory-managed ones whose definition changed (enabled state is preserved),
  - pauses factory-managed ones that are no longer wanted (deletes them with -Prune),
  - never touches an automation whose name does not start with "[factory] ".
Needs CEZ_API_URL and CEZ_PROJECT_ID (or -ApiUrl/-ProjectId); Cezar must run with CEZ_AUTOMATIONS=1.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = '',
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..'),
    [string]$ApiUrl = $env:CEZ_API_URL,
    [string]$ProjectId = $env:CEZ_PROJECT_ID,
    [switch]$SourceOnly,
    # Remote-only (-SourceOnly) sync cannot see the project's config; definitions with factoryRequires.projectType apply only when this matches.
    [string]$ProjectType = '',
    [switch]$Enable,
    [switch]$Prune,
    [switch]$DryRun
)
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$prefix = '[factory] '

if (-not $ApiUrl) { throw 'CEZ_API_URL (or -ApiUrl) is required' }
$scope = if ($ProjectId) { "$($ApiUrl.TrimEnd('/'))/api/v1/p/$([uri]::EscapeDataString($ProjectId))" } else { "$($ApiUrl.TrimEnd('/'))/api/v1" }
if ($SourceOnly) {
    $sourceRoot = (Resolve-Path $FactoryPath).Path
    $automationDir = Join-Path $sourceRoot 'automations'
    $version = (Get-Content -Raw (Join-Path $sourceRoot 'VERSION')).Trim()
    $logFile = $null
} else {
    if (-not $ProjectPath) { throw 'ProjectPath is required unless -SourceOnly is used.' }
    $fdir = Join-Path $ProjectPath '.ai/factory'
    $automationDir = Join-Path $fdir 'automations'
    $version = if (Test-Path (Join-Path $fdir 'VERSION')) { (Get-Content -Raw (Join-Path $fdir 'VERSION')).Trim() } else { 'unknown' }
    $logFile = Join-Path $ProjectPath '.factory/automation-sync.log'
}

function Log([string]$Msg) {
    Write-Host $Msg
    if (-not $DryRun -and $logFile) {
        New-Item -ItemType Directory -Force (Split-Path $logFile) | Out-Null
        Add-Content $logFile "$(Get-Date -Format s) $Msg"
    }
}
function Api([string]$Method, [string]$Url, $Body) {
    $p = @{ Method = $Method; Uri = $Url; ContentType = 'application/json' }
    if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 20) }
    Invoke-RestMethod @p
}
# True when every key in $Want is present and equal in $Have (the cockpit adds defaults we don't specify).
function Test-Subset($Want, $Have) {
    if ($Want -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $Want.PSObject.Properties) {
            if (-not $Have -or -not ($Have.PSObject.Properties.Name -contains $p.Name)) { return $false }
            if (-not (Test-Subset $p.Value $Have.($p.Name))) { return $false }
        }
        return $true
    }
    if ($Want -is [array]) {
        if (@($Have).Count -ne $Want.Count) { return $false }
        for ($i = 0; $i -lt $Want.Count; $i++) { if (-not (Test-Subset $Want[$i] @($Have)[$i])) { return $false } }
        return $true
    }
    "$Want" -eq "$Have"
}

$wanted = @{}
foreach ($f in Get-ChildItem $automationDir -Filter *.json -ErrorAction SilentlyContinue) {
    $def = Get-Content -Raw $f.FullName | ConvertFrom-Json
    if (-not $def.name.StartsWith($prefix)) { throw "$($f.Name): factory automation names must start with '$prefix'" }
    if ($def.PSObject.Properties.Name -contains 'factoryRequires') {
        $required = [string]$def.factoryRequires.projectType
        $def.PSObject.Properties.Remove('factoryRequires')
        if ($SourceOnly -and $required -and $required -ne $ProjectType) { continue }
    }
    $def.description = "$($def.description) [cezar-factory $version]"
    $wanted[$def.name] = $def
}

$list = Api GET "$scope/automations" $null
if ($list.PSObject.Properties.Name -contains 'available' -and -not $list.available) { throw "Cezar automations unavailable: $($list.reason)" }
$existing = @{}
foreach ($a in @($list.automations)) { if ($a.name.StartsWith($prefix)) { $existing[$a.name] = $a } }

$created = 0; $updated = 0; $unchanged = 0; $retired = 0
foreach ($name in ($wanted.Keys | Sort-Object)) {
    $def = $wanted[$name]
    if (-not $existing.ContainsKey($name)) {
        Log "create  $name$(if ($DryRun) { ' [dry-run]' })"
        if (-not $DryRun) {
            $body = $def | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
            if ($Enable) { $body.enable = $true }
            Api POST "$scope/automations" $body | Out-Null
        }
        $created++; continue
    }
    $cur = (Api GET "$scope/automations/$([uri]::EscapeDataString($existing[$name].id))" $null).automation
    $same = $true
    foreach ($k in 'description', 'kind', 'events', 'intervalSeconds', 'filters', 'schedule', 'task') {
        if ($def.PSObject.Properties.Name -contains $k -and -not (Test-Subset $def.$k $cur.$k)) { $same = $false }
    }
    if ($same) { $unchanged++; continue }
    Log "update  $name$(if ($DryRun) { ' [dry-run]' })"
    if (-not $DryRun) {
        $body = $def | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
        $body.enabled = [bool]$cur.enabled
        $body.expectedRevision = $cur.revision
        Api PUT "$scope/automations/$([uri]::EscapeDataString($cur.id))" $body | Out-Null
    }
    $updated++
}
foreach ($name in ($existing.Keys | Where-Object { -not $wanted.ContainsKey($_) } | Sort-Object)) {
    $a = $existing[$name]
    if ($Prune) {
        Log "delete  $name$(if ($DryRun) { ' [dry-run]' })"
        if (-not $DryRun) { Api DELETE "$scope/automations/$([uri]::EscapeDataString($a.id))" $null | Out-Null }
        $retired++
    }
    elseif ($a.enabled) {
        Log "pause   $name (obsolete)$(if ($DryRun) { ' [dry-run]' })"
        if (-not $DryRun) {
            $cur = (Api GET "$scope/automations/$([uri]::EscapeDataString($a.id))" $null).automation
            $body = @{ enabled = $false; expectedRevision = $cur.revision }
            foreach ($k in 'name', 'description', 'kind', 'events', 'intervalSeconds', 'filters', 'schedule', 'task') { if ($null -ne $cur.$k) { $body[$k] = $cur.$k } }
            Api PUT "$scope/automations/$([uri]::EscapeDataString($a.id))" $body | Out-Null
        }
        $retired++
    }
}
Log "automations: $created created, $updated updated, $unchanged unchanged, $retired retired"
