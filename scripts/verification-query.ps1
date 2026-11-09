#!/usr/bin/env pwsh
# Verification query layer: a shared, read-only view over verification ledger/executor results.
#
# Dot-source this file; it defines functions only and has no side effects, so the CLI and UI
# (sibling issues under #57) can both call Invoke-VerificationQuery. See docs/verification-query.md
# and schemas/verification-query.schema.json for the input contract and the response schema.
#
#   . ./scripts/verification-query.ps1
#   $json = Invoke-VerificationQuery -Snapshot $snapshot -Kind failures -PageSize 20
#
# Guarantees: identical input + query => byte-identical output (ordinal ordering with explicit
# tiebreakers, sorted keys, no query-time timestamps); opaque keyset cursors bound to the query and
# schema version; secrets replaced by a fixed marker; large text and artifacts reduced to a bounded
# head/tail excerpt plus size, sha256 and reference; whole response capped.

$script:VqSchemaVersion = 1
$script:VqRedaction = '[REDACTED]'
$script:VqKinds = @('runs', 'selected', 'deferred', 'failures', 'episodes', 'artifacts', 'baseline')
$script:VqDefaults = @{ PageSize = 50; MaxPageSize = 200; InlineBytes = 2048; ExcerptChars = 512; MaxResponseBytes = 262144 }

# ---- small helpers ---------------------------------------------------------------------------
function Get-VqProp($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] } else { return $null } }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { $p.Value } else { $null }
}

function ConvertTo-VqString($Value) {
    if ($null -eq $Value) { return '' }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture) }
    [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', $Value)
}

function Get-VqSha256([string]$Text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    ([BitConverter]::ToString($hash).Replace('-', '')).ToLowerInvariant()
}

function ConvertTo-VqJsonString([string]$Text) { ConvertTo-Json -InputObject $Text -Compress }

function ConvertTo-VqCanonicalJson($Value) {
    # Compact JSON with ordinally sorted keys, independent of locale and hashtable order.
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [string] -or $Value -is [datetime]) { return (ConvertTo-VqJsonString (ConvertTo-VqString $Value)) }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte]) { return ([long]$Value).ToString([Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) { return ([double]$Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [string[]]@($Value.Keys | ForEach-Object { [string]$_ })
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        $parts = foreach ($k in $keys) { (ConvertTo-VqJsonString $k) + ':' + (ConvertTo-VqCanonicalJson $Value[$k]) }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = foreach ($e in $Value) { ConvertTo-VqCanonicalJson $e }
        return '[' + (@($parts) -join ',') + ']'
    }
    if ($Value -is [pscustomobject]) {
        $h = [ordered]@{}; foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = $p.Value }
        return ConvertTo-VqCanonicalJson $h
    }
    (ConvertTo-VqJsonString (ConvertTo-VqString $Value))
}

function Read-VqJson([string]$Text) {
    # Hashtables keep key lookup simple; dates stay strings where the runtime supports it.
    $parameters = (Get-Command ConvertFrom-Json).Parameters
    if ($parameters.ContainsKey('DateKind')) { return ConvertFrom-Json -InputObject $Text -AsHashtable -DateKind String -Depth 64 }
    ConvertFrom-Json -InputObject $Text -AsHashtable -Depth 64
}

# ---- redaction -------------------------------------------------------------------------------
$script:VqSecretKeyPattern = '(?i)(pass(word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|auth[_-]?header|cookie|session[_-]?id|vault)'
$script:VqTextPatterns = @(
    # PEM private key blocks (also unterminated ones: fail closed to end of text).
    @{ Pattern = '(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|\z)'; Replace = $script:VqRedaction }
    # Authorization / Proxy-Authorization / Cookie headers consume the rest of the line.
    @{ Pattern = '(?im)\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key)(\s*[:=]\s*)[^\r\n]+'; Replace = '$1$2' + $script:VqRedaction }
    # Bearer / Basic credentials anywhere.
    @{ Pattern = '(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}'; Replace = '$1 ' + $script:VqRedaction }
    # key=value / key: value / "key": "value" where the key names a secret.
    @{ Pattern = '(?i)(["'']?[\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[\w.-]*["'']?\s*[:=]\s*)("[^"\r\n]*"|''[^''\r\n]*''|[^\s,;&"'']+)'; Replace = '$1' + $script:VqRedaction }
    # URL userinfo.
    @{ Pattern = '(?i)(\b[a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@'; Replace = '$1' + $script:VqRedaction + '@' }
    # Well-known token shapes (GitHub, Slack, AWS, OpenAI-style, Vault, JWT).
    @{ Pattern = '\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|hvs\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})'; Replace = $script:VqRedaction }
)

function Protect-VqText([string]$Text, [string[]]$KnownSecrets = @()) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $out = $Text
    foreach ($secret in $KnownSecrets) { if ($secret -and $secret.Length -ge 4) { $out = $out.Replace($secret, $script:VqRedaction) } }
    foreach ($rule in $script:VqTextPatterns) { $out = [regex]::Replace($out, $rule.Pattern, $rule.Replace) }
    $out
}

