#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scriptPath = Join-Path $factory 'scripts/collect-impact.ps1'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('factory-impact-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$passed = 0
$failed = 0
function Assert([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name"; $script:passed++ }
    else { Write-Host "  FAIL $Name"; $script:failed++ }
}
function Invoke-FixtureGit([string]$Directory, [string[]]$Arguments) {
    $output = & git -C $Directory @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($output -join "`n")" }
}
try {
    & git init -q -b main $tmp
    Invoke-FixtureGit $tmp @('config', 'user.email', 'test@example.com')
    Invoke-FixtureGit $tmp @('config', 'user.name', 'Factory Test')
    $manifestPath = Join-Path $tmp '.ai/factory/factory.config.yaml'
    New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath) | Out-Null
    @'
verification:
  version: 1
  checks:
    docs-check:
      runner: command
      executable: pwsh
      args: []
      cwd: .
      timeoutSeconds: 60
      owns:
        - "docs/**/*.txt"
      tags:
        - docs
        - powershell
    source-check:
      runner: command
      executable: pwsh
      args: []
      cwd: .
      timeoutSeconds: 60
      owns:
        - "src/**/*.txt"
      tags:
        - source
  suites:
    full:
      - docs-check
      - source-check
'@ | Set-Content -LiteralPath $manifestPath -Encoding utf8
    foreach ($file in @('docs/modify.txt', 'docs/delete.txt', 'src/old name.txt')) {
        $full = Join-Path $tmp $file
        New-Item -ItemType Directory -Force -Path (Split-Path $full) | Out-Null
        Set-Content -LiteralPath $full -Value $file -Encoding utf8
    }
    Invoke-FixtureGit $tmp @('add', '-A'); Invoke-FixtureGit $tmp @('commit', '-q', '-m', 'baseline'); Invoke-FixtureGit $tmp @('branch', 'baseline')
    Set-Content -LiteralPath (Join-Path $tmp 'docs/modify.txt') -Value 'changed' -Encoding utf8
    Remove-Item -LiteralPath (Join-Path $tmp 'docs/delete.txt')
    $newName = Join-Path $tmp 'docs/renamed naïve guide.txt'
    Move-Item -LiteralPath (Join-Path $tmp 'src/old name.txt') -Destination $newName
    $orphan = Join-Path $tmp 'misc/orphan λ.bin'
    New-Item -ItemType Directory -Force -Path (Split-Path $orphan) | Out-Null
    Set-Content -LiteralPath $orphan -Value 'new' -Encoding utf8
    Invoke-FixtureGit $tmp @('add', '-A'); Invoke-FixtureGit $tmp @('commit', '-q', '-m', 'change set')

    $jsonPath = '.factory/changed-set.json'
    $output = & pwsh -NoProfile -File $scriptPath -Root $tmp -BaseRef baseline -HeadRef HEAD -ManifestPath '.ai/factory/factory.config.yaml' -OutputPath $jsonPath 2>&1
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { Write-Host ($output -join "`n") }
    $result = if ($exit -eq 0) { ($output -join "`n") | ConvertFrom-Json } else { $null }
    Assert 'emits valid changed-set JSON with base, head and merge-base commits' ($exit -eq 0 -and $result.status -eq 'complete' -and $result.baseSha -match '^[0-9a-f]{40,64}$' -and $result.headSha -match '^[0-9a-f]{40,64}$' -and $result.mergeBaseSha -eq $result.baseSha)
    Assert 'classifies added, modified and deleted paths' ($result.added.path -contains 'misc/orphan λ.bin' -and $result.modified.path -contains 'docs/modify.txt' -and $result.deleted.path -contains 'docs/delete.txt' -and $result.added[0].owners -is [array] -and $result.added[0].owners.Count -eq 0)
    Assert 'rename records both paths and resolves each side owner' ($result.renamed.Count -eq 1 -and $result.renamed[0].oldPath -eq 'src/old name.txt' -and $result.renamed[0].newPath -eq 'docs/renamed naïve guide.txt' -and $result.renamed[0].oldOwners -is [array] -and $result.renamed[0].newOwners -is [array] -and $result.renamed[0].oldOwners[0].checkId -eq 'source-check' -and $result.renamed[0].newOwners[0].checkId -eq 'docs-check' -and $result.renamed[0].newOwners[0].tags -contains 'powershell')
    Assert 'reports every path without an owner as unowned' ($result.unowned.Count -eq 1 -and $result.unowned[0].path -eq 'misc/orphan λ.bin')
    Assert 'writes the same structured result to the requested artifact path' ((Test-Path (Join-Path $tmp $jsonPath)) -and ((Get-Content -Raw (Join-Path $tmp $jsonPath) | ConvertFrom-Json).headSha -eq $result.headSha))

    $emptyOutput = & pwsh -NoProfile -File $scriptPath -Root $tmp -BaseRef HEAD -HeadRef HEAD -ManifestPath '.ai/factory/factory.config.yaml' -OutputPath '' 2>&1
    $emptyCode = $LASTEXITCODE
    if ($emptyCode -ne 0) { Write-Host ($emptyOutput -join "`n") }
    $empty = if ($emptyCode -eq 0) { ($emptyOutput -join "`n") | ConvertFrom-Json } else { $null }
    Assert 'an empty diff succeeds with empty change arrays' ($emptyCode -eq 0 -and $empty.status -eq 'complete' -and $empty.paths.Count -eq 0 -and $empty.unowned.Count -eq 0)

    $badOutput = & pwsh -NoProfile -File $scriptPath -Root $tmp -BaseRef missing-base -ManifestPath '.ai/factory/factory.config.yaml' -OutputPath '' 2>&1
    Assert 'a missing base ref fails with an explicit error' ($LASTEXITCODE -ne 0 -and ($badOutput -join "`n") -match 'git rev-parse.*failed')

    $goodManifest = Get-Content -Raw -LiteralPath $manifestPath
    'verification: [' | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $badManifest = & pwsh -NoProfile -File $scriptPath -Root $tmp -BaseRef baseline -ManifestPath '.ai/factory/factory.config.yaml' -OutputPath '' 2>&1
    Assert 'malformed YAML fails validation clearly' ($LASTEXITCODE -ne 0 -and ($badManifest -join "`n") -match 'manifest validation failed')
    'verification: {version: 2}' | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $badSchema = & pwsh -NoProfile -File $scriptPath -Root $tmp -BaseRef baseline -ManifestPath '.ai/factory/factory.config.yaml' -OutputPath '' 2>&1
    Assert 'unsupported manifest schema fails contract validation' ($LASTEXITCODE -ne 0 -and ($badSchema -join "`n") -match 'invalid verification manifest')
    $goodManifest | Set-Content -LiteralPath $manifestPath -Encoding utf8

    $savedManifest = Join-Path $tmp 'manifest.saved'
    Move-Item -LiteralPath $manifestPath -Destination $savedManifest
    $optionalOutput = & pwsh -NoProfile -File $scriptPath -Root $tmp -BaseRef baseline -ManifestPath '.ai/factory/factory.config.yaml' -Optional -OutputPath '.factory/no-manifest.json' 2>&1
    $optionalCode = $LASTEXITCODE
    $optionalResult = if ($optionalCode -eq 0) { ($optionalOutput -join "`n") | ConvertFrom-Json } else { $null }
    Assert 'optional collection skips cleanly when a manifest is absent' ($optionalCode -eq 0 -and $optionalResult.status -eq 'skipped' -and $optionalResult.reason -eq 'manifest-missing')
    Move-Item -LiteralPath $savedManifest -Destination $manifestPath

    $unrelatedRoot = Join-Path $tmp 'unrelated'
    New-Item -ItemType Directory -Path $unrelatedRoot | Out-Null
    Invoke-FixtureGit $unrelatedRoot @('init', '-q', '-b', 'baseline')
    Invoke-FixtureGit $unrelatedRoot @('config', 'user.email', 'test@example.com')
    Invoke-FixtureGit $unrelatedRoot @('config', 'user.name', 'Factory Test')
    New-Item -ItemType Directory -Force -Path (Join-Path $unrelatedRoot '.ai/factory') | Out-Null
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $unrelatedRoot '.ai/factory/factory.config.yaml')
    Set-Content -LiteralPath (Join-Path $unrelatedRoot 'seed.txt') -Value 'same tree' -Encoding utf8
    Invoke-FixtureGit $unrelatedRoot @('add', '-A'); Invoke-FixtureGit $unrelatedRoot @('commit', '-q', '-m', 'baseline')
    Invoke-FixtureGit $unrelatedRoot @('switch', '--orphan', 'unrelated')
    New-Item -ItemType Directory -Force -Path (Join-Path $unrelatedRoot '.ai/factory') | Out-Null
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $unrelatedRoot '.ai/factory/factory.config.yaml')
    Set-Content -LiteralPath (Join-Path $unrelatedRoot 'other-root.txt') -Value 'unrelated' -Encoding utf8
    Invoke-FixtureGit $unrelatedRoot @('add', '-A'); Invoke-FixtureGit $unrelatedRoot @('commit', '-q', '-m', 'unrelated root')
    $noBase = & pwsh -NoProfile -File $scriptPath -Root $unrelatedRoot -BaseRef baseline -HeadRef HEAD -ManifestPath '.ai/factory/factory.config.yaml' -OutputPath '' 2>&1
    Assert 'histories without a merge-base fail explicitly' ($LASTEXITCODE -ne 0 -and ($noBase -join "`n") -match 'no merge-base exists')
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "`n  $passed passed, $failed failed"
if ($failed) { exit 1 }
