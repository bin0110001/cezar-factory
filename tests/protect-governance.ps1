#!/usr/bin/env pwsh
# Exercises scripts/factory/protect-governance.ps1 against throwaway git repositories and tests/fake-gh-governance.ps1.
# Never touches the network, production, or this checkout.
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$guard = Join-Path $factory 'scripts/factory/protect-governance.ps1'
$fakeGh = Join-Path $PSScriptRoot 'fake-gh-governance.ps1'
$script:failures = 0
function Check([string]$Name, [bool]$Ok) { if ($Ok) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ } }
function G { & git -C $script:repo @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed" } }
function Write-F([string]$Rel, [string]$Text) {
    $p = Join-Path $script:repo $Rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
    Set-Content -LiteralPath $p -Value $Text -Encoding utf8
}
$ownership = '{"schemaVersion":1,"unmapped":"full","checks":[{"id":"a","patterns":["a/**","b/**"],"command":"run-a"},{"id":"b","patterns":["c/**"],"command":"run-b"}]}'
function New-Repo {
    $script:repo = Join-Path ([IO.Path]::GetTempPath()) "gov-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Path $script:repo | Out-Null
    G init -q -b main; G config user.email t@example.com; G config user.name t
    Write-F 'policies/risk.yaml' 'a: 1'; Write-F 'tests/baselines/x.json' '{}'; Write-F 'src/app.txt' 'one'
    Write-F '.ai/factory/test-ownership.json' $ownership
    Write-F 'ledger/run-1.json' '{"run":1}'
    G add -A; G commit -q -m base
    $script:base = ((& git -C $script:repo rev-parse HEAD) -join '').Trim()
}
function Run-Guard([string]$Marker = '', [string]$State = '') {
    $env:FAKE_GOV_STATE = $State
    $argList = @('-NoProfile', '-File', $guard, '-Root', $script:repo, '-Base', $script:base, '-Gh', $fakeGh, '-Repo', 'o/r',
        '-AuthorizationPath', $(if ($Marker) { $Marker } else { Join-Path $script:repo '.no-marker' }), '-ReportPath', (Join-Path $script:repo '.factory/governance-guard.json'))
    Push-Location $script:repo
    try { $out = & pwsh @argList 2>&1 | Out-String } finally { Pop-Location }
    [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}
function Commit-All { G add -A; G commit -q -m change }

Write-Host '== protect-governance =='
New-Repo
Write-F 'src/app.txt' 'two'; Write-F 'docs/new.md' 'x'; Commit-All
$r = Run-Guard
Check 'unprotected diff passes' ($r.code -eq 0 -and $r.out -match 'PASS')
G checkout -q -b clean-new; Write-F 'ledger/run-2.json' '{"run":2}'; Write-F '.ai/factory/test-ownership.json' ($ownership -replace '"c/\*\*"', '"c/**","d/**"'); Commit-All
$r = Run-Guard
Check 'append-only new ledger records and additive selection edits pass' ($r.code -eq 0)

$cases = @(
    @{ name = 'policy edit'; cat = 'policy'; file = 'policies/risk.yaml'; act = { Write-F 'policies/risk.yaml' 'a: 2' } },
    @{ name = 'policy delete'; cat = 'policy'; file = 'policies/risk.yaml'; act = { Remove-Item (Join-Path $script:repo 'policies/risk.yaml') } },
    @{ name = 'new policy file'; cat = 'policy'; file = 'policies/extra.yaml'; act = { Write-F 'policies/extra.yaml' 'z' } },
    @{ name = 'baseline edit'; cat = 'baseline'; file = 'tests/baselines/x.json'; act = { Write-F 'tests/baselines/x.json' '{"a":1}' } },
    @{ name = 'baseline rename'; cat = 'baseline'; file = 'tests/baselines/x.json'; act = { G mv tests/baselines/x.json src/x.json } },
    @{ name = 'ledger evidence edit'; cat = 'ledger-evidence'; file = 'ledger/run-1.json'; act = { Write-F 'ledger/run-1.json' '{"run":9}' } },
    @{ name = 'ledger evidence delete'; cat = 'ledger-evidence'; file = 'ledger/run-1.json'; act = { Remove-Item (Join-Path $script:repo 'ledger/run-1.json') } },
    @{ name = 'ledger evidence rename'; cat = 'ledger-evidence'; file = 'ledger/run-1.json'; act = { G mv ledger/run-1.json src/run-1.json } },
    @{ name = 'dropped mandatory check'; cat = 'check-selection'; file = '.ai/factory/test-ownership.json'; act = { Write-F '.ai/factory/test-ownership.json' '{"schemaVersion":1,"unmapped":"full","checks":[{"id":"a","patterns":["a/**","b/**"],"command":"run-a"}]}' } },
    @{ name = 'narrowed check patterns'; cat = 'check-selection'; file = '.ai/factory/test-ownership.json'; act = { Write-F '.ai/factory/test-ownership.json' ($ownership -replace '"a/\*\*","b/\*\*"', '"a/**"') } },
    @{ name = 'weakened check command'; cat = 'check-selection'; file = '.ai/factory/test-ownership.json'; act = { Write-F '.ai/factory/test-ownership.json' ($ownership -replace 'run-a', 'true') } },
    @{ name = 'unmapped policy relaxed'; cat = 'check-selection'; file = '.ai/factory/test-ownership.json'; act = { Write-F '.ai/factory/test-ownership.json' ($ownership -replace '"full"', '"skip"') } },
    @{ name = 'guard script edit'; cat = 'guard'; file = 'scripts/factory/protect-governance.ps1'; act = { Write-F 'scripts/factory/protect-governance.ps1' '# weakened' } }
)
foreach ($c in $cases) {
    New-Repo
    if ($c.cat -eq 'guard') { Write-F 'scripts/factory/protect-governance.ps1' '# orig'; Commit-All; $script:base = ((& git -C $script:repo rev-parse HEAD) -join '').Trim() }
    & $c.act
    $r = Run-Guard
    Check "$($c.name) fails, naming the file and category" ($r.code -ne 0 -and $r.out -match [regex]::Escape($c.file) -and $r.out -match "\[$($c.cat)\]" -and $r.out -match 'APPROVED GitHub review')
}
New-Repo; Write-F 'policies/risk.yaml' 'a: 2'
Check 'uncommitted (working-tree) policy edit is caught' ((Run-Guard).code -ne 0)
New-Repo; Write-F 'policies/risk.yaml' 'a: 2'; G add -A
Check 'staged policy edit is caught' ((Run-Guard).code -ne 0)

# Authorization.
New-Repo; Write-F 'policies/risk.yaml' 'a: 2'; Commit-All
$head = ((& git -C $script:repo rev-parse HEAD) -join '').Trim()
$pathsHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('policies/risk.yaml'))).Replace('-', '').ToLower()
function New-State($Over = @{}) {
    $review = @{ user = @{ login = 'reviewer1' }; state = 'APPROVED'; commit_id = $head; author_association = 'OWNER'; body = "ok factory-governance-waiver:$pathsHash"; html_url = 'https://example/review/1' }
    $s = @{ head = $head; author = 'agentuser'; actor = 'agentuser'; reviews = @($review) }
    foreach ($k in $Over.Keys) { $s[$k] = $Over[$k] }
    $p = Join-Path $script:repo '.state.json'; $s | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $p; $p
}
function New-Marker($Over = @{}) {
    $m = @{ schemaVersion = 1; pr = 7; reviewer = 'reviewer1'; headCommit = $head; paths = @('policies/risk.yaml') }
    foreach ($k in $Over.Keys) { $m[$k] = $Over[$k] }
    $p = Join-Path $script:repo '.marker.json'; $m | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $p; $p
}
$ledgerFile = Join-Path $script:repo '.factory/ledger/governance-waivers.jsonl'
function Review($Over) { $r = @{ user = @{ login = 'reviewer1' }; state = 'APPROVED'; commit_id = $head; author_association = 'OWNER'; body = "factory-governance-waiver:$pathsHash"; html_url = 'u' }; foreach ($k in $Over.Keys) { $r[$k] = $Over[$k] }; $r }
$forgeries = @(
    @{ name = 'marker without a GitHub review'; state = (New-State @{ reviews = @() }); marker = (New-Marker) },
    @{ name = 'review by the PR author'; state = (New-State @{ author = 'reviewer1' }); marker = (New-Marker) },
    @{ name = 'review by the acting agent identity'; state = (New-State @{ actor = 'reviewer1' }); marker = (New-Marker) },
    @{ name = 'review only COMMENTED'; state = (New-State @{ reviews = @(Review @{ state = 'COMMENTED' }) }); marker = (New-Marker) },
    @{ name = 'review on a stale commit'; state = (New-State @{ reviews = @(Review @{ commit_id = ('0' * 40) }) }); marker = (New-Marker) },
    @{ name = 'review from a non-collaborator'; state = (New-State @{ reviews = @(Review @{ author_association = 'NONE' }) }); marker = (New-Marker) },
    @{ name = 'review bound to other paths'; state = (New-State @{ reviews = @(Review @{ body = 'factory-governance-waiver:deadbeef' }) }); marker = (New-Marker) },
    @{ name = 'marker bound to another head commit'; state = (New-State); marker = (New-Marker @{ headCommit = ('1' * 40) }) },
    @{ name = 'marker covering other paths'; state = (New-State); marker = (New-Marker @{ paths = @('policies/other.yaml') }) },
    @{ name = 'marker with an extra self-asserted field'; state = (New-State); marker = (New-Marker @{ approved = $true }) }
)
foreach ($f in $forgeries) {
    Remove-Item $ledgerFile -ErrorAction SilentlyContinue
    $r = Run-Guard $f.marker $f.state
    Check "forgery rejected: $($f.name)" ($r.code -ne 0 -and -not (Test-Path $ledgerFile))
}
$env:FACTORY_GOVERNANCE_AUTHORIZED = '1'
Check 'environment variable is not a bypass' ((Run-Guard).code -ne 0)
Remove-Item Env:FACTORY_GOVERNANCE_AUTHORIZED
G commit -q --allow-empty -m "factory-governance-waiver: approved"
$head = ((& git -C $script:repo rev-parse HEAD) -join '').Trim()
Check 'commit-message tag is not a bypass' ((Run-Guard).code -ne 0)