function Protect-VqValue($Value, [string]$KeyName = '', [string[]]$KnownSecrets = @()) {
    # Structured redaction: a secret-looking field name hides its whole value; strings are scrubbed.
    if ($null -eq $Value) { return $null }
    if ($KeyName -and $KeyName -match $script:VqSecretKeyPattern -and ($Value -is [string] -or $Value -is [ValueType])) {
        return $script:VqRedaction
    }
    if ($Value -is [string]) { return Protect-VqText $Value $KnownSecrets }
    if ($Value -is [System.Collections.IDictionary]) {
        $h = [ordered]@{}
        foreach ($k in $Value.Keys) { $h[[string]$k] = Protect-VqValue $Value[$k] ([string]$k) $KnownSecrets }
        return $h
    }
    if ($Value -is [System.Collections.IEnumerable]) { return @(foreach ($e in $Value) { Protect-VqValue $e $KeyName $KnownSecrets }) }
    $Value
}

# ---- bounding --------------------------------------------------------------------------------
function New-VqBoundedText([string]$Text, [string]$Reference, [hashtable]$Limits, [string[]]$KnownSecrets) {
    # Hash and size describe the original bytes (so a retriever can verify the reference);
    # the returned text is always redacted, and over the cap only a head/tail excerpt is returned.
    $original = if ($null -eq $Text) { '' } else { $Text }
    $bytes = [Text.Encoding]::UTF8.GetByteCount($original)
    $redacted = Protect-VqText $original $KnownSecrets
    $result = [ordered]@{ bytes = $bytes; sha256 = (Get-VqSha256 $original); truncated = $false; content = $null; head = $null; tail = $null; reference = $Reference }
    if ($bytes -le $Limits.InlineBytes) { $result.content = $redacted; return $result }
    $n = $Limits.ExcerptChars
    $result.truncated = $true
    $result.head = $redacted.Substring(0, [Math]::Min($n, $redacted.Length))
    $result.tail = if ($redacted.Length -gt $n) { $redacted.Substring([Math]::Max($n, $redacted.Length - $n)) } else { '' }
    $result
}

