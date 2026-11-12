# Fake `gh` for delivery-sync, stale-refresh and lifecycle-sweep tests. State is the JSON file named by
# $env:FAKE_CLOSE_STATE:
# { prs: [...], openPrs: [...], issues: { "<n>": { state, labels: [...], comments: [...], title?, body?,
#   createdAt?, updatedAt? } }, calls: [...] }
# Callers run under strict mode, so optional keys are read with ['key'], never with .key.
$state = Get-Content -Raw $env:FAKE_CLOSE_STATE | ConvertFrom-Json -AsHashtable
$a = @($args)
$state['calls'] = @($state.ContainsKey('calls') ? $state['calls'] : @()) + , ($a -join ' ')
function Get-Option([string]$Name) { $i = [array]::IndexOf($a, $Name); if ($i -ge 0 -and $i + 1 -lt $a.Count) { $a[$i + 1] } else { $null } }
if ($a[0] -eq 'pr' -and $a[1] -eq 'list') { $list = if ($a -contains 'open') { @($state.openPrs) } else { @($state.prs) }; ConvertTo-Json -InputObject @($list) -Depth 6 -Compress }
elseif ($a[0] -eq 'label' -and $a[1] -eq 'list') { ConvertTo-Json -InputObject @(@($state.ContainsKey('existingLabels') ? $state['existingLabels'] : @()) | ForEach-Object { @{ name = $_ } }) -Depth 4 -Compress }
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'list') {
    $open = @($state.issues.Keys | Where-Object { $state.issues[$_].state -eq 'OPEN' } | Sort-Object { [int]$_ } | ForEach-Object { @{ number = [int]$_; title = ($state.issues[$_]['title'] ?? 't'); createdAt = ($state.issues[$_]['createdAt'] ?? '2026-01-01T00:00:00Z'); updatedAt = ($state.issues[$_]['updatedAt'] ?? '2026-01-01T00:00:00Z'); url = "https://example/issues/$_"; labels = @($state.issues[$_].labels | ForEach-Object { @{ name = $_ } }) } })
    ConvertTo-Json -InputObject @($open) -Depth 6 -Compress
}
elseif ($a[0] -eq 'label' -and $a[1] -eq 'create') { $state['labelsEnsured'] = @($state.ContainsKey('labelsEnsured') ? $state['labelsEnsured'] : @()) + $a[2] }
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'view') {
    $issue = $state.issues[[string]$a[2]]
    if (-not $issue) { Write-Error "fake gh: no issue $($a[2])"; exit 1 }
    @{ state = $issue.state; labels = @($issue.labels | ForEach-Object { @{ name = $_ } }); comments = @($issue.comments | ForEach-Object { @{ body = $_ } }); title = ($issue['title'] ?? 't'); body = ($issue['body'] ?? '') } | ConvertTo-Json -Depth 5 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'edit') {
    $issue = $state.issues[[string]$a[2]]
    for ($i = 3; $i -lt $a.Count; $i += 2) {
        $vals = "$($a[$i + 1])" -split ','
        if ($a[$i] -eq '--add-label') { $issue.labels = @($issue.labels) + $vals }
        if ($a[$i] -eq '--remove-label') { $issue.labels = @($issue.labels | Where-Object { $vals -notcontains $_ }) }
        if ($a[$i] -eq '--body-file') { $issue['body'] = Get-Content -Raw -LiteralPath $a[$i + 1] }
    }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'comment') {
    $issue = $state.issues[[string]$a[2]]
    if (-not $issue) { Write-Error "fake gh: no issue $($a[2])"; exit 1 }
    $issue.comments = @($issue.comments) + (Get-Option '--body')
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'create') {
    $next = [string]((@($state.issues.Keys | ForEach-Object { [int]$_ }) | Measure-Object -Maximum).Maximum + 1)
    $labels = @(); for ($i = 2; $i -lt $a.Count - 1; $i++) { if ($a[$i] -eq '--label') { $labels += $a[$i + 1] } }
    $bodyFile = Get-Option '--body-file'
    $state.issues[$next] = @{ state = 'OPEN'; labels = $labels; comments = @(); title = (Get-Option '--title'); body = if ($bodyFile) { Get-Content -Raw -LiteralPath $bodyFile } else { (Get-Option '--body') } }
    "https://example/issues/$next"
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'close') {
    $issue = $state.issues[[string]$a[2]]
    if ($state.failClose -contains [int]$a[2]) { Write-Error 'fake gh: close failed'; exit 1 }
    $issue.state = 'CLOSED'; $issue.comments = @($issue.comments) + $a[$a.IndexOf('--comment') + 1]
}
else { Write-Error "fake gh: unsupported $($a -join ' ')"; exit 2 }
$state | ConvertTo-Json -Depth 8 | Set-Content $env:FAKE_CLOSE_STATE
exit 0