$r = Run-Guard (New-Marker) (New-State)
Check 'valid authorized review passes with a visible waiver' ($r.code -eq 0 -and $r.out -match 'WAIVED by reviewer1' -and $r.out -match 'policies/risk.yaml')
Check 'waiver is appended to the ledger' ((Test-Path $ledgerFile) -and (Get-Content -Raw $ledgerFile) -match '"type":"governance-waiver"' -and (Get-Content -Raw $ledgerFile) -match 'reviewer1')
# The branch merged a newer dev (another run's feature touched a protected path). That is not this change's work; the
# guard measures from where the merge joined the real remote's dev. A forged local origin/dev ref must not help.
Write-Host '== protect-governance: base moves forward to the real dev =='
function Run-GuardAuto {
    $env:FAKE_GOV_STATE = ''
    $argList = @('-NoProfile', '-File', $guard, '-Root', $script:repo, '-Gh', $fakeGh, '-Repo', 'o/r',
        '-AuthorizationPath', (Join-Path $script:repo '.no-marker'), '-ReportPath', (Join-Path $script:repo '.factory/governance-guard.json'))
    Push-Location $script:repo
    try { $out = & pwsh @argList 2>&1 | Out-String } finally { Pop-Location }
    [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}
New-Repo
$origin = Join-Path ([IO.Path]::GetTempPath()) "gov-origin-$([guid]::NewGuid().ToString('N').Substring(0, 8)).git"
& git init -q --bare $origin; if ($LASTEXITCODE -ne 0) { throw 'git init --bare failed' }
G remote add origin $origin; G push -q origin main:dev
New-Item -ItemType Directory -Force (Join-Path $script:repo '.factory') | Out-Null
(@{ environment = @{ baseCommit = $script:base } } | ConvertTo-Json) | Set-Content (Join-Path $script:repo '.factory/implementation-context.json')
G checkout -q -b cez/work
$other = Join-Path ([IO.Path]::GetTempPath()) "gov-other-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
& git clone -q -b dev $origin $other
& git -C $other config user.email o@example.com; & git -C $other config user.name o
Set-Content (Join-Path $other 'policies/risk.yaml') 'a: 2'; & git -C $other commit -qam 'another run merged a policy change'; & git -C $other push -q origin dev
Write-F 'src/app.txt' 'mine'; Commit-All
G fetch -q origin; G merge -q --no-edit origin/dev
$r = Run-GuardAuto
Check 'a protected change that arrived by merging the real dev is not charged to the branch' ($r.code -eq 0 -and $r.out -match 'PASS')
$explicit = Run-Guard
Check 'an explicit -Base is used as given (the same history is refused from the run start)' ($explicit.code -ne 0)
Write-F 'policies/risk.yaml' 'a: 3'; Commit-All
$r = Run-GuardAuto
Check 'the branch own protected change is still refused after the merge' ($r.code -ne 0 -and $r.out -match 'policies/risk.yaml')
G update-ref refs/remotes/origin/dev HEAD
$r = Run-GuardAuto
Check 'a forged local origin/dev ref does not hide the branch own protected change' ($r.code -ne 0 -and $r.out -match 'policies/risk.yaml')
Remove-Item -Recurse -Force $origin, $other -ErrorAction SilentlyContinue

if ($script:failures) { Write-Host "protect-governance: $script:failures failure(s)"; exit 1 }
Write-Host 'protect-governance: all checks passed'
