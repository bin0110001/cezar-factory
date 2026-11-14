#!/usr/bin/env pwsh
<#
.SYNOPSIS
Verification CLI: run, select and compare verification with stable, schema-versioned JSON (#107, parent #57).

.DESCRIPTION
  verification-cli.ps1 run         --profile quick|standard|full [--json]
  verification-cli.ps1 affected    --changed <path>[,<path>...] [--profile <p>] [--json]
  verification-cli.ps1 last-failed [--json]
  verification-cli.ps1 compare     --baseline <runId> [--profile <p>] [--json]
Common: --provider <file.ps1> (or FACTORY_VERIFICATION_PROVIDER). Exit codes: 0 pass, 1 test failures,
2 usage/config error, 3 internal/provider/executor error. With --json stdout carries only the JSON document
(schemas/verification-cli-output.schema.json). All result data is read back through Invoke-VerificationQuery
(bounded, redacted, deterministically ordered); the CLI adds no executor, ledger or selection engine.
Run it from a workflow `command:` step, never from a skill. See docs/verification-cli.md.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'verification-query.ps1')

$script:CliSchemaVersion = 1
$script:Json = $false
$script:Command = ''

function Write-CliResult([System.Collections.IDictionary]$Doc, [int]$Code) {
    if ($script:Json) { Write-Output (ConvertTo-VqCanonicalJson $Doc) }
    elseif ($Doc.Contains('error')) { [Console]::Error.WriteLine("verification-cli: $($Doc.error.code): $($Doc.error.message)") }
    else {
        $s = $Doc.summary
        Write-Output ("{0}: {1} (selected {2}, failed {3}, new {4}, known {5}, fixed {6})" -f $Doc.command, $Doc.status, $s.selected, $s.failed, $s.new, $s.known, $s.fixed)
        foreach ($f in @($Doc.failures)) { Write-Output ("  FAIL {0} [{1}]" -f $f.testId, $f.classification) }
    }
    exit $Code
}

function Exit-CliError([int]$Code, [string]$ErrorCode, [string]$Message) {
    Write-CliResult ([ordered]@{ schemaVersion = $script:CliSchemaVersion; command = $script:Command; exitCode = $Code; error = [ordered]@{ code = $ErrorCode; message = $Message } }) $Code
}

