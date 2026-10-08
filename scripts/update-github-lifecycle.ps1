#!/usr/bin/env pwsh
<##
.SYNOPSIS
Sets the Factory labels on one GitHub issue and, when requested, retriggers its next automation.

.DESCRIPTION
This is the operator-facing lifecycle updater. It updates classification and complexity labels
before the lifecycle label, so a downstream automation sees a complete routing envelope. Lifecycle
states are mutually exclusive. If the requested state is already present, -Retrigger removes it
and adds it back in separate GitHub edits; the add is the event consumed by Cezar.

The script intentionally does not post comments, change issue text, or dispatch Cezar directly.
Manual-gate states remain labels only and therefore do not launch an automatic workflow.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$Issue,
    [Parameter(Mandatory)][ValidateSet(
        'factory:new','factory:needs-plan','factory:needs-help','factory:ready',
        'factory:working','factory:review','factory:changes-requested','factory:human-review',
        'factory:blocked','factory:done','factory:investigate')][string]$State,
    [ValidateSet('type:bug','type:feature','type:refactor','type:test','type:docs','type:maintenance')][string]$Type,
    [ValidateSet('risk:low','risk:medium','risk:high')][string]$Risk,
    [ValidateSet('complexity:small','complexity:medium','complexity:large')][string]$Complexity,
    [switch]$Retrigger,
    [switch]$AllowUnroutable,
    [string]$GhCommand = 'gh',
    [string]$PoliciesDir = (Join-Path $PSScriptRoot '../policies')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Output (@{ status = 'refused'; issue = $Issue; state = $State; reason = $Message } | ConvertTo-Json -Compress)
    exit 1
}

function Invoke-Gh {
    $output = & $GhCommand @args
    if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') failed ($LASTEXITCODE)" }
    $output
}

function Read-LabelGroup([string]$Section) {
    $values = @()
    $inside = $false
    foreach ($line in Get-Content (Join-Path $PoliciesDir 'labels.yaml')) {
        if ($line -match "^$([regex]::Escape($Section)):") { $inside = $true; continue }
        if ($inside -and $line -match '^\s+-\s+(\S+)') { $values += $Matches[1]; continue }
        if ($inside -and $line -match '^\S') { break }
    }
    if (-not $values.Count) { throw "Could not read '$Section' labels from policies/labels.yaml" }
    $values
}

$stateLabels = @(Read-LabelGroup 'factory-state')
$typeLabels = @(Read-LabelGroup 'type')
$riskLabels = @(Read-LabelGroup 'risk')
$complexityLabels = @(Read-LabelGroup 'complexity')

if ($Type -and $typeLabels -notcontains $Type) { Fail "Unknown type label '$Type'." }
if ($Risk -and $riskLabels -notcontains $Risk) { Fail "Unknown risk label '$Risk'." }
if ($Complexity -and $complexityLabels -notcontains $Complexity) { Fail "Unknown complexity label '$Complexity'." }
if ($State -eq 'factory:ready' -and -not $Complexity -and -not $AllowUnroutable) {
    Fail 'factory:ready requires -Complexity so an active implementation automation can route it; use -AllowUnroutable only for an intentional exception.'
}

$view = Invoke-Gh issue view $Issue --json 'labels,title,url,state' | ConvertFrom-Json
$labels = @($view.labels | ForEach-Object { [string]$_.name })
$issueTitle = if ($view.PSObject.Properties.Name -contains 'title') { [string]$view.title } else { '' }
$currentStates = @($labels | Where-Object { $stateLabels -contains $_ })
$currentTypes = @($labels | Where-Object { $typeLabels -contains $_ })
$currentRisks = @($labels | Where-Object { $riskLabels -contains $_ })
$currentComplexities = @($labels | Where-Object { $complexityLabels -contains $_ })

function Edit-Labels([string[]]$Add, [string[]]$Remove) {
    $args = @('issue','edit',[string]$Issue)
    if (@($Add).Count) { $args += @('--add-label', (($Add | Select-Object -Unique) -join ',')) }
    if (@($Remove).Count) { $args += @('--remove-label', (($Remove | Select-Object -Unique) -join ',')) }
    if ($args.Count -gt 3) { Invoke-Gh @args | Out-Null }
}

function Replace-Group([string[]]$Current, [string]$Desired, [string]$GroupName) {
    if (-not $Desired) { return }
    $remove = @($Current | Where-Object { $_ -ne $Desired })
    if ($Current -notcontains $Desired -or $remove.Count) { Edit-Labels @($Desired) $remove }
}

# First make all routing dimensions true, then emit the lifecycle event last.
Replace-Group $currentTypes $Type 'type'
Replace-Group $currentRisks $Risk 'risk'
Replace-Group $currentComplexities $Complexity 'complexity'

$removeStates = @($currentStates | Where-Object { $_ -ne $State })
if ($removeStates.Count) { Edit-Labels @() $removeStates }

if ($currentStates -contains $State) {
    if ($Retrigger) {
        Edit-Labels @() @($State)
        Edit-Labels @($State) @()
        $triggered = $true
    } else {
        $triggered = $false
    }
} else {
    Edit-Labels @($State) @()
    $triggered = $true
}

@{
    status = 'ok'
    issue = $Issue
    title = $issueTitle
    state = $State
    type = if ($Type) { $Type } else { $null }
    risk = if ($Risk) { $Risk } else { $null }
    complexity = if ($Complexity) { $Complexity } else { $null }
    retriggered = [bool]$triggered
    note = if ($triggered) { 'Lifecycle label added last; Cezar can consume the issue.labeled event.' } else { 'State already matched and -Retrigger was not supplied.' }
} | ConvertTo-Json -Compress
