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
        foreach ($s in $cfg['skills']) { Check "skill $s installed" (Test-Path (Join-Path $project ".ai/skills/$s/SKILL.md")) }
        foreach ($w in $cfg['workflows']) { Check "workflow $w installed" (Test-Path (Join-Path $project ".ai/cezar/workflows/factory-$w.yaml")) }
        foreach ($a in (Get-ChildItem (Join-Path $fdir 'automations') -Filter *.json -ErrorAction SilentlyContinue)) {
            $def = $null; try { $def = Get-Content -Raw $a.FullName | ConvertFrom-Json } catch { }
            Check "automation $($a.Name) valid JSON definition" ([bool]($def -and $def.name -and $def.task -and $def.task.prompt))
            if ($def -and $def.task.workflow) { Check "automation $($a.Name) workflow '$($def.task.workflow)' installed" (Test-Path (Join-Path $project ".ai/cezar/workflows/$($def.task.workflow).yaml")) }
        }
        foreach ($wf in Get-ChildItem (Join-Path $project '.ai/cezar/workflows') -Filter factory-*.yaml -ErrorAction SilentlyContinue) {
            $t = Get-Content -Raw $wf.FullName
            Check "workflow $($wf.Name) has steps" ($t -match '(?m)^steps:\s*$' -or $t -match '(?m)^skills:')
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
# Run output must be ignored; Cezar runtime state must not be tracked.
$gi = Join-Path $project '.gitignore'
Check '.factory/ is gitignored' ((Test-Path $gi) -and ((Get-Content -Raw $gi) -match '(?m)^\.factory/?\s*$'))
# Runtime state must not be tracked.
if (Test-Path (Join-Path $project '.git')) {
    $tracked = @(git -C $project ls-files '.ai/cezar' 2>$null | Where-Object { $_ -notmatch '^\.ai/cezar/(workflows/|skills/|config\.json$|\.gitignore$)' })
    Check 'no runtime files tracked' ($tracked.Count -eq 0) ($tracked -join ', ')
}
if ($failures.Count) { Write-Host "Validation: FAIL ($($failures.Count))" -ForegroundColor Red; exit 1 }
Write-Host 'Validation: PASS' -ForegroundColor Green
