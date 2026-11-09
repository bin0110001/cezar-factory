#!/usr/bin/env pwsh
# Fixture-based tests for scripts/verification-query.ps1 (pagination, redaction, ordering, oversized artifacts).
$ErrorActionPreference = 'Stop'
$factory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $factory 'scripts/verification-query.ps1')
$schema = Join-Path $factory 'schemas/verification-query.schema.json'
$script:failures = 0
function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $Name" } else { Write-Host "  FAIL $Name"; $script:failures++ }
}
function Q { param([hashtable]$Args2) Invoke-VerificationQuery @Args2 }

$secretToken = 'ghp_' + ('A1b2' * 8)
$big = ('line of build output ' * 400) + "`nAuthorization: Bearer abcdef1234567890SECRET`n" + ('tail text ' * 400)
# Deliberately unordered input, with a tie on startedAt and a duplicated failure id.
$snapshot = Read-VqJson (@{
    schemaVersion = 1
    runs = @(
        @{ id = 'run-b'; startedAt = '2026-10-01T10:00:00Z'; finishedAt = '2026-10-01T10:05:00Z'; status = 'failed'; commitSha = 'b' * 40; baseSha = 'a' * 40
           selected = @(@{ testId = 't-2'; reason = 'touches src/b' }, @{ testId = 't-1'; reason = 'touches src/a' })
           deferred = @(@{ testId = 't-9'; reason = 'slow suite deferred to nightly' })
           failures = @(@{ id = 'f-2'; testId = 't-2'; status = 'failed'; message = "password=hunter2 failed"; output = $big }, @{ id = 'f-1'; testId = 't-1'; status = 'unknown'; message = 'timeout'; output = 'short' }, @{ id = 'f-1'; testId = 't-1'; status = 'unknown'; message = 'timeout again'; output = 'short' })
           episodes = @(@{ id = 'e-1'; fingerprint = 'fp-1'; status = 'open'; firstSeenAt = '2026-09-01T00:00:00Z'; lastSeenAt = '2026-10-01T10:00:00Z'; occurrences = 4 })
           artifacts = @(@{ id = 'a-big'; name = 'build.log'; path = 'artifacts/build.log'; mediaType = 'text/plain'; content = $big }, @{ id = 'a-small'; name = 'notes'; path = 'artifacts/notes.txt'; mediaType = 'text/plain'; content = 'token: ' + $secretToken })
           baseline = @{ baselineRunId = 'run-a'; status = 'regressed'; regressions = @('t-2', 't-1'); fixed = @('t-7'); unchanged = 12 } }
        @{ id = 'run-a'; startedAt = '2026-10-01T10:00:00Z'; finishedAt = '2026-10-01T10:01:00Z'; status = 'passed'; commitSha = 'a' * 40; baseSha = ''; selected = @(); deferred = @(); failures = @(); episodes = @(); artifacts = @() }
        @{ id = 'run-c'; startedAt = '2026-10-02T09:00:00Z'; finishedAt = '2026-10-02T09:01:00Z'; status = 'passed'; commitSha = 'c' * 40; baseSha = 'b' * 40; selected = @(); deferred = @(); failures = @(); episodes = @(); artifacts = @() }
    )
} | ConvertTo-Json -Depth 12)

function Page([string]$Kind, [string]$Cursor = '', [int]$Size = 50, [hashtable]$Extra = @{}) {
    $a = @{ Snapshot = $snapshot; Kind = $Kind; PageSize = $Size } + $Extra
    if ($Cursor) { $a.Cursor = $Cursor }
    Invoke-VerificationQuery @a
}
function Validates([string]$Json) { try { [bool](Test-Json -Json $Json -SchemaFile $schema -ErrorAction Stop) } catch { $false } }

Write-Host '== ordering and determinism =='
$runs1 = Page 'runs'; $runs2 = Page 'runs'
Check 'the same query returns byte-identical output' ($runs1 -ceq $runs2)
$ids = @((ConvertFrom-Json $runs1).items | ForEach-Object { $_.id })
Check 'runs order by startedAt descending with run id as the tiebreaker' (($ids -join ',') -ceq 'run-c,run-a,run-b')
$reordered = Read-VqJson ($snapshot | ConvertTo-Json -Depth 12)
$reordered.runs = @($reordered.runs[2], $reordered.runs[0], $reordered.runs[1])
Check 'input order does not change the output' ((Invoke-VerificationQuery -Snapshot $reordered -Kind runs) -ceq $runs1)
Check 'keys are serialised in sorted order and no query-time timestamp is added' ($runs1 -match '^\{"items":' -and $runs1 -notmatch 'generatedAt|queriedAt')
Check 'ordering is ordinal, not culture dependent' ((Compare-VqKey @{ s = 'x'; r = 'B'; i = '' } @{ s = 'x'; r = 'a'; i = '' }) -lt 0)

