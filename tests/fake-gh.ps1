# Fake `gh` for route-state tests. State lives in the JSON file named by $env:FAKE_GH_STATE: { labels: [...], comments: [...] }.
$state = Get-Content -Raw $env:FAKE_GH_STATE | ConvertFrom-Json -AsHashtable
$a = @($args)
# Real gh receives plain strings; PowerShell turns unquoted `a,b` into an array, which gh would reject.
foreach ($x in $a) { if ($x -isnot [string] -and $x -isnot [int]) { Write-Error "fake gh: non-string argument ($($x.GetType().Name)) in: $($a -join ' ')"; exit 2 } }
if ($a[0] -eq 'issue' -and $a[1] -eq 'view') {
    @{ labels = @($state.labels | ForEach-Object { @{ name = $_ } }); comments = @($state.comments | ForEach-Object { @{ body = $_ } }) } | ConvertTo-Json -Depth 5 -Compress
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'edit') {
    for ($i = 3; $i -lt $a.Count; $i += 2) {
        $vals = "$($a[$i + 1])" -split ','
        if ($a[$i] -eq '--add-label') { $state.labels = @($state.labels) + $vals }
        if ($a[$i] -eq '--remove-label') { $state.labels = @($state.labels | Where-Object { $vals -notcontains $_ }) }
    }
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'comment') {
    $f = $a[$a.IndexOf('--body-file') + 1]
    $state.comments = @($state.comments) + [IO.File]::ReadAllText($f)
}
elseif ($a[0] -eq 'issue' -and $a[1] -eq 'list') {
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
else { Write-Error "fake gh: unsupported $($a -join ' ')"; exit 2 }
$state | ConvertTo-Json -Depth 5 | Set-Content $env:FAKE_GH_STATE
exit 0
