# Fake `gh` for route-state tests. State lives in the JSON file named by $env:FAKE_GH_STATE: { labels: [...], comments: [...] }.
$state = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable -DateKind String
$a = @($args)
# Real gh receives plain strings; PowerShell turns unquoted `a,b` into an array, which gh would reject.
foreach ($x in $a) { if ($x -isnot [string] -and $x -isnot [int]) { Write-Error "fake gh: non-string argument ($($x.GetType().Name)) in: $($a -join ' ')"; exit 2 } }
if ($a[0] -eq 'issue' -and $a[1] -eq 'view') {
    $issue = @($state.issues | Where-Object { $_.number -eq [int]$a[2] }) | Select-Object -First 1
    if ($issue -and -not $issue.updatedAt) { $issue.updatedAt = '2026-10-25T00:00:00.0000000Z' }
    $labels = if ($issue) { @($issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } }) } else { @($state.labels) }
    $body = if ($issue -and $issue.ContainsKey('body')) { [string]$issue.body } else { '' }
    @{ number = [int]$issue.number; state = $(if ($state.issueState) { [string]$state.issueState } else { 'OPEN' }); body = $body; updatedAt = if ($issue) { [string]$issue.updatedAt } else { [string]$state.updatedAt }; labels = @($labels | ForEach-Object { @{ name = $_ } }); comments = @($state.comments | ForEach-Object { @{ body = $_ } }) } | ConvertTo-Json -Depth 5 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'edit') {
    $issue = @($state.issues | Where-Object { $_.number -eq [int]$a[2] }) | Select-Object -First 1
    if ($issue) { $issueLabels = @($issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } }) } else { $issueLabels = @($state.labels) }
    for ($i = 3; $i -lt $a.Count; $i += 2) {
        $vals = "$($a[$i + 1])" -split ','
        if ($a[$i] -eq '--add-label') { $issueLabels = @($issueLabels) + $vals; $state.labels = @($state.labels) + $vals }
        if ($a[$i] -eq '--remove-label') { $issueLabels = @($issueLabels | Where-Object { $vals -notcontains $_ }); $state.labels = @($state.labels | Where-Object { $vals -notcontains $_ }) }
    }
    if ($state.ContainsKey('trackIssueEditCount') -and $state.trackIssueEditCount) {
        $state.issueEditCount = [int]$state.issueEditCount + 1
    }
    if ($issue) { $issue.labels = @($issueLabels | Sort-Object -Unique) }
    if ($issue) { $issue.updatedAt = [DateTime]::UtcNow.ToString('o') }
    else { $state.updatedAt = [DateTime]::UtcNow.ToString('o') }
    if (($state.ContainsKey('failNextEditAfterWrite') -and $state.failNextEditAfterWrite) -or
        ($state.ContainsKey('failAfterIssueEditNumber') -and [int]$state.failAfterIssueEditNumber -eq [int]$state.issueEditCount)) {
        $state.failNextEditAfterWrite = $false
        $state.failAfterIssueEditNumber = 0
        $state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
        exit 1
    }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'comment') {
    $body = if ($a -contains '--body-file') { [IO.File]::ReadAllText($a[$a.IndexOf('--body-file') + 1]) } else { [string]$a[$a.IndexOf('--body') + 1] }
    $issue = @($state.issues | Where-Object { $_.number -eq [int]$a[2] }) | Select-Object -First 1
    $state.lastCommentExpectedRevision = if ($issue) { [string]$issue.updatedAt } else { [string]$state.updatedAt }
    $state.comments = @($state.comments) + $body
    if ($issue) { $issue.updatedAt = [DateTime]::UtcNow.ToString('o') }
    else { $state.updatedAt = [DateTime]::UtcNow.ToString('o') }
    if ($state.ContainsKey('failNextCommentAfterWrite') -and $state.failNextCommentAfterWrite) {
        $state.failNextCommentAfterWrite = $false
        $state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
        exit 1
    }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'close') {
    $state.issueCloseRequested = $true
    $state.issueState = 'CLOSED'
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'list') {
    foreach ($issue in @($state.issues | Where-Object { $_ })) { if (-not $issue.updatedAt) { $issue.updatedAt = '2026-10-25T00:00:00.0000000Z' } }
    $listedIssues = @($state.issues | Where-Object { $_ })
    $listJson = $listedIssues | ConvertTo-Json -Depth 5 -Compress -AsArray
    if ($state.ContainsKey('changeIssueAfterList') -and $state.changeIssueAfterList) {
        $changedIssue = @($state.issues | Where-Object { $_.number -eq [int]$state.changeIssueAfterList }) | Select-Object -First 1
        if ($changedIssue) { $changedIssue.updatedAt = '2026-10-26T00:00:00.0000000Z' }
    }
    $listJson
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'create') {
    if ($state.ContainsKey('failNextIssueCreateBeforeWrite') -and $state.failNextIssueCreateBeforeWrite) {
        $state.failNextIssueCreateBeforeWrite = $false
        $state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
        exit 1
    }
    $n = 100 + @($state.issues | Where-Object { $_ }).Count
    $body = if ($a -contains '--body-file') { [IO.File]::ReadAllText($a[$a.IndexOf('--body-file') + 1]) } else { [string]$a[$a.IndexOf('--body') + 1] }
    $state.issues = @($state.issues | Where-Object { $_ }) + @{ number = $n; title = $a[$a.IndexOf('--title') + 1]; body = $body; labels = $a[$a.IndexOf('--label') + 1]; url = "https://github.com/x/y/issues/$n"; updatedAt = [DateTime]::UtcNow.ToString('o') }
    if ($state.ContainsKey('changeParentRevisionAfterIssueCreate') -and $state.changeParentRevisionAfterIssueCreate) { $state.updatedAt = '2026-10-26T00:00:00.0000000Z' }
    if ($state.ContainsKey('failNextIssueCreateAfterWrite') -and $state.failNextIssueCreateAfterWrite) {
        $state.failNextIssueCreateAfterWrite = $false
        $state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
        exit 1
    }
    "https://github.com/x/y/issues/$n"
}
elseif ($a[0] -eq 'label' -and $a[1] -eq 'create') { $state.created = @($state.created) + $a[2] }
elseif ($a[0] -eq 'pr' -and $a[1] -eq 'merge') { $state.prMerged = $true; $state.prMergeArgs = @($a) }
elseif ($a[0] -eq 'pr' -and $a[1] -eq 'view') {
    $pr = @($state.prs | Where-Object { [string]$_.url -eq [string]$a[2] -or [string]$_.number -eq [string]$a[2] }) | Select-Object -First 1
    if ($state.prDetails) { $pr = $state.prDetails }
    if (-not $pr) { $pr = @{} }
    $pr.state = if ($state.prMerged) { 'MERGED' } else { $(if ($pr.state) { $pr.state } else { 'OPEN' }) }
    $pr.headRefOid = if ($state.prHeadSha) { $state.prHeadSha } else { $pr.headRefOid }
    $pr.updatedAt = if ($pr.updatedAt) { $pr.updatedAt } else { '2026-10-25T00:00:00.0000000Z' }
    $pr | ConvertTo-Json -Depth 8 -Compress
}
elseif ($a[0] -eq 'pr' -and $a[1] -eq 'edit') {
    $pr = @($state.prs | Where-Object { $_.url -eq [string]$a[2] -or $_.number -eq [int]$a[2] }) | Select-Object -First 1
    if ($state.ContainsKey('failNextPrEditBeforeWrite') -and $state.failNextPrEditBeforeWrite) {
        $state.failNextPrEditBeforeWrite = $false
        $state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
        exit 1
    }
    $body = [IO.File]::ReadAllText($a[$a.IndexOf('--body-file') + 1])
    $pr.body = $body
    $pr.updatedAt = '2026-10-26T00:00:00.0000000Z'
    $state.prs = @($state.prs)
    if ($state.ContainsKey('failNextPrEditAfterWrite') -and $state.failNextPrEditAfterWrite) {
        $state.failNextPrEditAfterWrite = $false
        $state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
        exit 1
    }
}
elseif ($a[0] -eq 'api' -and $a[1] -eq 'repos/example/project') { $state.repoSettings | ConvertTo-Json -Depth 8 -Compress }
elseif ($a[0] -eq 'api' -and $a[1] -eq 'repos/example/project/rules/branches/dev') { @($state.rules) | ConvertTo-Json -Depth 8 -Compress -AsArray }
elseif ($a[0] -eq 'api' -and $a[1] -eq 'graphql') { $state.graphql | ConvertTo-Json -Depth 8 -Compress }
else { Write-Error "fake gh: unsupported $($a -join ' ')"; exit 2 }
$state | ConvertTo-Json -Depth 12 | Set-Content $env:FAKE_GH_STATE
exit 0
