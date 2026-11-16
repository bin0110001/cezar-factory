#!/usr/bin/env pwsh
# Negative tests for collection-boundary secret redaction (#579).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scripts/failure-summary-lib.ps1')
$failures = 0
function Check([string]$name, [bool]$c) { if ($c) { Write-Host "  ok   $name" } else { Write-Host "  FAIL $name"; $script:failures++ } }

$gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'
$envSecret = 'envvalue-Zq9x8w7v6u5t'
$text = "Authorization: Bearer $gh`nGH_TOKEN=plainsecret99 https://u:s3cretpass@example.com/r.git AKIAABCDEFGHIJKLMNOP leaked $envSecret"
$out = Invoke-FactoryRedact -Text $text -Env @{ SERVICE_API_KEY = $envSecret; PATH = '/usr/bin' }
foreach ($leak in $gh, 'plainsecret99', 's3cretpass', 'AKIAABCDEFGHIJKLMNOP', $envSecret) {
    Check "shared helper masks $($leak.Substring(0, 4))..." ($out -notmatch [regex]::Escape($leak))
}
Check 'ordinary identifiers and SHAs are kept' ((Invoke-FactoryRedact -Text 'commit 0123456789abcdef0123456789abcdef01234567 issue #579' -Env @{}) -ceq 'commit 0123456789abcdef0123456789abcdef01234567 issue #579')
Check 'Protect-FailureText masks Authorization headers' ((Protect-FailureText "Authorization: Bearer $gh") -notmatch [regex]::Escape($gh))

# Issue body -> implementation context handoff.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("redact-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$issueJson = @{ number = 7; title = 'secret title'; body = "body $gh and password: hunter2hunter2"; labels = @(); state = 'OPEN'; url = 'u'
    comments = @(@{ body = "comment https://u:s3cretpass@example.com/ token=plainsecret99" }) } | ConvertTo-Json -Depth 6 -Compress
$fake = Join-Path $tmp 'fake-gh.ps1'
Set-Content -Path $fake -Value "`$global:LASTEXITCODE = 0; Write-Output '$($issueJson -replace "'", "''")'"
$ctx = Join-Path $tmp 'ctx.json'
Push-Location $tmp
try { & pwsh -NoProfile -File (Join-Path $root 'scripts/prepare-implementation.ps1') -Issue 7 -GhCommand $fake -OutputPath $ctx | Out-Null } finally { Pop-Location }
$written = Get-Content -Raw $ctx
Check 'implementation context was written' ($LASTEXITCODE -eq 0 -and $written.Length -gt 0)
foreach ($leak in $gh, 'hunter2hunter2', 's3cretpass', 'plainsecret99') {
    Check "implementation context masks $($leak.Substring(0, 4))..." ($written -notmatch [regex]::Escape($leak))
}
Remove-Item -Recurse -Force $tmp
if ($failures) { exit 1 }