function Read-CliArguments([object[]]$Arguments) {
    $o = @{ Profile = ''; Provider = ''; Baseline = ''; Changed = [System.Collections.Generic.List[string]]::new() }
    $i = 0
    $next = {
        param($name)
        if ($i + 1 -ge $Arguments.Count) { Exit-CliError 2 'usage' "--$name needs a value." }
        $script:i2 = $i + 1; [string]$Arguments[$i + 1]
    }
    while ($i -lt $Arguments.Count) {
        $a = [string]$Arguments[$i]
        $name = ($a -replace '^--?', ''); $inline = $null
        if ($a -notmatch '^--?[A-Za-z]') { Exit-CliError 2 'usage' "Unexpected argument '$a'." }
        if ($name.Contains('=')) { $inline = $name.Substring($name.IndexOf('=') + 1); $name = $name.Substring(0, $name.IndexOf('=')) }
        $value = $null
        $takes = $name -in 'profile', 'provider', 'baseline', 'changed'
        if ($takes) { if ($null -ne $inline) { $value = $inline } else { $value = & $next $name; $i = $script:i2 } }
        switch ($name.ToLowerInvariant()) {
            'json' { $script:Json = $true }
            'profile' { $o.Profile = $value }
            'provider' { $o.Provider = $value }
            'baseline' { $o.Baseline = $value }
            'changed' { foreach ($p in ($value -split ',')) { if ($p.Trim()) { $o.Changed.Add($p.Trim().Replace('\', '/')) } } }
            default { Exit-CliError 2 'usage' "Unknown option '$a'." }
        }
        $i++
    }
    $o
}

function Get-CliPropertyList($Value) { @($Value) | Where-Object { $null -ne $_ } }

function Select-AffectedTests($Catalog, [string[]]$TestIds, [string[]]$Changed) {
    $selected = [System.Collections.Generic.List[object]]::new(); $deferred = [System.Collections.Generic.List[object]]::new()
    foreach ($t in @(Get-CliPropertyList (Get-VqProp $Catalog 'tests'))) {
        $id = [string](Get-VqProp $t 'testId')
        if ($TestIds -and $id -cnotin $TestIds) { continue }
        $hits = [System.Collections.Generic.List[string]]::new()
        foreach ($tp in @(Get-CliPropertyList (Get-VqProp $t 'paths'))) {
            $root = ([string]$tp).Replace('\', '/').TrimEnd('/')
            foreach ($c in $Changed) { if ($c -ceq $root -or $c.StartsWith("$root/", [StringComparison]::Ordinal)) { $hits.Add($c) } }
        }
        if ($hits.Count) { $selected.Add([ordered]@{ testId = $id; reason = 'touches ' + ((@($hits | Sort-Object -Unique -CaseSensitive)) -join ', ') }) }
        else { $deferred.Add([ordered]@{ testId = $id; reason = 'not affected by changed paths' }) }
    }
    @{ Selected = @($selected); Deferred = @($deferred) }
}

function Get-QueryDoc([string]$Kind, $Snapshot, [string]$RunId, [string]$Status = '') {
    $doc = Read-VqJson (Invoke-VerificationQuery -Snapshot $Snapshot -Kind $Kind -RunId $RunId -Status $Status -PageSize 200)
    if ($doc.ContainsKey('error')) { Exit-CliError 3 'query_failed' ([string]$doc.error.message) }
    $doc
}

try {
    if ($args.Count -eq 0 -or [string]$args[0] -in '-h', '--help', 'help') {
        Write-Output 'usage: verification-cli.ps1 run|affected|last-failed|compare [--profile quick|standard|full] [--changed paths] [--baseline runId] [--provider file.ps1] [--json]'
        exit $(if ($args.Count -eq 0) { 2 } else { 0 })
    }
    $script:Command = [string]$args[0]
    $script:Json = [bool]($args | Where-Object { [string]$_ -in '--json', '-json', '-Json' })
    if ($script:Command -cnotin 'run', 'affected', 'last-failed', 'compare') { Exit-CliError 2 'usage' "Unknown command '$($script:Command)'." }
    $opt = Read-CliArguments @($args | Select-Object -Skip 1)

    $providerPath = if ($opt.Provider) { $opt.Provider } else { [string]$env:FACTORY_VERIFICATION_PROVIDER }
    if (-not $providerPath) { Exit-CliError 3 'provider_unavailable' 'No verification provider: pass --provider <file.ps1> or set FACTORY_VERIFICATION_PROVIDER.' }
    if (-not (Test-Path -LiteralPath $providerPath -PathType Leaf)) { Exit-CliError 2 'config' "Provider file not found: $providerPath" }
    . (Resolve-Path -LiteralPath $providerPath).Path
    foreach ($fn in 'Get-VerificationCatalog', 'Get-VerificationHistory', 'Invoke-VerificationTests') {
        if (-not (Get-Command $fn -CommandType Function -ErrorAction SilentlyContinue)) { Exit-CliError 3 'provider_unavailable' "Provider does not define $fn." }
    }
    $catalog = Get-VerificationCatalog
    $history = Get-VerificationHistory
    if ($null -eq $history) { $history = @{ schemaVersion = 1; runs = @() } }
    $profiles = Get-VqProp $catalog 'profiles'
    if (-not $profiles) { Exit-CliError 2 'config' 'Verification catalog defines no profiles.' }
    $knownIds = @(Get-CliPropertyList (Get-VqProp $catalog 'tests') | ForEach-Object { [string](Get-VqProp $_ 'testId') })

    $profile = $opt.Profile
    if ($script:Command -in 'run') { if (-not $profile) { Exit-CliError 2 'usage' 'run needs --profile quick|standard|full.' } }
    if ($script:Command -eq 'compare' -and -not $profile) { $profile = 'standard' }
    if ($profile -and $profile -cnotin 'quick', 'standard', 'full') { Exit-CliError 2 'usage' "Unknown profile '$profile'; use quick, standard or full." }
    $profileIds = $null
    if ($profile) {
        $profileIds = [string[]]@(Get-CliPropertyList (Get-VqProp $profiles $profile) | ForEach-Object { [string]$_ })
        if ($null -eq (Get-VqProp $profiles $profile)) { Exit-CliError 2 'config' "Catalog has no profile '$profile'." }
    }

    # ---- selection ----------------------------------------------------------------------------
    $selected = @(); $deferred = @(); $source = ''; $changed = @()
    switch ($script:Command) {
        { $_ -in 'run', 'compare' } {
            $source = "profile:$profile"
            $selected = @($profileIds | Sort-Object -Unique -CaseSensitive | ForEach-Object { [ordered]@{ testId = $_; reason = "member of profile $profile" } })
            $deferred = @($knownIds | Where-Object { $_ -cnotin $profileIds } | Sort-Object -Unique -CaseSensitive | ForEach-Object { [ordered]@{ testId = $_; reason = "not in profile $profile" } })
        }
        'affected' {
            $changed = @($opt.Changed | Sort-Object -Unique -CaseSensitive)
            if (-not $changed.Count -and (Get-Command Get-VerificationChangedPaths -CommandType Function -ErrorAction SilentlyContinue)) {
                $changed = @(Get-VerificationChangedPaths | ForEach-Object { ([string]$_).Replace('\', '/') } | Sort-Object -Unique -CaseSensitive)
            }
            if (-not $changed.Count) { Exit-CliError 2 'usage' 'affected needs --changed <paths> (or a provider Get-VerificationChangedPaths).' }
            $source = if ($profile) { "affected-within:$profile" } else { 'affected' }
            $r = Select-AffectedTests $catalog $profileIds $changed
            $selected = $r.Selected; $deferred = $r.Deferred
        }
        'last-failed' {
            $latest = (Get-QueryDoc 'runs' $history '' 'failed').items | Select-Object -First 1
            if ($latest) {
                $source = "last-failed:$($latest.id)"
                $ids = @((Get-QueryDoc 'failures' $history ([string]$latest.id)).items | ForEach-Object { [string]$_.testId } | Sort-Object -Unique -CaseSensitive)
                $selected = @($ids | ForEach-Object { [ordered]@{ testId = $_; reason = "failed in run $($latest.id)" } })
                $deferred = @($knownIds | Where-Object { $_ -cnotin $ids } | Sort-Object -Unique -CaseSensitive | ForEach-Object { [ordered]@{ testId = $_; reason = "did not fail in run $($latest.id)" } })
            } else { $source = 'last-failed:none'; $deferred = @($knownIds | Sort-Object -Unique -CaseSensitive | ForEach-Object { [ordered]@{ testId = $_; reason = 'no failed run recorded' } }) }
        }
    }
    foreach ($s in $selected) { if ($knownIds -and $s.testId -cnotin $knownIds) { Exit-CliError 2 'config' "Selected test '$($s.testId)' is not in the catalog." } }

    # ---- history: which tests are already known to fail ----------------------------------------
    $baselineId = $opt.Baseline
    if ($script:Command -eq 'compare' -and -not $baselineId) { Exit-CliError 2 'usage' 'compare needs --baseline <runId>.' }
    $runIds = @((Get-QueryDoc 'runs' $history '').items | ForEach-Object { [string]$_.id })
    if ($baselineId -and $baselineId -cnotin $runIds) { Exit-CliError 2 'config' "Baseline run '$baselineId' is not in the verification history." }
    $knownFailing = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($rid in $(if ($baselineId) { @($baselineId) } else { $runIds })) {
        foreach ($f in (Get-QueryDoc 'failures' $history $rid).items) { [void]$knownFailing.Add([string]$f.testId) }
    }

    # ---- execute -------------------------------------------------------------------------------
    $ids = [string[]]@($selected | ForEach-Object { $_.testId })
    $results = @()
    if ($ids.Count) {
        try { $results = @(Invoke-VerificationTests -TestIds $ids) } catch { Exit-CliError 3 'executor_failed' "Executor failed: $($_.Exception.Message)" }
    }
    $byId = @{}; foreach ($r in $results) { $byId[[string](Get-VqProp $r 'testId')] = $r }
    $failures = @(); $checks = @(); $infra = $false; $newIds = @(); $knownIdsHit = @(); $fixed = @(); $passed = 0
    foreach ($id in $ids) {
        $r = $byId[$id]
        $st = if ($r) { [string](Get-VqProp $r 'status') } else { 'infrastructure-error' }
        $checks += [ordered]@{ checkId = $id; status = $st }
        if ($st -eq 'passed') { $passed++; if ($baselineId -and $knownFailing.Contains($id)) { $fixed += $id }; continue }
        if ($st -eq 'infrastructure-error') { $infra = $true }
        $cls = if ($knownFailing.Contains($id)) { 'known' } else { 'new' }
        if ($cls -eq 'known') { $knownIdsHit += $id } else { $newIds += $id }
        $failure = [ordered]@{ id = "$id#1"; testId = $id; status = $st; classification = $cls
            message = $(if ($r) { [string](Get-VqProp $r 'message') } else { 'executor returned no result for this test' }); output = $(if ($r) { [string](Get-VqProp $r 'output') } else { '' }) }
        $fp = if ($r) { Get-VqProp $r 'fingerprint' } else { $null }
        if ($fp) { $failure.episodeId = [string]$fp }
        $failures += $failure
    }
    $newIds = @($newIds | Sort-Object -Unique -CaseSensitive); $knownIdsHit = @($knownIdsHit | Sort-Object -Unique -CaseSensitive); $fixed = @($fixed | Sort-Object -Unique -CaseSensitive)
    $runStatus = if ($infra) { 'infrastructure-error' } elseif ($failures.Count) { 'failed' } else { 'passed' }
    $runId = 'cli-' + (Get-VqSha256 (ConvertTo-VqCanonicalJson ([ordered]@{ c = $script:Command; p = $profile; s = $source; ids = $ids; b = $baselineId }))).Substring(0, 12)
    $record = [ordered]@{
        id = $runId; startedAt = ''; finishedAt = ''; status = $runStatus; suite = $source
        selected = $selected; deferred = $deferred; failures = $failures; checks = $checks
    }
    if ($baselineId) {
        $record.baseline = [ordered]@{ baselineRunId = $baselineId; status = $(if ($newIds.Count) { 'regressed' } else { 'unchanged' }); regressions = $newIds; fixed = $fixed; unchanged = $knownIdsHit.Count }
    }
    $snapshot = [ordered]@{ schemaVersion = 1; runs = @($record) }

    # ---- build output through the query layer --------------------------------------------------
    $qRun = (Get-QueryDoc 'runs' $snapshot $runId).items[0]
    $qSel = Get-QueryDoc 'selected' $snapshot $runId
    $qDef = Get-QueryDoc 'deferred' $snapshot $runId
    $qFail = Get-QueryDoc 'failures' $snapshot $runId
    $comparison = $null
    if ($baselineId) { $b = (Get-QueryDoc 'baseline' $snapshot $runId).items[0]; $comparison = [ordered]@{ baselineRunId = $b.baselineRunId; status = $b.status; new = $b.regressions; known = $knownIdsHit; fixed = $b.fixed } }
    $exit = if ($infra) { 3 } elseif ($failures.Count) { 1 } else { 0 }
    $doc = [ordered]@{
        schemaVersion = $script:CliSchemaVersion; command = $script:Command; profile = $(if ($profile) { $profile } else { $null })
        status = $runStatus; exitCode = $exit
        summary = [ordered]@{ selected = $ids.Count; passed = $passed; failed = $failures.Count; new = $newIds.Count; known = $knownIdsHit.Count; fixed = $fixed.Count }
        selection = [ordered]@{
            mode = $script:Command; source = $source; changedPaths = $changed
            selected = @($qSel.items | ForEach-Object { [ordered]@{ testId = $_.testId; reason = $_.reason } })
            deferred = @($qDef.items | ForEach-Object { [ordered]@{ testId = $_.testId; reason = $_.reason } })
            truncated = [bool]($qSel.page.hasMore -or $qDef.page.hasMore)
        }
        failures = @($qFail.items); failuresTruncated = [bool]$qFail.page.hasMore
        comparison = $comparison
        run = [ordered]@{ id = $qRun.id; status = $qRun.status; suite = $qRun.suite; counts = $qRun.counts; checks = @($qRun.checks | ForEach-Object { [ordered]@{ checkId = $_.checkId; status = $_.status } }) }
    }
    Write-CliResult $doc $exit
} catch {
    Exit-CliError 3 'internal_error' $_.Exception.Message
}
