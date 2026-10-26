# Fake `gh` for route-state tests. State lives in the JSON file named by $env:FAKE_GH_STATE: { labels: [...], comments: [...] }.
$state = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable
$a = @($args)
# Real gh receives plain strings; PowerShell turns unquoted `a,b` into an array, which gh would reject.
foreach ($x in $a) { if ($x -isnot [string] -and $x -isnot [int]) { Write-Error "fake gh: non-string argument ($($x.GetType().Name)) in: $($a -join ' ')"; exit 2 } }
if ($a[0] -eq 'issue' -and $a[1] -eq 'view') {
    $issue = @($state.issues | Where-Object { $_.number -eq [int]$a[2] }) | Select-Object -First 1
    if ($issue -and -not $issue.updatedAt) { $issue.updatedAt = '2026-10-25T00:00:00.0000000Z' }
    $labels = if ($issue) { @($issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } }) } else { @($state.labels) }
    @{ number = [int]$issue.number; state = $(if ($state.issueState) { [string]$state.issueState } else { 'OPEN' }); body = [string]$issue.body; updatedAt = if ($issue) { [string]$issue.updatedAt } else { [string]$state.updatedAt }; labels = @($labels | ForEach-Object { @{ name = $_ } }); comments = @($state.comments | ForEach-Object { @{ body = $_ } }) } | ConvertTo-Json -Depth 5 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'edit') {
    $issue = @($state.issues | Where-Object { $_.number -eq [int]$a[2] }) | Select-Object -First 1
    if ($issue) { $issueLabels = @($issue.labels | ForEach-Object { if ($_ -is [string]) { [string]$_ } else { [string]$_.name } }) } else { $issueLabels = @($state.labels) }
    for ($i = 3; $i -lt $a.Count; $i += 2) {
        $vals = "$($a[$i + 1])" -split ','
        if ($a[$i] -eq '--add-label') { $issueLabels = @($issueLabels) + $vals; $state.labels = @($state.labels) + $vals }
        if ($a[$i] -eq '--remove-label') { $issueLabels = @($issueLabels | Where-Object { $vals -notcontains $_ }); $state.labels = @($state.labels | Where-Object { $vals -notcontains $_ }) }
    }
    if ($issue) { $issue.labels = @($issueLabels | Sort-Object -Unique) }
    if ($issue) { $issue.updatedAt = [DateTime]::UtcNow.ToString('o') }
    else { $state.updatedAt = [DateTime]::UtcNow.ToString('o') }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'comment') {
    $f = $a[$a.IndexOf('--body-file') + 1]
    $state.comments = @($state.comments) + [IO.File]::ReadAllText($f)
    $issue = @($state.issues | Where-Object { $_.number -eq [int]$a[2] }) | Select-Object -First 1
    if ($issue) { $issue.updatedAt = [DateTime]::UtcNow.ToString('o') }
    else { $state.updatedAt = [DateTime]::UtcNow.ToString('o') }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'close') { $state.issueState = 'CLOSED'; $state.issueCloseRequested = $true }
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'list') {
    foreach ($issue in @($state.issues | Where-Object { $_ })) { if (-not $issue.updatedAt) { $issue.updatedAt = '2026-10-25T00:00:00.0000000Z' } }
    @($state.issues | Where-Object { $_ }) | ConvertTo-Json -Depth 5 -Compress -AsArray
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'create') {
    $n = 100 + @($state.issues | Where-Object { $_ }).Count
    $body = [IO.File]::ReadAllText($a[$a.IndexOf('--body-file') + 1])
    $state.issues = @($state.issues | Where-Object { $_ }) + @{ number = $n; title = $a[$a.IndexOf('--title') + 1]; body = $body; labels = $a[$a.IndexOf('--label') + 1] }
    "https://github.com/x/y/issues/$n"
}
elseif ($a[0] -eq 'label' -and $a[1] -eq 'create') { $state.created = @($state.created) + $a[2] }
elseif ($a[0] -eq 'pr' -and $a[1] -eq 'merge') { $state.prMerged = $true }
elseif ($a[0] -eq 'pr' -and $a[1] -eq 'view') {
    $pr = @($state.prs | Where-Object { $_.url -eq [string]$a[2] -or $_.number -eq [int]$a[2] }) | Select-Object -First 1
    @{ body = [string]$pr.body } | ConvertTo-Json -Depth 5 -Compress
}
elseif ($a[0] -eq 'pr' -and $a[1] -eq 'edit') {
    $pr = @($state.prs | Where-Object { $_.url -eq [string]$a[2] -or $_.number -eq [int]$a[2] }) | Select-Object -First 1
    $body = [IO.File]::ReadAllText($a[$a.IndexOf('--body-file') + 1])
    $pr.body = $body
    $state.prs = @($state.prs)
}
else { Write-Error "fake gh: unsupported $($a -join ' ')"; exit 2 }
$state | ConvertTo-Json -Depth 5 | Set-Content $env:FAKE_GH_STATE
exit 0
