[CmdletBinding()]
param(
    [string]$ControlPlaneHost,
    [string]$ControlPlaneUser,
    [string]$IdentityFile,
    [string]$RemoteEnvPath,
    [switch]$CopyToClipboard
)

$ErrorActionPreference = 'Stop'

function Read-RequiredValue {
    param([string]$Prompt, [string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        $Value = Read-Host $Prompt
    }
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "A value is required for: $Prompt"
    }
    return $Value.Trim()
}

function Invoke-SshCapture {
    param(
        [string]$Target,
        [string[]]$Arguments
    )

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'ssh'
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    [void]$start.ArgumentList.Add('-T')
    [void]$start.ArgumentList.Add('-o')
    [void]$start.ArgumentList.Add('BatchMode=yes')
    [void]$start.ArgumentList.Add('-o')
    [void]$start.ArgumentList.Add('ConnectTimeout=10')
    if ($IdentityFile) {
        [void]$start.ArgumentList.Add('-i')
        [void]$start.ArgumentList.Add($IdentityFile)
    }
    [void]$start.ArgumentList.Add($Target)
    foreach ($argument in $Arguments) {
        [void]$start.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) {
        throw 'Unable to start ssh.'
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        $detail = if ($stderr.Trim()) { $stderr.Trim() } else { 'No SSH diagnostic was returned.' }
        throw "SSH request failed: $detail"
    }
    return $stdout
}

$ControlPlaneHost = Read-RequiredValue 'Control-plane host or SSH alias' $ControlPlaneHost
$ControlPlaneUser = Read-RequiredValue 'Control-plane SSH user' $ControlPlaneUser
$RemoteEnvPath = Read-RequiredValue 'Remote LiteLLM env-file path' $RemoteEnvPath

if ($RemoteEnvPath -notmatch '^/[A-Za-z0-9._/-]+$') {
    throw 'RemoteEnvPath must be an absolute path containing only letters, numbers, dots, underscores, hyphens, and slashes.'
}
if ($IdentityFile -and -not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "SSH identity file was not found: $IdentityFile"
}

$target = "$ControlPlaneUser@$ControlPlaneHost"
$remoteScript = 'set -eu; awk -F= ''$1 == "LITELLM_MASTER_KEY" {sub(/^[^=]*=/, ""); print}'' ' + $RemoteEnvPath + ' | tail -n 1'
$raw = Invoke-SshCapture -Target $target -Arguments @('sh', '-c', $remoteScript)
$key = ($raw -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()

if ([string]::IsNullOrWhiteSpace($key) -or $key -match "\s") {
    throw 'The remote env file did not return a non-empty master-key value.'
}

Write-Host 'LiteLLM master key retrieved. Treat it as a root credential.' -ForegroundColor Yellow
Write-Host $key
if ($CopyToClipboard) {
    Set-Clipboard -Value $key
    Write-Host 'Copied to the local clipboard; clear it after use.' -ForegroundColor Yellow
}