# ---- adapter for executor results (#50) ------------------------------------------------------
function ConvertFrom-VerificationRunResult {
    <# .SYNOPSIS Maps one executor VerificationRun result (resultVersion 1) into a query-layer run record. #>
    param([Parameter(Mandatory)]$Result)
    $selected = @(); $deferred = @(); $failures = @(); $artifacts = @(); $checks = @()
    foreach ($check in @(Get-VqProp $Result 'checks')) {
        $id = [string](Get-VqProp $check 'checkId'); $status = [string](Get-VqProp $check 'status')
        $checkRow = [ordered]@{
            checkId = $id; status = $status; durationMs = [long](Get-VqProp $check 'durationMs')
            metrics = @(Get-VqProp $check 'metrics')
        }
        $fingerprint = Get-VqProp $check 'findingFingerprint'
        if ($fingerprint) { $checkRow.findingFingerprint = [string]$fingerprint }
        $checks += $checkRow
        if ($status -eq 'not-selected') { $deferred += [ordered]@{ testId = $id; reason = 'not selected for this run' }; continue }
        $selected += [ordered]@{ testId = $id; reason = $(if (Get-VqProp $check 'required') { 'required check' } else { 'optional check' }) }
        if ($status -in @('failed', 'unknown', 'infrastructure-error', 'cancelled')) {
            $diag = @(@(Get-VqProp $check 'diagnostics') | ForEach-Object { [string](Get-VqProp $_ 'message') }) -join "`n"
            $failure = [ordered]@{ id = "$id#$([string](Get-VqProp $check 'attempt'))"; testId = $id; status = $status; message = $diag; output = [string](Get-VqProp $check 'outputPreview') }
            $fingerprint = Get-VqProp $check 'findingFingerprint'
            if ($fingerprint) { $failure.episodeId = [string]$fingerprint }
            $failures += $failure
        }
        foreach ($a in @(Get-VqProp $check 'artifacts')) { $artifacts += [ordered]@{ id = [string](Get-VqProp $a 'sha256'); name = "$id/$([string](Get-VqProp $a 'path'))"; path = [string](Get-VqProp $a 'path'); mediaType = [string](Get-VqProp $a 'mediaType'); bytes = Get-VqProp $a 'bytes'; sha256 = [string](Get-VqProp $a 'sha256') } }
    }
    foreach ($a in @(Get-VqProp $Result 'artifacts')) { $artifacts += [ordered]@{ id = [string](Get-VqProp $a 'sha256'); name = [string](Get-VqProp $a 'path'); path = [string](Get-VqProp $a 'path'); mediaType = [string](Get-VqProp $a 'mediaType'); bytes = Get-VqProp $a 'bytes'; sha256 = [string](Get-VqProp $a 'sha256') } }
    [ordered]@{
        id = [string](Get-VqProp $Result 'verificationId'); startedAt = ConvertTo-VqString (Get-VqProp $Result 'startedAt')
        finishedAt = ConvertTo-VqString (Get-VqProp $Result 'finishedAt'); status = [string](Get-VqProp $Result 'status')
        commitSha = [string](Get-VqProp $Result 'commitSha'); baseSha = [string](Get-VqProp $Result 'baseSha')
        selected = $selected; deferred = $deferred; failures = $failures; episodes = @(); artifacts = $artifacts; baseline = $null; checks = $checks
    }
}

# ---- query -----------------------------------------------------------------------------------
function New-VqError([string]$Code, [string]$Message) {
    [ordered]@{ schemaVersion = $script:VqSchemaVersion; error = [ordered]@{ code = $Code; message = $Message } }
}

function ConvertTo-VqCursor($After, [string]$QueryHash) {
    $json = ConvertTo-VqCanonicalJson ([ordered]@{ v = $script:VqSchemaVersion; q = $QueryHash; s = $After.s; r = $After.r; i = $After.i })
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-VqCursor([string]$Cursor, [string]$QueryHash) {
    # Returns @{ After = ...} or @{ Error = ... }; never a partial page.
    try {
        $b64 = $Cursor.Replace('-', '+').Replace('_', '/')
        $b64 += '=' * ((4 - $b64.Length % 4) % 4)
        $c = Read-VqJson ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)))
        if ($c -isnot [System.Collections.IDictionary]) { throw 'not an object' }
        foreach ($f in 'v', 'q', 's', 'r', 'i') { if (-not $c.Contains($f)) { throw "missing $f" } }
    } catch {
        return @{ Error = (New-VqError 'invalid_cursor' 'The cursor is malformed.') }
    }
    if ([int]$c.v -ne $script:VqSchemaVersion) { return @{ Error = (New-VqError 'stale_cursor' 'The cursor was issued for a different schema version.') } }
    if ([string]$c.q -ne $QueryHash) { return @{ Error = (New-VqError 'stale_cursor' 'The cursor was issued for a different query.') } }
    @{ After = @{ s = [string]$c.s; r = [string]$c.r; i = [string]$c.i } }
}

function Compare-VqKey($A, $B) {
    # startedAt descending, then run id and item key ascending; ordinal, culture independent.
    $c = [string]::CompareOrdinal($B.s, $A.s); if ($c -ne 0) { return $c }
    $c = [string]::CompareOrdinal($A.r, $B.r); if ($c -ne 0) { return $c }
    [string]::CompareOrdinal($A.i, $B.i)
}

