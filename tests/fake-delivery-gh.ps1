# Fake `gh` for close-merged-issues tests. State is the JSON file named by $env:FAKE_CLOSE_STATE:
# { prs: [...], issues: { "<n>": { state, labels: [...], comments: [...] } }, calls: [...] }
$state = Get-Content -Raw $env:FAKE_CLOSE_STATE | ConvertFrom-Json -AsHashtable
$a = @($args)
$state['calls'] = @($state.ContainsKey('calls') ? $state['calls'] : @()) + , ($a -join ' ')
if ($a[0] -eq 'pr' -and $a[1] -eq 'list') { $list = if ($a -contains 'open') { @($state.openPrs) } else { @($state.prs) }; ConvertTo-Json -InputObject @($list) -Depth 6 -Compress }
elseif ($a[0] -eq 'label' -and $a[1] -eq 'list') { ConvertTo-Json -InputObject @(@($state.ContainsKey('existingLabels') ? $state['existingLabels'] : @()) | ForEach-Object { @{ name = $_ } }) -Depth 4 -Compress }
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'list') {
    $open = @($state.issues.Keys | Where-Object { $state.issues[$_].state -eq 'OPEN' } | Sort-Object { [int]$_ } | ForEach-Object { @{ number = [int]$_; title = 't'; createdAt = '2026-01-01T00:00:00Z'; updatedAt = '2026-01-01T00:00:00Z'; url = "https://example/issues/$_"; labels = @($state.issues[$_].labels | ForEach-Object { @{ name = $_ } }) } })
    ConvertTo-Json -InputObject @($open) -Depth 6 -Compress
}
elseif ($a[0] -eq 'label' -and $a[1] -eq 'create') { $state['labelsEnsured'] = @($state.ContainsKey('labelsEnsured') ? $state['labelsEnsured'] : @()) + $a[2] }
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'view') {
    $issue = $state.issues[[string]$a[2]]
    if (-not $issue) { Write-Error "fake gh: no issue $($a[2])"; exit 1 }
    @{ state = $issue.state; labels = @($issue.labels | ForEach-Object { @{ name = $_ } }); comments = @($issue.comments | ForEach-Object { @{ body = $_ } }); title = 't' } | ConvertTo-Json -Depth 5 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'edit') {
    $issue = $state.issues[[string]$a[2]]
    for ($i = 3; $i -lt $a.Count; $i += 2) {
        $vals = "$($a[$i + 1])" -split ','
        if ($a[$i] -eq '--add-label') { $issue.labels = @($issue.labels) + $vals }
        if ($a[$i] -eq '--remove-label') { $issue.labels = @($issue.labels | Where-Object { $vals -notcontains $_ }) }
    }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'close') {
    $issue = $state.issues[[string]$a[2]]
    if ($state.failClose -contains [int]$a[2]) { Write-Error 'fake gh: close failed'; exit 1 }
    $issue.state = 'CLOSED'; $issue.comments = @($issue.comments) + $a[$a.IndexOf('--comment') + 1]
}
else { Write-Error "fake gh: unsupported $($a -join ' ')"; exit 2 }
$state | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_CLOSE_STATE
exit 0
