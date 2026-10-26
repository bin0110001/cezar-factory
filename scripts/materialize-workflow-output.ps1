#!/usr/bin/env pwsh
<#
.SYNOPSIS
Persist one validated Cezar workflow output for legacy Factory consumers that require a file.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z][a-zA-Z0-9_-]{0,63}$')][string]$OutputKey,
    [Parameter(Mandatory)][string]$Path
)
$ErrorActionPreference = 'Stop'

if (Test-Path '.factory/already-resolved.json') {
    '{"status":"skipped","reason":"already-resolved"}'
    exit 0
}

try {
    if ([string]::IsNullOrWhiteSpace($env:CEZAR_INPUT_JSON)) { throw 'CEZAR_INPUT_JSON is missing' }
    $inputObject = ConvertFrom-Json -InputObject $env:CEZAR_INPUT_JSON -AsHashtable -Depth 40
    if ($inputObject -isnot [System.Collections.IDictionary] -or
        $inputObject.outputs -isnot [System.Collections.IDictionary] -or
        -not $inputObject.outputs.Contains($OutputKey)) {
        throw "workflow output '$OutputKey' is missing"
    }
    $value = $inputObject.outputs[$OutputKey]
    if ($value -isnot [System.Collections.IDictionary]) { throw "workflow output '$OutputKey' must be a JSON object" }

    $root = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $target = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'output path must stay inside the workflow workspace'
    }
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = Join-Path $parent ('.' + [IO.Path]::GetFileName($target) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = ConvertTo-Json -InputObject $value -Depth 40
        [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $target -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
    ([ordered]@{ status = 'materialized'; outputKey = $OutputKey; path = $Path } | ConvertTo-Json -Compress)
}
catch {
    [Console]::Error.WriteLine("workflow output materialization failed: $($_.Exception.Message)")
    exit 1
}
