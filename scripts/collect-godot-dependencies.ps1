#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [string]$Root = '.',
    [string[]]$ChangedPath = @(),
    [string]$OutputPath = '.factory/godot-dependencies.json',
    [switch]$Optional,
    [ValidateRange(1, 100000)][int]$MaxFiles = 20000,
    [ValidateRange(1024, 52428800)][int]$MaxFileBytes = 5242880
)

$ErrorActionPreference = 'Stop'
if (Test-Path '.factory/already-resolved.json') { '{"status":"skipped","reason":"already-resolved"}'; exit 0 }

function Add-GraphDiagnostic([string]$Code, [string]$File, [int]$Line, [string]$Message) {
    $script:Diagnostics.Add([ordered]@{ code = $Code; file = $File; line = $Line; message = $Message })
}

function Add-GraphEdge([string]$From, [string]$To, [string]$Via, [int]$Line) {
    if (-not $From -or -not $To) { return }
    $script:Nodes.Add($From) | Out-Null
    $script:Nodes.Add($To) | Out-Null
    $key = "$From`0$To`0$Via`0$Line"
    if ($script:EdgeKeys.Add($key)) { $script:Edges.Add([ordered]@{ from = $From; to = $To; via = $Via; line = $Line }) }
    if (-not $script:KnownFiles.Contains($To)) { Add-GraphDiagnostic 'missing-resource' $From $Line "Referenced resource is not present in the project: $To" }
}

function Remove-GodotLineComment([string]$Text) {
    $quote = [char]0; $escaped = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $char = $Text[$i]
        if ($quote -ne [char]0) {
            if ($escaped) { $escaped = $false; continue }
            if ($char -eq '\') { $escaped = $true; continue }
            if ($char -eq $quote) { $quote = [char]0 }
            continue
        }
        if ($char -eq '"' -or $char -eq "'") { $quote = $char; continue }
        if ($char -eq '#') { return $Text.Substring(0, $i) }
    }
    $Text
}

function Normalize-GodotPath([string]$Value, [string]$RelativeTo, [string]$Source, [int]$Line) {
    $path = $Value.Trim().Replace('\', '/')
    if ($path.StartsWith('uid://', [StringComparison]::Ordinal)) {
        if ($script:UidMap.ContainsKey($path)) { $path = $script:UidMap[$path] }
        else {
            $script:Uncertain.Add([ordered]@{ file = $Source; line = $Line; reason = 'resource UID has no path mapping' })
            Add-GraphDiagnostic 'unresolved-resource-uid' $Source $Line 'Resource UID has no path mapping.'
            return $null
        }
    }
    if ($path.StartsWith('res://', [StringComparison]::OrdinalIgnoreCase)) { $path = $path.Substring(6) }
    elseif ($path -match '^[A-Za-z][A-Za-z0-9+.-]*://') {
        Add-GraphDiagnostic 'unsupported-resource-scheme' $Source $Line 'Resource uses an unsupported path scheme.'
        return $null
    }
    elseif ($path.StartsWith('/') -or $path -match '^[A-Za-z]:') {
        Add-GraphDiagnostic 'unsafe-resource-path' $Source $Line 'Absolute host paths are not accepted.'
        return $null
    }
    elseif ($RelativeTo -and $RelativeTo.Contains('/')) { $path = "$($RelativeTo.Substring(0, $RelativeTo.LastIndexOf('/')))/$path" }

    $parts = [Collections.Generic.List[string]]::new()
    foreach ($part in $path.Split('/')) {
        if (-not $part -or $part -eq '.') { continue }
        if ($part -eq '..') {
            if ($parts.Count -eq 0) { Add-GraphDiagnostic 'unsafe-resource-path' $Source $Line 'Resource path escapes the project root.'; return $null }
            $parts.RemoveAt($parts.Count - 1); continue
        }
        $parts.Add($part)
    }
    if ($parts.Count -eq 0) { Add-GraphDiagnostic 'empty-resource-path' $Source $Line 'Resource path is empty.'; return $null }
    [string]::Join('/', $parts)
}

function Get-CallArguments([string]$Text, [int]$OpenIndex) {
    $depth = 1; $quote = [char]0; $escaped = $false
    for ($i = $OpenIndex + 1; $i -lt $Text.Length; $i++) {
        $char = $Text[$i]
        if ($quote -ne [char]0) {
            if ($escaped) { $escaped = $false; continue }
            if ($char -eq '\') { $escaped = $true; continue }
            if ($char -eq $quote) { $quote = [char]0 }
            continue
        }
        if ($char -eq '"' -or $char -eq "'") { $quote = $char; continue }
        if ($char -eq '(') { $depth++; continue }
        if ($char -eq ')') { $depth--; if ($depth -eq 0) { return $Text.Substring($OpenIndex + 1, $i - $OpenIndex - 1) } }
    }
    $null
}

function Get-ProjectFiles([string]$ProjectRoot, [int]$Limit) {
    $found = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($ProjectRoot)
    $skipped = $false
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            if ($item.PSIsContainer) {
                if ($item.Name -notin @('.git', '.godot', '.factory', 'node_modules', '.venv', 'venv')) { $pending.Push($item.FullName) }
                continue
            }
            if ($item.Name -eq 'project.godot' -or $item.Extension.ToLowerInvariant() -in @('.gd', '.tscn', '.tres')) {
                if ($found.Count -ge $Limit) { $skipped = $true; break }
                $found.Add($item.FullName)
            }
        }
        if ($skipped) { break }
    }
    [pscustomobject]@{ files = @($found); truncated = $skipped }
}