function Get-VqItems($Snapshot, [string]$Kind, [hashtable]$Limits, [string[]]$KnownSecrets, [string]$RunId, [string]$Status) {
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($run in @(Get-VqProp $Snapshot 'runs')) {
        $rid = ConvertTo-VqString (Get-VqProp $run 'id'); $started = ConvertTo-VqString (Get-VqProp $run 'startedAt')
        if ($RunId -and $rid -ne $RunId) { continue }
        $runStatus = ConvertTo-VqString (Get-VqProp $run 'status')
        $baseline = Get-VqProp $run 'baseline'
        $add = {
            param($Key, $Body)
            $items.Add([pscustomobject]@{ Key = @{ s = $started; r = $rid; i = $Key }; Body = $Body })
        }
        $sub = { param($Name) @(Get-VqProp $run $Name) | Where-Object { $null -ne $_ } }
        switch ($Kind) {
            'runs' {
                if ($Status -and $runStatus -ne $Status) { continue }
                & $add '' ([ordered]@{
                    id = $rid; startedAt = $started; finishedAt = ConvertTo-VqString (Get-VqProp $run 'finishedAt'); status = $runStatus
                    commitSha = ConvertTo-VqString (Get-VqProp $run 'commitSha'); baseSha = ConvertTo-VqString (Get-VqProp $run 'baseSha')
                    suite = ConvertTo-VqString (Get-VqProp $run 'suite')
                    counts = [ordered]@{ selected = @(& $sub 'selected').Count; deferred = @(& $sub 'deferred').Count; failures = @(& $sub 'failures').Count; episodes = @(& $sub 'episodes').Count; artifacts = @(& $sub 'artifacts').Count }
                    baselineRunId = $(if ($baseline) { ConvertTo-VqString (Get-VqProp $baseline 'baselineRunId') } else { $null })
                    checks = @(& $sub 'checks' | ForEach-Object {
                        $check = $_
                        $checkBody = [ordered]@{
                            checkId = ConvertTo-VqString (Get-VqProp $check 'checkId')
                            status = ConvertTo-VqString (Get-VqProp $check 'status')
                            durationMs = [long](Get-VqProp $check 'durationMs')
                            metrics = @(Get-VqProp $check 'metrics')
                        }
                        if (Get-VqProp $check 'findingFingerprint') { $checkBody.findingFingerprint = ConvertTo-VqString (Get-VqProp $check 'findingFingerprint') }
                        Protect-VqValue $checkBody '' $KnownSecrets
                    })
                })
            }
            { $_ -in 'selected', 'deferred' } {
                foreach ($t in & $sub $Kind) {
                    $tid = ConvertTo-VqString (Get-VqProp $t 'testId')
                    & $add $tid ([ordered]@{ runId = $rid; testId = $tid; reason = New-VqBoundedText (ConvertTo-VqString (Get-VqProp $t 'reason')) "run:$rid/$Kind/$tid" $Limits $KnownSecrets })
                }
            }
            'failures' {
                foreach ($f in & $sub 'failures') {
                    $fid = ConvertTo-VqString (Get-VqProp $f 'id'); $fs = ConvertTo-VqString (Get-VqProp $f 'status')
                    if ($Status -and $fs -ne $Status) { continue }
                    $failureBody = [ordered]@{
                        runId = $rid; id = $fid; testId = ConvertTo-VqString (Get-VqProp $f 'testId'); status = $fs
                        message = New-VqBoundedText (ConvertTo-VqString (Get-VqProp $f 'message')) "run:$rid/failures/$fid/message" $Limits $KnownSecrets
                        output = New-VqBoundedText (ConvertTo-VqString (Get-VqProp $f 'output')) "run:$rid/failures/$fid/output" $Limits $KnownSecrets
                    }
                    $episodeId = Get-VqProp $f 'episodeId'
                    if (-not $episodeId) { $episodeId = Get-VqProp $f 'findingFingerprint' }
                    $classification = Get-VqProp $f 'classification'
                    if ($classification -notin @('new', 'known', 'unknown')) {
                        if ($episodeId) {
                            $occurrences = 0
                            foreach ($historyRun in @(Get-VqProp $Snapshot 'runs')) {
                                foreach ($historyFailure in @(Get-VqProp $historyRun 'failures')) {
                                    $historyId = Get-VqProp $historyFailure 'episodeId'
                                    if (-not $historyId) { $historyId = Get-VqProp $historyFailure 'findingFingerprint' }
                                    if ($historyId -and [string]$historyId -ceq [string]$episodeId) { $occurrences++ }
                                }
                            }
                            $classification = if ($occurrences -gt 1) { 'known' } else { 'new' }
                        } else { $classification = 'unknown' }
                    }
                    $failureBody.classification = [string]$classification
                    if ($episodeId) { $failureBody.episodeId = ConvertTo-VqString $episodeId }
                    & $add $fid $failureBody
                }
            }
            'episodes' {
                foreach ($e in & $sub 'episodes') {
                    $eid = ConvertTo-VqString (Get-VqProp $e 'id'); $es = ConvertTo-VqString (Get-VqProp $e 'status')
                    if ($Status -and $es -ne $Status) { continue }
                    & $add $eid ([ordered]@{
                        runId = $rid; id = $eid; fingerprint = ConvertTo-VqString (Get-VqProp $e 'fingerprint'); status = $es
                        firstSeenAt = ConvertTo-VqString (Get-VqProp $e 'firstSeenAt'); lastSeenAt = ConvertTo-VqString (Get-VqProp $e 'lastSeenAt')
                        occurrences = [int](Get-VqProp $e 'occurrences')
                    })
                }
            }
            'artifacts' {
                foreach ($a in & $sub 'artifacts') {
                    $aid = ConvertTo-VqString (Get-VqProp $a 'id'); $path = ConvertTo-VqString (Get-VqProp $a 'path')
                    $ref = "run:$rid/artifacts/$aid"
                    $content = Get-VqProp $a 'content'
                    if ($null -ne $content) { $bounded = New-VqBoundedText ([string]$content) $ref $Limits $KnownSecrets }
                    else {
                        # Reference-only artifact (executor result): bytes/hash come from the producer, no content is held.
                        $bounded = [ordered]@{ bytes = [long](Get-VqProp $a 'bytes'); sha256 = ConvertTo-VqString (Get-VqProp $a 'sha256'); truncated = $true; content = $null; head = $null; tail = $null; reference = $ref }
                    }
                    & $add $aid ([ordered]@{ runId = $rid; id = $aid; name = Protect-VqText (ConvertTo-VqString (Get-VqProp $a 'name')) $KnownSecrets; path = Protect-VqText $path $KnownSecrets; mediaType = ConvertTo-VqString (Get-VqProp $a 'mediaType'); data = $bounded })
                }
            }
            'baseline' {
                if (-not $baseline) { continue }
                $bs = ConvertTo-VqString (Get-VqProp $baseline 'status')
                if ($Status -and $bs -ne $Status) { continue }
                $list = { param($n) [string[]]@(@(Get-VqProp $baseline $n) | Where-Object { $null -ne $_ } | ForEach-Object { Protect-VqText (ConvertTo-VqString $_) $KnownSecrets } | Sort-Object { $_ } -CaseSensitive) }
                & $add '' ([ordered]@{ runId = $rid; baselineRunId = ConvertTo-VqString (Get-VqProp $baseline 'baselineRunId'); status = $bs; regressions = @(& $list 'regressions'); fixed = @(& $list 'fixed'); unchanged = [int](Get-VqProp $baseline 'unchanged') })
            }
        }
    }
    # Items sharing a key (duplicate ids) get a deterministic suffix from their canonical content.
    $seen = @{}
    $canonical = @{}
    foreach ($item in $items) { $canonical[$item] = ConvertTo-VqCanonicalJson $item.Body }
    $byContent = [object[]]$items.ToArray()
    [Array]::Sort($byContent, [Comparison[object]] {
        param($a, $b)
        $c = [string]::CompareOrdinal("$($a.Key.r)`0$($a.Key.i)", "$($b.Key.r)`0$($b.Key.i)"); if ($c -ne 0) { return $c }
        [string]::CompareOrdinal($canonical[$a], $canonical[$b])
    })
    foreach ($item in $byContent) {
        $k = "$($item.Key.r)`0$($item.Key.i)"
        if ($seen.ContainsKey($k)) { $seen[$k]++; $item.Key.i = "$($item.Key.i)~$($seen[$k])" } else { $seen[$k] = 0 }
    }
    $arr = [object[]]$items.ToArray()
    $cmp = [Comparison[object]] { param($a, $b) Compare-VqKey $a.Key $b.Key }
    [Array]::Sort($arr, $cmp)
    , $arr
}

