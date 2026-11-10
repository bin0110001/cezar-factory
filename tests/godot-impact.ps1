#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$collector = Join-Path $factory 'scripts/collect-godot-dependencies.ps1'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("godot-impact-" + [guid]::NewGuid().ToString('N'))
$script:failures = 0

function Assert([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:failures++ }
}

function Invoke-Collector([string]$Project, [string[]]$Changed = @()) {
    $output = Join-Path $Project '.factory/graph.json'
    $args = @{ Root = $Project; OutputPath = $output }
    if ($Changed.Count) { $args.ChangedPath = $Changed }
    & $collector @args | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Dependency collector failed with exit code $LASTEXITCODE" }
    Get-Content -Raw -LiteralPath $output | ConvertFrom-Json
}

try {
    $project = Join-Path $tempRoot 'project'
    New-Item -ItemType Directory -Force -Path (Join-Path $project 'scripts'), (Join-Path $project 'scenes'), (Join-Path $project 'resources') | Out-Null
    Set-Content -LiteralPath (Join-Path $project 'project.godot') -Value "[application]`nconfig/name=\"Fixture\"`n`n[autoload]`nGlobal=\"*res://scripts/global.gd\"`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'scripts/global.gd') -Value "extends Node`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'scripts/consumer.gd') -Value "extends Node`nconst scene = preload(\"res://scenes/main.tscn\") # load(\"res://ignored.tscn\")`nvar dynamic = load(path_from_config)`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'scenes/main.tscn') -Value "[gd_scene load_steps=2 format=3]`n[ext_resource type=\"Script\" path=\"res://scripts/consumer.gd\" id=\"1\"]`n[node name=\"Root\" type=\"Node\"]`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'resources/cycle.tres') -Value "[gd_resource type=\"Resource\" format=3]`n[ext_resource type=\"Resource\" path=\"res://scenes/main.tscn\" id=\"1\"]`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'scripts/broken.gd') -Value "const incomplete = preload(\"res://scenes/main.tscn\"`n" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'godot-impact.json') -Value '{"schemaVersion":1,"dependencies":[{"source":"res://scenes/main.tscn","dependsOn":["res://resources/cycle.tres"]}]}' -Encoding utf8

    $graph = Invoke-Collector $project @('res://resources/cycle.tres')
    Assert 'schema and status are stable' ($graph.schemaVersion -eq 1 -and $graph.status -eq 'complete')
    Assert 'GDScript preload and scene external resource edges are present' (@($graph.edges | Where-Object { $_.from -eq 'scripts/consumer.gd' -and $_.to -eq 'scenes/main.tscn' -and $_.via -eq 'preload' }).Count -eq 1 -and @($graph.edges | Where-Object { $_.from -eq 'scenes/main.tscn' -and $_.to -eq 'scripts/consumer.gd' }).Count -eq 1)
    Assert 'autoload and explicit dependency edges are present' (@($graph.edges | Where-Object { $_.from -eq 'project.godot' -and $_.to -eq 'scripts/global.gd' -and $_.via -eq 'autoload' }).Count -eq 1 -and @($graph.edges | Where-Object { $_.from -eq 'scenes/main.tscn' -and $_.to -eq 'resources/cycle.tres' -and $_.via -eq 'explicit' }).Count -eq 1)
    Assert 'dynamic and malformed calls are marked uncertain' (@($graph.uncertain | Where-Object { $_.file -eq 'scripts/consumer.gd' -and $_.reason -match 'computed' }).Count -eq 1 -and @($graph.uncertain | Where-Object { $_.file -eq 'scripts/broken.gd' }).Count -eq 1)
    Assert 'reverse lookup returns transitive dependents through a cycle' (@($graph.affected) -contains 'scenes/main.tscn' -and @($graph.affected) -contains 'scripts/consumer.gd' -and @($graph.affected) -contains 'project.godot')

    Set-Content -LiteralPath (Join-Path $project 'scripts/broken.gd') -Value 'this is not a valid call(' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $project 'scenes/main.tscn') -Value '[ext_resource type="Script" id="1"]' -Encoding utf8
    $malformed = Invoke-Collector $project
    Assert 'malformed resources produce diagnostics without stopping collection' (@($malformed.diagnostics | Where-Object { $_.code -eq 'malformed-ext-resource' }).Count -gt 0 -and $malformed.status -eq 'complete')

    $plain = Join-Path $tempRoot 'plain'
    New-Item -ItemType Directory -Force -Path $plain | Out-Null
    & $collector -Root $plain -Optional -OutputPath (Join-Path $plain '.factory/skipped.json') | Out-Null
    $skip = Get-Content -Raw (Join-Path $plain '.factory/skipped.json') | ConvertFrom-Json
    Assert 'optional non-Godot projects skip cleanly' ($skip.status -eq 'skipped' -and $skip.reason -eq 'not-a-godot-project')
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}

if ($script:failures) { throw "$script:failures Godot impact assertion(s) failed." }
Write-Host 'Godot dependency graph fixtures passed.'