function Add-ResourceReference([string]$From, [string]$Resource, [string]$Via, [int]$Line) {
    $target = Normalize-GodotPath $Resource $From $From $Line
    if ($target) { Add-GraphEdge $From $target $Via $Line }
}

function Write-Graph($Graph, [string]$Path) {
    $json = ConvertTo-Json -InputObject $Graph -Depth 16
    if ($Path) {
        $parent = Split-Path -Parent $Path
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Set-Content -LiteralPath $Path -Value $json -Encoding utf8
    }
    Write-Output $json
}

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$projectFile = Join-Path $rootPath 'project.godot'
$outputFull = if ([IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } elseif ($OutputPath) { Join-Path $rootPath $OutputPath } else { '' }
if (-not (Test-Path -LiteralPath $projectFile -PathType Leaf)) {
    if ($Optional) { Write-Graph ([ordered]@{ schemaVersion = 1; status = 'skipped'; reason = 'not-a-godot-project'; nodes = @(); edges = @(); reverseIndex = [ordered]@{}; uncertain = @(); diagnostics = @(); affected = @() }) $outputFull; exit 0 }
    throw "Godot project file not found: $projectFile"
}

$script:Nodes = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
$script:Edges = [Collections.Generic.List[object]]::new()
$script:EdgeKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$script:Diagnostics = [Collections.Generic.List[object]]::new()
$script:Uncertain = [Collections.Generic.List[object]]::new()
$script:UidMap = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
$script:KnownFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$scan = Get-ProjectFiles $rootPath $MaxFiles
$files = @($scan.files | ForEach-Object { [IO.Path]::GetRelativePath($rootPath, $_).Replace('\', '/') } | Sort-Object -CaseSensitive)
foreach ($file in $files) { $script:KnownFiles.Add($file) | Out-Null; $script:Nodes.Add($file) | Out-Null }
if ($scan.truncated) { Add-GraphDiagnostic 'file-limit-reached' '' 0 "Project scan stopped at the configured $MaxFiles file limit." }

# First pass records UID-to-path declarations so uid:// loads can resolve independent of scan order.
foreach ($file in $files | Where-Object { [IO.Path]::GetExtension($_).ToLowerInvariant() -in @('.tscn', '.tres') }) {
    $full = Join-Path $rootPath ($file.Replace('/', [IO.Path]::DirectorySeparatorChar))
    try {
        if ((Get-Item -LiteralPath $full).Length -gt $MaxFileBytes) { Add-GraphDiagnostic 'file-too-large' $file 0 'Resource file exceeds the configured read limit.'; continue }
        $lines = Get-Content -LiteralPath $full -Encoding utf8
        for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
            $line = Remove-GodotLineComment ([string]$lines[$lineIndex])
            if ($line -notmatch '^\s*\[ext_resource\b') { continue }
            $pathMatch = [regex]::Match($line, '\bpath\s*=\s*(["''])(?<path>.*?)\1')
            $uidMatch = [regex]::Match($line, '\buid\s*=\s*(["''])(?<uid>uid://.*?)\1')
            if (-not $pathMatch.Success) { Add-GraphDiagnostic 'malformed-ext-resource' $file ($lineIndex + 1) 'External resource declaration has no quoted path.'; continue }
            $rawPath = $pathMatch.Groups['path'].Value
            $resolvedPath = Normalize-GodotPath $rawPath $file $file ($lineIndex + 1)
            if ($resolvedPath -and $uidMatch.Success) { $script:UidMap[$uidMatch.Groups['uid'].Value] = "res://$resolvedPath" }
        }
    } catch { Add-GraphDiagnostic 'unreadable-resource' $file 0 'Resource file could not be read.' }
}

foreach ($file in $files) {
    $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
    $full = Join-Path $rootPath ($file.Replace('/', [IO.Path]::DirectorySeparatorChar))
    try {
        if ((Get-Item -LiteralPath $full).Length -gt $MaxFileBytes) { Add-GraphDiagnostic 'file-too-large' $file 0 'Source file exceeds the configured read limit.'; continue }
        $lines = Get-Content -LiteralPath $full -Encoding utf8
    } catch { Add-GraphDiagnostic 'unreadable-resource' $file 0 'Source file could not be read.'; continue }

    if ($extension -in @('.tscn', '.tres')) {
        for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
            $line = Remove-GodotLineComment ([string]$lines[$lineIndex])
            if ($line -notmatch '^\s*\[ext_resource\b') { continue }
            $pathMatch = [regex]::Match($line, '\bpath\s*=\s*(["''])(?<path>.*?)\1')
            if (-not $pathMatch.Success) { continue }
            Add-ResourceReference $file $pathMatch.Groups['path'].Value 'ext-resource' ($lineIndex + 1)
        }
    } elseif ($extension -eq '.gd') {
        for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
            $visibleLine = Remove-GodotLineComment ([string]$lines[$lineIndex])
            foreach ($call in [regex]::Matches($visibleLine, '\b(?<method>preload|load)\s*\(', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
                $openIndex = $call.Index + $call.Length - 1
                $arguments = Get-CallArguments $visibleLine $openIndex
                if ($null -eq $arguments) {
                    $script:Uncertain.Add([ordered]@{ file = $file; line = $lineIndex + 1; reason = 'multiline or unterminated resource call' })
                    continue
                }
                $arguments = $arguments.Trim()
                if ($arguments.Length -ge 2 -and (($arguments[0] -eq '"' -and $arguments[$arguments.Length - 1] -eq '"') -or ($arguments[0] -eq "'" -and $arguments[$arguments.Length - 1] -eq "'"))) {
                    $rawPath = $arguments.Substring(1, $arguments.Length - 2).Replace('\"', '"').Replace("\'", "'").Replace('\\', '\')
                    Add-ResourceReference $file $rawPath $call.Groups['method'].Value.ToLowerInvariant() ($lineIndex + 1)
                } else {
                    $script:Uncertain.Add([ordered]@{ file = $file; line = $lineIndex + 1; reason = 'resource path is computed or not a single string literal' })
                }
            }
        }
    } elseif ($file -eq 'project.godot') {
        $section = ''
        for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
            $line = Remove-GodotLineComment ([string]$lines[$lineIndex]).Trim()
            if (-not $line) { continue }
            if ($line -match '^\[(?<section>[^\]]+)\]$') { $section = $Matches.section.ToLowerInvariant(); continue }
            if ($line.StartsWith('[')) { Add-GraphDiagnostic 'malformed-project-section' $file ($lineIndex + 1) 'Project section header is malformed.'; continue }
            if ($section -ne 'autoload') { continue }
            if ($line -notmatch '^(?<name>[^=]+?)\s*=\s*(?<value>.+)$') { Add-GraphDiagnostic 'malformed-autoload' $file ($lineIndex + 1) 'Autoload entry is malformed.'; continue }
            $value = $Matches.value.Trim().Trim('"').Trim("'").TrimStart('*')
            if (-not $value) { Add-GraphDiagnostic 'malformed-autoload' $file ($lineIndex + 1) 'Autoload entry has an empty resource path.'; continue }
            Add-ResourceReference $file $value 'autoload' ($lineIndex + 1)
        }
    }
}

$declarationsPath = Join-Path $rootPath 'godot-impact.json'
if (Test-Path -LiteralPath $declarationsPath -PathType Leaf) {
    try {
        $declarations = Get-Content -Raw -LiteralPath $declarationsPath -Encoding utf8 | ConvertFrom-Json -AsHashtable
        if ($declarations.schemaVersion -ne 1 -or -not ($declarations.dependencies -is [array])) { throw 'expected schemaVersion 1 and a dependencies array' }
        foreach ($entry in $declarations.dependencies) {
            if (-not ($entry -is [System.Collections.IDictionary]) -or -not $entry.source -or -not ($entry.dependsOn -is [array])) {
                Add-GraphDiagnostic 'malformed-explicit-dependency' 'godot-impact.json' 0 'Each dependency requires source and dependsOn fields.'; continue
            }
            $source = Normalize-GodotPath ([string]$entry.source) '' 'godot-impact.json' 0
            if (-not $source) { continue }
            foreach ($dependency in $entry.dependsOn) {
                $target = Normalize-GodotPath ([string]$dependency) '' 'godot-impact.json' 0
                if ($target) { Add-GraphEdge $source $target 'explicit' 0 }
            }
        }
    } catch { Add-GraphDiagnostic 'malformed-explicit-dependencies' 'godot-impact.json' 0 'Explicit dependency file is invalid JSON or does not match schemaVersion 1.' }
}

foreach ($node in $script:Nodes) { if (-not $script:KnownFiles.Contains($node)) { Add-GraphDiagnostic 'missing-resource' $node 0 'Resource node does not exist in the project.' } }
$sortedEdges = @($script:Edges | Sort-Object -Property from, to, via, line -CaseSensitive)
$reverse = [ordered]@{}
foreach ($target in $script:Nodes) {
    $dependents = @($sortedEdges | Where-Object { $_.to -ceq $target } | ForEach-Object { $_.from } | Sort-Object -Unique -CaseSensitive)
    if ($dependents.Count) { $reverse[$target] = $dependents }
}

$changed = @()
foreach ($path in $ChangedPath) {
    $normalized = Normalize-GodotPath $path '' '' 0
    if ($normalized) { $changed += $normalized }
}
$affectedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$queue = [Collections.Generic.Queue[string]]::new()
foreach ($path in $changed) { $queue.Enqueue($path) }
while ($queue.Count -gt 0) {
    $target = $queue.Dequeue()
    foreach ($dependent in @($reverse[$target])) {
        if ($affectedSet.Add([string]$dependent)) { $queue.Enqueue([string]$dependent) }
    }
}
$affected = @($affectedSet | Sort-Object -CaseSensitive)
$sortedDiagnostics = @($script:Diagnostics | Sort-Object -Property file, line, code, message -CaseSensitive)
$sortedUncertain = @($script:Uncertain | Sort-Object -Property file, line, reason -CaseSensitive)
$result = [ordered]@{
    schemaVersion = 1; status = 'complete'; nodes = @($script:Nodes); edges = $sortedEdges; reverseIndex = $reverse
    changedPaths = @($changed | Sort-Object -Unique -CaseSensitive); affected = $affected; uncertain = $sortedUncertain; diagnostics = $sortedDiagnostics
}
Write-Graph $result $outputFull