Write-Host '== pagination =='
$seen = @(); $cursor = ''; $pages = 0
do {
    $p = ConvertFrom-Json (Page 'failures' $cursor 1)
    $seen += @($p.items | ForEach-Object { $_.id }); $cursor = $p.page.nextCursor; $pages++
} while ($cursor -and $pages -lt 10)
$unpaged = @((ConvertFrom-Json (Page 'failures')).items | ForEach-Object { $_.id })
Check 'following nextCursor returns every item exactly once, in the unpaged order' ($seen.Count -eq 3 -and ($seen -join ',') -ceq ($unpaged -join ','))
Check 'duplicate ids stay distinct and ordered (f-1, f-1~1, f-2)' (($unpaged -join ',') -ceq 'f-1,f-1,f-2')
Check 'the last page has no nextCursor and hasMore is false' (-not $cursor -and -not $p.page.hasMore)
$first = ConvertFrom-Json (Page 'failures' '' 1)
Check 'a first page reports hasMore and an opaque cursor' ($first.page.hasMore -and $first.page.nextCursor -and $first.page.nextCursor -notmatch '[{}"]')
$bad = ConvertFrom-Json (Page 'failures' 'not-a-cursor!!')
Check 'a malformed cursor returns a structured invalid_cursor error, not a page' ($bad.error.code -eq 'invalid_cursor' -and -not $bad.items)
$other = ConvertFrom-Json (Page 'artifacts' $first.page.nextCursor 1)
Check 'a cursor from another query is rejected as stale' ($other.error.code -eq 'stale_cursor')
$filtered = ConvertFrom-Json (Page 'failures' $first.page.nextCursor 1 @{ Status = 'failed' })
Check 'a cursor is bound to the query filters' ($filtered.error.code -eq 'stale_cursor')
$json = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($first.page.nextCursor.Replace('-', '+').Replace('_', '/')) + ('=' * ((4 - $first.page.nextCursor.Length % 4) % 4)))) -replace '"v":1', '"v":2')
$v2 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
Check 'a cursor from another schema version is rejected as stale' ((ConvertFrom-Json (Page 'failures' $v2 1)).error.code -eq 'stale_cursor')
Check 'an unknown kind and an out-of-range page size are structured errors' ((ConvertFrom-Json (Page 'nonsense')).error.code -eq 'invalid_query' -and (ConvertFrom-Json (Page 'runs' '' 0)).error.code -eq 'invalid_query')
Check 'an unknown input schemaVersion is rejected' ((ConvertFrom-Json (Invoke-VerificationQuery -Snapshot @{ schemaVersion = 2; runs = @() } -Kind runs)).error.code -eq 'unsupported_input_version')

