#!/usr/bin/env pwsh
<#
.SYNOPSIS
Check invocation for the verify workflow: runs the selected checks and records each result.
.DESCRIPTION
Runs every check in the selection record, never stopping at the first failure, and writes one result per check.
A check's command is taken from the ownership map by id, and a selection entry whose command differs is refused,
so the selection file cannot smuggle in a command. This step exits 0 once every check has run; the verdict, and
the failing exit code, belong to verification-evaluate.ps1.
#>
[CmdletBinding()]
param(
    [string]$Root = '.',
    [string]$SelectionPath = '.factory/verification/selection.json',
    [string]$OutputPath = '.factory/verification/results.json',
    [string]$PolicyPath = ''
)
$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }
. (Join-Path $PSScriptRoot 'verification-lib.ps1')
if (-not $PolicyPath) { $PolicyPath = Join-Path $PSScriptRoot '../policies/verification.json' }
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$policy = Read-VerificationPolicy $PolicyPath
$selection = Read-VerificationJson $SelectionPath 'Verification selection'
$owned = Read-OwnershipChecks $rootPath
$results = [System.Collections.Generic.List[object]]::new()
foreach ($check in @($selection.selected)) {
    $id = [string]$check.id
    $started = Get-Date
    $status = 'error'; $exitCode = 1; $tail = ''
    if (-not $owned.ContainsKey($id) -or $owned[$id] -ne [string]$check.command) {
        $tail = "Check '$id' is not defined with this command in the ownership map; refusing to run it."
    } else {
        $env:FACTORY_CHANGED_PATHS = (ConvertTo-Json -InputObject @($check.paths) -Compress)
        $info = [Diagnostics.ProcessStartInfo]::new('pwsh')
        foreach ($a in @('-NoProfile', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$check.command + "`nif (`$LASTEXITCODE) { exit `$LASTEXITCODE }")))) { $info.ArgumentList.Add($a) }
        $info.WorkingDirectory = $rootPath
        $info.UseShellExecute = $false; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($info)
        $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit([int]$policy.checkTimeoutSeconds * 1000)) {
            try { $process.Kill($true) } catch { }
            $status = 'error'; $exitCode = 124; $tail = "Check exceeded $($policy.checkTimeoutSeconds) seconds."
        } else {
            $exitCode = [int]$process.ExitCode
            $status = if ($exitCode -eq 0) { 'passed' } else { 'failed' }
            $text = $out.Result + $err.Result
            $tail = if ($text.Length -gt 4096) { $text.Substring($text.Length - 4096) } else { $text }
        }
        Remove-Item Env:FACTORY_CHANGED_PATHS -ErrorAction SilentlyContinue
    }
    $results.Add([ordered]@{ id = $id; status = $status; exitCode = $exitCode; durationMs = [int]((Get-Date) - $started).TotalMilliseconds; outputTail = $tail })
}
Write-VerificationJson ([ordered]@{ schemaVersion = 1; headSha = [string]$selection.headSha; results = @($results) }) $OutputPath
Write-Output (ConvertTo-Json -InputObject ([ordered]@{ status = 'ran'; checks = $results.Count }) -Compress)
