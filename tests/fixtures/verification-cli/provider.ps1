# Fixture verification provider for tests/verification-cli.ps1: the contract a real provider implements.
#   Get-VerificationCatalog              -> @{ profiles = @{ quick|standard|full = ids }; tests = @(@{ testId; paths }) }
#   Get-VerificationHistory              -> query-layer snapshot (docs/verification-query.md)
#   Invoke-VerificationTests -TestIds    -> @(@{ testId; status; message; output; fingerprint }) (status passed|failed|unknown|infrastructure-error|cancelled)
#   Get-VerificationChangedPaths         -> optional list of changed repo paths for `affected`
$script:Fixture = Get-Content -Raw (Join-Path $PSScriptRoot 'fixture.json') | ConvertFrom-Json -AsHashtable
if ($env:VC_OUTCOMES) { $script:Fixture.outcomes = $env:VC_OUTCOMES | ConvertFrom-Json -AsHashtable }
function Get-VerificationCatalog { $script:Fixture.catalog }
function Get-VerificationHistory { $script:Fixture.history }
function Invoke-VerificationTests {
    param([string[]]$TestIds)
    foreach ($id in $TestIds) {
        $o = $script:Fixture.outcomes[$id]
        if ($o -and $o.status -eq 'throw') { throw 'fixture executor crashed' }
        if ($o) { @{ testId = $id; status = $o.status; message = $o.message; output = $o.output; fingerprint = $o.fingerprint } } else { @{ testId = $id; status = 'passed' } }
    }
}