Write-Host '== redaction =='
$all = (Page 'failures') + (Page 'artifacts') + (Page 'baseline') + (Page 'runs')
Check 'secrets never appear in any response' ($all -notmatch 'hunter2' -and $all -notmatch [regex]::Escape($secretToken) -and $all -notmatch 'abcdef1234567890SECRET')
Check 'redacted values carry the fixed marker' ($all -match [regex]::Escape($script:VqRedaction))
$cases = @(
    'Authorization: Bearer abc123def456ghi789', 'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"', 'db url postgres://admin:s3cr3tpw@db.internal/app',
    "-----BEGIN RSA PRIVATE KEY-----`nMIIBOgIBAAJBAK`n-----END RSA PRIVATE KEY-----", '{"client_secret": "zzzzzzzz-1111"}', 'vault hvs.CAESIabcdefghijklmnopqrstuvwxyz', 'AWS AKIAABCDEFGHIJKLMNOP', 'X-Api-Key: 998877665544'
)
foreach ($c in $cases) {
    $r = Protect-VqText $c
    Check "redacts: $($c.Substring(0, [Math]::Min(34, $c.Length)).Replace("`n", ' '))" ($r -match [regex]::Escape($script:VqRedaction) -and $r -notmatch 'abc123def456|abcdefghijklmnopqrstuvwxyz1|s3cr3tpw|MIIBOgIBAAJBAK|zzzzzzzz|CAESIabc|ABCDEFGHIJKLMNOP|998877665544')
}
Check 'ordinary text is left untouched' ((Protect-VqText 'test t-1 failed at src/a.ts:12') -ceq 'test t-1 failed at src/a.ts:12')
Check 'known secret values from the environment are scrubbed anywhere' ((Protect-VqText 'built with zebra-quartz-77 ok' @('zebra-quartz-77')) -ceq "built with $($script:VqRedaction) ok")
Check 'secret-named structured fields are redacted wholesale' ((Protect-VqValue @{ db_password = 'x'; note = 'ok' }).db_password -ceq $script:VqRedaction)
$withSecretKnown = ConvertFrom-Json (Invoke-VerificationQuery -Snapshot $snapshot -Kind failures -KnownSecrets @('short'))
Check 'known secrets are scrubbed in query output' (($withSecretKnown.items | ForEach-Object { $_.output.content }) -notcontains 'short')
$art = (ConvertFrom-Json (Page 'artifacts')).items | Where-Object { $_.id -eq 'a-big' }
Check 'secrets in the dropped middle or in excerpts never leak' (($art | ConvertTo-Json -Depth 8) -notmatch 'abcdef1234567890SECRET')

Write-Host '== oversized artifacts =='
Check 'an artifact over the cap is truncated: head and tail excerpts, no inline content' ($art.data.truncated -and $null -eq $art.data.content -and $art.data.head.Length -le 512 -and $art.data.tail.Length -le 512 -and $art.data.head -and $art.data.tail)
Check 'the response carries the original byte size, sha256 and a reference' ($art.data.bytes -eq [Text.Encoding]::UTF8.GetByteCount($big) -and $art.data.sha256 -ceq (Get-VqSha256 $big) -and $art.data.reference -ceq 'run:run-b/artifacts/a-big')
Check 'the full content is never returned' ((Page 'artifacts').Length -lt $big.Length)
$small = (ConvertFrom-Json (Page 'artifacts')).items | Where-Object { $_.id -eq 'a-small' }
Check 'a small artifact is returned inline, redacted' (-not $small.data.truncated -and $small.data.content -ceq "token: $($script:VqRedaction)")
$tiny = ConvertFrom-Json (Invoke-VerificationQuery -Snapshot $snapshot -Kind artifacts -InlineBytes 4 -ExcerptChars 3)
Check 'caps are configurable per query' (($tiny.items | Where-Object { $_.id -eq 'a-small' }).data.truncated)
$capped = Invoke-VerificationQuery -Snapshot $snapshot -Kind failures -MaxResponseBytes 1500
$cappedObj = ConvertFrom-Json $capped
Check 'the total response is capped and the remainder stays reachable through the cursor' ([Text.Encoding]::UTF8.GetByteCount($capped) -le 1500 -and $cappedObj.page.hasMore -and $cappedObj.page.nextCursor -and $cappedObj.items.Count -ge 1)

Write-Host '== content and schema =='
$run = (ConvertFrom-Json (Page 'runs')).items | Where-Object { $_.id -eq 'run-b' }
Check 'runs carry counts and the baseline reference' ($run.counts.failures -eq 3 -and $run.counts.selected -eq 2 -and $run.baselineRunId -eq 'run-a')
$sel = (ConvertFrom-Json (Page 'selected')).items; $def = (ConvertFrom-Json (Page 'deferred')).items
Check 'selected and deferred tests carry explanations' (($sel | ForEach-Object { $_.testId }) -join ',' -ceq 't-1,t-2' -and $sel[0].reason.content -ceq 'touches src/a' -and $def[0].reason.content -match 'nightly')
$ep = (ConvertFrom-Json (Page 'episodes')).items
Check 'recurrence episodes are returned' ($ep.Count -eq 1 -and $ep[0].occurrences -eq 4)
$bl = (ConvertFrom-Json (Page 'baseline')).items
Check 'baseline comparison lists sorted regressions and fixes' ($bl.Count -eq 1 -and ($bl[0].regressions -join ',') -ceq 't-1,t-2' -and $bl[0].unchanged -eq 12)
Check 'run filter narrows results' (@((ConvertFrom-Json (Page 'runs' '' 50 @{ RunId = 'run-a' })).items).Count -eq 1)
foreach ($k in 'runs', 'selected', 'deferred', 'failures', 'episodes', 'artifacts', 'baseline') { Check "the $k response validates against the schema" (Validates (Page $k)) }
Check 'an error response validates against the schema' (Validates (Page 'failures' 'garbage'))
Check 'a response with an unknown schemaVersion fails the schema' (-not (Validates ((Page 'runs') -replace '"schemaVersion":1', '"schemaVersion":9')))

Write-Host '== executor adapter =='
$fixture = Join-Path $factory 'cezar/packages/contract/fixtures/verification/failed-result.json'
if (Test-Path $fixture) {
    $adapted = ConvertFrom-VerificationRunResult (Read-VqJson (Get-Content -Raw $fixture))
    $snap = @{ schemaVersion = 1; runs = @($adapted) }
    $f = ConvertFrom-Json (Invoke-VerificationQuery -Snapshot $snap -Kind failures)
    Check 'an executor result maps to runs, selected tests and failures' ($f.items.Count -eq 1 -and $f.items[0].testId -eq 'parse' -and (ConvertFrom-Json (Invoke-VerificationQuery -Snapshot $snap -Kind runs)).items[0].id -eq 'v-1')
    $runQuery = ConvertFrom-Json (Invoke-VerificationQuery -Snapshot $snap -Kind runs)
    Check 'executor queries expose per-check duration, metrics and fingerprint' ($runQuery.items[0].checks[0].durationMs -eq 1 -and $runQuery.items[0].checks[0].metrics[0].name -eq 'parse-ms' -and $runQuery.items[0].checks[0].findingFingerprint -eq ('a' * 64))
    Check 'executor failures expose new-vs-known classification and episode link' ($f.items[0].classification -eq 'new' -and $f.items[0].episodeId -eq ('a' * 64))
}

if ($script:failures) { Write-Host "verification-query: $script:failures failure(s)"; exit 1 }
Write-Host 'verification-query: all passed'
