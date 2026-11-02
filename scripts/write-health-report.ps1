#!/usr/bin/env pwsh
<#
.SYNOPSIS
Writes the deterministic factory-health report from the workflow's own artifacts.

.DESCRIPTION
Pure summarizer: reads the failure-audit collector artifact, the publisher receipt, and the
dry-run backlog reconciliation, then writes .factory/health-report.json and a sibling .md.
It performs no network or GitHub access. A missing input is reported as a limitation.
#>
[CmdletBinding()]
param(
    [string]$FailureInputPath = '.factory/failure-audit-input.json',
    [string]$PublicationPath = '.factory/failure-audit-publication.json',
    [string]$BacklogPath = '.factory/backlog-reconciliation.json',
    [string]$OutputPath = '.factory/health-report.json'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$limitations = [System.Collections.Generic.List[string]]::new()
function Read-Artifact([string]$Path, [string]$Label) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $limitations.Add("$Label artifact is missing"); return $null }
    try { Get-Content -LiteralPath $full -Raw | ConvertFrom-Json -Depth 30 }
    catch { $limitations.Add("$Label artifact is unreadable"); $null }
}
function Prop($Object, [string]$Name, $Default = $null) {
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) { $Object.$Name } else { $Default }
}

$failureInput = Read-Artifact $FailureInputPath 'failure-audit'
$publication = Read-Artifact $PublicationPath 'failure-audit publication'
$backlog = Read-Artifact $BacklogPath 'backlog reconciliation'

$failures = @(Prop $failureInput 'failures' @())
$classifications = [ordered]@{ 'factory-defect' = 0; 'project-defect' = 0; 'environment' = 0; 'unknown' = 0 }
foreach ($failure in $failures) {
    $class = [string](Prop $failure 'classification' 'factory-defect')
    if (-not $classifications.Contains($class)) { $class = 'unknown' }
    $classifications[$class]++
}
if ($failureInput -and (Prop $failureInput 'status' '') -eq 'limited') { foreach ($l in @(Prop $failureInput 'limitations' @())) { $limitations.Add([string]$l) } }

$report = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    projectId = [string](Prop $failureInput 'projectId' '')
    failures = [ordered]@{
        collectionStatus = [string](Prop $failureInput 'status' 'missing')
        windowHours = Prop $failureInput 'windowHours'
        runsInspected = Prop $failureInput 'runsInspected' 0
        failureCount = $failures.Count
        classifications = $classifications
        publication = [ordered]@{
            status = [string](Prop $publication 'status' 'missing')
            action = [string](Prop $publication 'action' 'missing')
            issueNumber = Prop $publication 'issueNumber'
            message = [string](Prop $publication 'message' '')
        }
    }
    backlog = [ordered]@{
        reconciliationStatus = if ($backlog) { 'ready' } else { 'missing' }
        keys = if ($backlog) { @($backlog.PSObject.Properties.Name) } else { @() }
        proposal = $backlog
    }
    limitations = @($limitations)
}

$outFull = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outFull) | Out-Null
$report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $outFull -Encoding utf8

$md = @(
    "# Factory health - $($report.projectId)",
    '',
    "Generated $($report.generatedAtUtc)",
    '',
    "- Failures: $($failures.Count) across $($report.failures.runsInspected) run(s) (collection: $($report.failures.collectionStatus))",
    "- Classification: factory-defect $($classifications['factory-defect']), project-defect $($classifications['project-defect']), environment $($classifications['environment']), unknown $($classifications['unknown'])",
    "- Publication: $($report.failures.publication.action) - $($report.failures.publication.message)",
    "- Backlog reconciliation: $($report.backlog.reconciliationStatus)"
)
if ($limitations.Count) { $md += @('', 'Limitations:') + @($limitations | ForEach-Object { "- $_" }) }
$md -join "`n" | Set-Content -LiteralPath ([IO.Path]::ChangeExtension($outFull, '.md')) -Encoding utf8
$report | ConvertTo-Json -Compress -Depth 4 | Write-Output
