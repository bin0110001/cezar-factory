#!/usr/bin/env pwsh
<#
.SYNOPSIS
Verify a project's factory installation. Exits 1 on any failed check.
#>
[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$FactoryPath = (Join-Path $PSScriptRoot '..')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$project = Resolve-ProjectPath $ProjectPath
$factory = (Resolve-Path $FactoryPath).Path
$fdir = Get-FactoryDir $project
$failures = [System.Collections.Generic.List[string]]::new()
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name $Detail"; $failures.Add($Name) }
}

$cfgPath = Join-Path $fdir 'factory.config.yaml'
Check 'config exists' (Test-Path $cfgPath)
if (Test-Path $cfgPath) {
    $cfg = Read-FactoryConfig $cfgPath
    $errs = @(Test-FactoryConfig $cfg)
    Check 'config valid' ($errs.Count -eq 0) ($errs -join '; ')
    if ($errs.Count -eq 0) {
        $pin = $cfg['factory']['version']
        $src = Get-FactoryVersion $factory
        Check "pinned version $pin exists in source" ($pin -eq $src) "(source is $src)"
        $installed = if (Test-Path (Join-Path $fdir 'VERSION')) { (Get-Content -Raw (Join-Path $fdir 'VERSION')).Trim() } else { '' }
        Check 'installed VERSION matches pin' ($installed -eq $pin) "(installed '$installed')"

        if ($pin -eq $src) {
            & (Join-Path $PSScriptRoot 'diff.ps1') -ProjectPath $project -FactoryPath $factory | Out-Null
            Check 'installed files match source (no drift)' ($LASTEXITCODE -eq 0) '(run diff.ps1)'
        }
        foreach ($s in $cfg['skills']) { Check "skill $s installed" (Test-Path (Join-Path $fdir "skills/$s/SKILL.md")) }
        foreach ($w in $cfg['workflows']) { Check "workflow $w installed" (Test-Path (Join-Path $fdir "workflows/$w.yaml")) }
        foreach ($a in (Get-ChildItem (Join-Path $fdir 'automations') -Filter *.yaml -ErrorAction SilentlyContinue)) {
            $t = Get-Content -Raw $a.FullName
            $ok = ($t -match '(?m)^name:\s*\S') -and ($t -match '(?m)^trigger:') -and ($t -match '(?m)^action:')
            Check "automation $($a.Name) valid" $ok
            if ($t -match 'launch_workflow:\s*(\S+)') { Check "automation $($a.Name) workflow '$($Matches[1])' installed" (Test-Path (Join-Path $fdir "workflows/$($Matches[1]).yaml")) }
        }
        foreach ($k in 'changed', 'full', 'verify') {
            $v = if ($cfg['validation'] -and $cfg['validation'].Contains($k)) { $cfg['validation'][$k] } else { $null }
            Check "validation.$k script exists" ([bool]($v -and (Test-Path (Join-Path $project $v))))
        }
        # Overrides must replace a real base component.
        $ovRoot = Join-Path $fdir 'overrides'
        if (Test-Path $ovRoot) {
            foreach ($f in Get-ChildItem $ovRoot -File -Recurse) {
                $rel = $f.FullName.Substring($ovRoot.Length).TrimStart('\', '/') -replace '\\', '/'
                Check "override $rel references a base component" (Test-Path (Join-Path $factory $rel))
            }
        }
    }
}
# Runtime state must not be tracked.
if (Test-Path (Join-Path $project '.git')) {
    $tracked = @(git -C $project ls-files '.ai/cezar' 2>$null)
    Check 'no runtime files tracked' ($tracked.Count -eq 0) ($tracked -join ', ')
}
if ($failures.Count) { Write-Host "Validation: FAIL ($($failures.Count))" -ForegroundColor Red; exit 1 }
Write-Host 'Validation: PASS' -ForegroundColor Green
