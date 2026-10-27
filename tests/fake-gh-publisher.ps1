$ErrorActionPreference = 'Stop'
$statePath = $env:FAKE_GH_PUBLISHER_STATE
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable
$a = @($args)
$repo = 'bin0110001/cezar-factory'
if ($a -contains '--repo') { $repo = [string]$a[$a.IndexOf('--repo') + 1] }
function Save-State { $script:state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $script:statePath }

if ($a[0] -eq 'api' -and $a[1] -eq 'search/issues') {
    $state.searchCalls = [int]$state.searchCalls + 1
    Save-State
    if ($state.failSearch) { Write-Error 'fake search failure'; exit 2 }
    $qArgument = @($a | Where-Object { $_ -like 'q=*' } | Select-Object -First 1)
    $q = if ($qArgument.Count) { [string]$qArgument[0] } else { 'q=' }
    $query = $q.Substring(2)
    $phrases = @([regex]::Matches($query, '"([^"]+)"|([^\s]+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    } | Where-Object { $_ -notmatch '^repo:' -and $_ -notin @('is:issue','in:title','in:body','in:comments') })
    $items = @($state.issues | Where-Object {
        if ($query -match 'in:title') { $text = [string]$_.title }
        elseif ($query -match 'in:comments') { $text = @($_.comments | ForEach-Object { [string]$_.body }) -join "`n" }
        elseif ($query -match 'in:body') { $text = [string]$_.body }
        else { $text = ([string]$_.title + "`n" + [string]$_.body + "`n" + (@($_.comments | ForEach-Object { [string]$_.body }) -join "`n")) }
        $matchesQuery = $phrases.Count -gt 0
        foreach ($phrase in $phrases) { if ($text -notmatch [regex]::Escape($phrase)) { $matchesQuery = $false; break } }
        if ($matchesQuery) { $_ }
    })
    @{ total_count = $items.Count; items = @($items | ForEach-Object { @{ number = $_.number; title = $_.title; body = $_.body; html_url = $_.url; url = $_.url } }) } | ConvertTo-Json -Depth 20 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'view') {
    if ($state.failView) { Write-Error 'fake issue view failure'; exit 2 }
    $issue = @($state.issues | Where-Object { [int]$_.number -eq [int]$a[2] }) | Select-Object -First 1
    if (-not $issue) { Write-Error 'issue missing'; exit 1 }
    @{ number = [int]$issue.number; title = [string]$issue.title; body = [string]$issue.body; state = [string]$issue.state; comments = @($issue.comments); url = [string]$issue.url; labels = @($issue.labels) } | ConvertTo-Json -Depth 20 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'create') {
    $state.createCalls = [int]$state.createCalls + 1
    $pending = Get-Content -LiteralPath $env:FAKE_GH_PUBLISHER_RECEIPT -Raw | ConvertFrom-Json
    $state.receiptPendingBeforeWrite = $pending.status -eq 'pending'
    Save-State
    if ($state.failCreate) { Write-Error 'fake create failure'; exit 2 }
    $title = [string]$a[$a.IndexOf('--title') + 1]
    $body = Get-Content -LiteralPath $a[$a.IndexOf('--body-file') + 1] -Raw
    $labels = [System.Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $a.Count; $i++) { if ($a[$i] -eq '--label' -and $i + 1 -lt $a.Count) { $labels.Add(@{ name = [string]$a[$i + 1] }) } }
    $number = 100 + @($state.issues).Count
    $issue = @{ number = $number; title = $title; body = $body; state = 'OPEN'; comments = @(); labels = @($labels); url = "https://github.com/$repo/issues/$number" }
    $state.issues = @($state.issues) + $issue
    Save-State
    if ($state.failCreateAfter) { Write-Error 'fake ambiguous create response'; exit 2 }
    $issue.url
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'comment') {
    $state.commentCalls = [int]$state.commentCalls + 1
    $issue = @($state.issues | Where-Object { [int]$_.number -eq [int]$a[2] }) | Select-Object -First 1
    if (-not $issue) { Write-Error 'issue missing'; exit 1 }
    $body = Get-Content -LiteralPath $a[$a.IndexOf('--body-file') + 1] -Raw
    $issue.comments = @($issue.comments) + @{ body = $body }
    Save-State
    if ($state.failCommentAfter) { Write-Error 'fake ambiguous comment response'; exit 2 }
    "https://github.com/$repo/issues/$($issue.number)#issuecomment-fake"
}
else { Write-Error "fake gh: unsupported $($a -join ' ')"; exit 2 }
exit 0