function Invoke-VerificationQuery {
    <#
    .SYNOPSIS Runs a read-only, paginated, redacted query over a verification snapshot; returns canonical JSON.
    .PARAMETER Snapshot  Input contract object (see docs/verification-query.md): @{ schemaVersion = 1; runs = @(...) }.
    .PARAMETER Kind      runs | selected | deferred | failures | episodes | artifacts | baseline.
    .PARAMETER Cursor    nextCursor from a previous page of the same query.
    .PARAMETER KnownSecrets  Literal secret values (for example from the environment) to scrub wherever they appear.
    #>
    param(
        [Parameter(Mandatory)]$Snapshot,
        [Parameter(Mandatory)][string]$Kind,
        [string]$RunId = '', [string]$Status = '', [string]$Cursor = '',
        [int]$PageSize = $script:VqDefaults.PageSize,
        [int]$InlineBytes = $script:VqDefaults.InlineBytes, [int]$ExcerptChars = $script:VqDefaults.ExcerptChars,
        [int]$MaxResponseBytes = $script:VqDefaults.MaxResponseBytes,
        [string[]]$KnownSecrets = @()
    )
    if ($Kind -cnotin $script:VqKinds) { return ConvertTo-VqCanonicalJson (New-VqError 'invalid_query' "Kind must be one of: $($script:VqKinds -join ', ').") }
    if ($PageSize -lt 1 -or $PageSize -gt $script:VqDefaults.MaxPageSize) { return ConvertTo-VqCanonicalJson (New-VqError 'invalid_query' "PageSize must be between 1 and $($script:VqDefaults.MaxPageSize).") }
    if ($Snapshot -is [string]) { $Snapshot = Read-VqJson $Snapshot }
    $version = Get-VqProp $Snapshot 'schemaVersion'
    if ($null -eq $version -or [int]$version -ne $script:VqSchemaVersion) { return ConvertTo-VqCanonicalJson (New-VqError 'unsupported_input_version' "Snapshot schemaVersion must be $($script:VqSchemaVersion).") }

    $limits = @{ InlineBytes = $InlineBytes; ExcerptChars = $ExcerptChars }
    $queryHash = Get-VqSha256 (ConvertTo-VqCanonicalJson ([ordered]@{ kind = $Kind; runId = $RunId; status = $Status }))
    $after = $null
    if ($Cursor) {
        $decoded = ConvertFrom-VqCursor $Cursor $queryHash
        if ($decoded.Error) { return ConvertTo-VqCanonicalJson $decoded.Error }
        $after = $decoded.After
    }
    $all = Get-VqItems $Snapshot $Kind $limits $KnownSecrets $RunId $Status
    $remaining = if ($after) { @($all | Where-Object { (Compare-VqKey $_.Key $after) -gt 0 }) } else { @($all) }
    $page = @($remaining | Select-Object -First $PageSize)

    # Total response cap: drop trailing items (never the first) until the page fits.
    $build = {
        param($Items, $HasMore)
        $next = $null
        if ($HasMore -and $Items.Count -gt 0) { $next = ConvertTo-VqCursor $Items[$Items.Count - 1].Key $queryHash }
        [ordered]@{
            schemaVersion = $script:VqSchemaVersion; kind = $Kind
            query = [ordered]@{ runId = $RunId; status = $Status; pageSize = $PageSize }
            items = @($Items | ForEach-Object { $_.Body })
            page = [ordered]@{ returned = $Items.Count; hasMore = [bool]$HasMore; nextCursor = $next }
            limits = [ordered]@{ inlineBytes = $InlineBytes; excerptChars = $ExcerptChars; maxResponseBytes = $MaxResponseBytes }
        }
    }
    $json = ''
    while ($true) {
        $hasMore = $page.Count -lt $remaining.Count
        $json = ConvertTo-VqCanonicalJson (& $build $page $hasMore)
        if ([Text.Encoding]::UTF8.GetByteCount($json) -le $MaxResponseBytes -or $page.Count -le 1) { break }
        $page = @($page | Select-Object -First ($page.Count - 1))
    }
    $json
}
